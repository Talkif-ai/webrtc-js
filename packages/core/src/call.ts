import { DataChannel } from './data-channel.js';
import { Emitter } from './emitter.js';
import { CallEventsClient } from './events.js';
import { asSignalingCallError, SignalingClient } from './signaling.js';
import type {
	AppMessage,
	CallEndReason,
	CallEventEnvelope,
	CallState,
	IceServer,
	SignallingPayload,
	StartCallOptions,
	TalkifCallEventMap,
	TalkifConfig,
} from './types.js';
import { TalkifCallError, TERMINAL_CALL_STATUSES } from './types.js';

// If no external health confirmation (SSE/app message) arrives within this
// window after media connects, verify call health against the backend over
// REST before tearing down. Silence alone is NOT proof of pipeline death.
const PIPELINE_HEALTH_TIMEOUT_MS = 15_000;

// Safety net for ICE gathering: send whatever we have if no relay candidate
// shows up. With iceTransportPolicy 'relay' the first relay(udp) candidate is
// all the bot needs; TURN tcp/443 allocations routinely never complete, so
// waiting for iceGatheringState === 'complete' would stall every call.
const ICE_FIRST_RELAY_TIMEOUT_MS = 1_500;

/**
 * One WebRTC voice session with a Talkif agent.
 *
 * Lifecycle: `idle → requesting → connecting → connected → ended | error`.
 * A TalkifCall instance is single-use: create a new one per call.
 */
export class TalkifCall {
	private readonly signaling: SignalingClient;
	private readonly config: TalkifConfig;
	private readonly emitter = new Emitter<TalkifCallEventMap>();
	private events: CallEventsClient | null = null;

	private pc: RTCPeerConnection | null = null;
	private localStream: MediaStream | null = null;
	private remoteAudio: HTMLAudioElement | null = null;
	private ownsAudioElement = false;
	private dataChannel: DataChannel | null = null;
	private iceServers: IceServer[] = [];

	private durationTimer: ReturnType<typeof setInterval> | null = null;
	private healthTimer: ReturnType<typeof setTimeout> | null = null;
	private pipelineConfirmed = false;
	private renegotiating = false;

	private _state: CallState = 'idle';
	private _callId: string | null = null;
	private _botId: string | null = null;
	private _muted = false;
	private _durationSecs = 0;

	constructor(config: TalkifConfig) {
		this.config = config;
		this.signaling = new SignalingClient(config);
	}

	// -- public surface -------------------------------------------------------

	get state(): CallState {
		return this._state;
	}

	get callId(): string | null {
		return this._callId;
	}

	get botId(): string | null {
		return this._botId;
	}

	get muted(): boolean {
		return this._muted;
	}

	get durationSecs(): number {
		return this._durationSecs;
	}

	on<K extends keyof TalkifCallEventMap>(
		event: K,
		listener: (payload: TalkifCallEventMap[K]) => void
	): () => void {
		return this.emitter.on(event, listener);
	}

	off<K extends keyof TalkifCallEventMap>(
		event: K,
		listener: (payload: TalkifCallEventMap[K]) => void
	): void {
		this.emitter.off(event, listener);
	}

	/**
	 * External health signal (e.g. the dashboard's SSE layer saw a
	 * RUNNING/CONNECTED status). Cancels the REST health watchdog.
	 */
	confirmPipelineHealthy(): void {
		this.pipelineConfirmed = true;
		if (this.healthTimer) {
			clearTimeout(this.healthTimer);
			this.healthTimer = null;
		}
	}

	/**
	 * External terminal signal (e.g. SSE reported COMPLETED). Tears down and
	 * transitions to 'ended'.
	 */
	endedExternally(): void {
		if (this._state !== 'connecting' && this._state !== 'connected') return;
		this.teardown();
		this.setState('ended');
		this.emitter.emit('ended', { reason: 'external' });
	}

	/** Send an arbitrary JSON app message to the bot over the data channel. */
	sendAppMessage(message: AppMessage): boolean {
		return this.dataChannel?.sendAppMessage(message) ?? false;
	}

	setMuted(muted: boolean): void {
		if (!this.localStream) return;
		for (const track of this.localStream.getAudioTracks()) {
			track.enabled = !muted;
		}
		this._muted = muted;
		this.emitter.emit('mutechange', { muted });
	}

	/** User-initiated hangup. */
	hangup(): void {
		if (this._state === 'idle' || this._state === 'ended' || this._state === 'error') return;
		this.teardown();
		this.setState('ended');
		this.emitter.emit('ended', { reason: 'local-hangup' });
	}

	/** Full teardown regardless of state — safe to call multiple times. */
	dispose(): void {
		this.teardown();
		this.signaling.session?.dispose();
		this.emitter.removeAll();
	}

	// -- lifecycle ------------------------------------------------------------

	async start(options: StartCallOptions): Promise<void> {
		if (this._state !== 'idle') {
			throw new TalkifCallError('signaling-failed', `Cannot start a call from state '${this._state}' — create a new TalkifCall`);
		}
		this.setState('requesting');

		if (!this.signaling.isPublic && !options.flowId) {
			throw new TalkifCallError('signaling-failed', 'flowId is required in authenticated mode');
		}

		try {
			// Run bot warmup (create call → bot assignment, 2-5s) in parallel with
			// local setup (ICE fetch, mic, offer, candidate gathering).
			const flowId = options.flowId ?? '';
			const [callResponse, local] = await Promise.all([
				options.draftDefinition !== undefined
					? this.signaling.createTestCall({
							flowId,
							definition: options.draftDefinition,
							...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
						})
					: this.signaling.createCall({
							flowId,
							...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
						}),
				this.prepareLocal(options),
			]);

			this._callId = callResponse.callId;
			this.pc = local.pc;
			this.localStream = local.stream;
			this.setState('connecting');

			// Subscribe to events before the media handshake so the WS is
			// listening before the bot speaks (the session→call mapping already
			// exists once create-call returns).
			this.connectEvents();

			this.pc.ontrack = (event) => {
				const stream = event.streams[0];
				if (!stream) return;
				this.attachRemoteAudio(stream, options);
				this.emitter.emit('track', { stream });
			};

			this.pc.onconnectionstatechange = () => {
				const state = this.pc?.connectionState;
				if (state === 'failed' || state === 'disconnected') {
					this.fail(new TalkifCallError('connection-failed', 'WebRTC connection failed'));
				}
			};

			this.dataChannel = new DataChannel(this.pc, {
				onSignalling: (message) => this.handleSignalling(message),
				onAppMessage: (message) => this.emitter.emit('appmessage', { message }),
			});

			const answer = await this.signaling.sendOffer(callResponse.callId, {
				sdp: this.mustLocalSdp(),
				iceServers: this.iceServers,
			});
			await this.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
			this._botId = answer.botId ?? null;

			this.setState('connected');
			this.emitter.emit('connected', { callId: callResponse.callId, botId: this._botId });
			this.startDurationTimer();
			this.armHealthWatchdog(callResponse.callId);
		} catch (error) {
			this.fail(
				error instanceof TalkifCallError ? error : asSignalingCallError(error)
			);
			throw error;
		}
	}

	private async prepareLocal(options: StartCallOptions): Promise<{ pc: RTCPeerConnection; stream: MediaStream }> {
		const { iceServers } = await this.signaling.getIceServers();
		this.iceServers = iceServers;

		if (!navigator.mediaDevices?.getUserMedia) {
			throw new TalkifCallError('media-unavailable', 'Microphone access unavailable. This requires HTTPS or localhost.');
		}
		const stream = await navigator.mediaDevices
			.getUserMedia({ audio: options.audio ?? true })
			.catch((cause: unknown) => {
				throw new TalkifCallError('media-unavailable', 'Microphone permission denied or unavailable', cause);
			});

		// Relay-only transport: skips host/srflx gathering (no dead-interface
		// timeouts), works through firewalls that block UDP, avoids TURN
		// "Forbidden IP" errors for private IPs, and gathers in ~100-200ms.
		const pc = new RTCPeerConnection({
			iceServers: iceServers.map((s) => ({
				urls: s.urls,
				...(s.username !== undefined ? { username: s.username } : {}),
				...(s.credential !== undefined ? { credential: s.credential } : {}),
			})),
			iceTransportPolicy: 'relay',
		});
		for (const track of stream.getTracks()) {
			pc.addTrack(track, stream);
		}

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		if (!offer.sdp) {
			throw new TalkifCallError('signaling-failed', 'Failed to create SDP offer');
		}

		await this.waitForFirstRelayCandidate(pc);
		return { pc, stream };
	}

	private waitForFirstRelayCandidate(pc: RTCPeerConnection): Promise<void> {
		return new Promise<void>((resolve) => {
			if (pc.iceGatheringState === 'complete') {
				resolve();
				return;
			}
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				pc.removeEventListener('icecandidate', onCandidate);
				pc.removeEventListener('icegatheringstatechange', onGatheringComplete);
				resolve();
			};
			const timeout = setTimeout(finish, ICE_FIRST_RELAY_TIMEOUT_MS);
			const onCandidate = (e: RTCPeerConnectionIceEvent) => {
				if (e.candidate && e.candidate.type === 'relay') finish();
			};
			const onGatheringComplete = () => {
				if (pc.iceGatheringState === 'complete') finish();
			};
			pc.addEventListener('icecandidate', onCandidate);
			pc.addEventListener('icegatheringstatechange', onGatheringComplete);
		});
	}

	private attachRemoteAudio(stream: MediaStream, options: StartCallOptions): void {
		if (options.audioElement === null) return; // consumer opted out
		if (!this.remoteAudio) {
			if (options.audioElement) {
				this.remoteAudio = options.audioElement;
				this.ownsAudioElement = false;
			} else {
				this.remoteAudio = new Audio();
				this.remoteAudio.autoplay = true;
				this.ownsAudioElement = true;
			}
		}
		this.remoteAudio.srcObject = stream;
	}

	// -- data-channel protocol ------------------------------------------------

	private handleSignalling(message: SignallingPayload): void {
		switch (message.type) {
			case 'peerLeft':
				if (this._state === 'connected' || this._state === 'connecting') {
					this.teardown();
					this.setState('ended');
					this.emitter.emit('ended', { reason: 'peer-left' });
				}
				break;
			case 'renegotiate':
				void this.renegotiate();
				break;
			case 'trackStatus':
				// Bot→client trackStatus is not part of the current protocol; ignore.
				break;
		}
	}

	/**
	 * Bot asked for a new offer/answer cycle. Re-offer through the same relay
	 * endpoint. If the backend rejects re-offers (older deployments), the call
	 * keeps running on the existing session — surfaced via `renegotiated`.
	 */
	private async renegotiate(): Promise<void> {
		if (!this.pc || !this._callId || this.renegotiating) return;
		this.renegotiating = true;
		try {
			const offer = await this.pc.createOffer({ iceRestart: true });
			await this.pc.setLocalDescription(offer);
			await this.waitForFirstRelayCandidate(this.pc);
			const answer = await this.signaling.sendOffer(this._callId, {
				sdp: this.mustLocalSdp(),
				iceServers: this.iceServers,
			});
			await this.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
			this.emitter.emit('renegotiated', { ok: true });
		} catch {
			this.emitter.emit('renegotiated', { ok: false });
		} finally {
			this.renegotiating = false;
		}
	}

	// -- realtime events (public mode) ----------------------------------------

	/**
	 * Public mode only: open the realtime events WebSocket for this call.
	 * Events double as the pipeline-health signal, and a terminal `status`
	 * event ends the call from the server side (e.g. max-duration reached).
	 */
	private connectEvents(): void {
		const session = this.signaling.session;
		if (!session) return; // authenticated mode: dashboard SSE covers events

		this.events = new CallEventsClient({
			baseUrl: this.config.baseUrl,
			getToken: () => session.getToken(),
			onEvent: (event) => this.handleCallEvent(event),
		});
		this.events.connect();
	}

	private handleCallEvent(event: CallEventEnvelope): void {
		// Events flowing at all = the bot pipeline is alive.
		this.confirmPipelineHealthy();
		this.emitter.emit('callevent', { event });

		switch (event.type) {
			case 'transcript': {
				const role = typeof event.data.role === 'string' ? event.data.role : 'unknown';
				const content = typeof event.data.content === 'string' ? event.data.content : '';
				this.emitter.emit('transcript', { role, content, data: event.data });
				break;
			}
			case 'interim':
				this.emitter.emit('interim', { data: event.data });
				break;
			case 'tts': {
				const text = typeof event.data.text === 'string' ? event.data.text : '';
				if (!text) break;
				const timestamp = typeof event.data.timestamp === 'number' ? event.data.timestamp : 0;
				this.emitter.emit('ttschunk', { text, timestamp, data: event.data });
				break;
			}
			case 'tts_word': {
				const word = typeof event.data.word === 'string' ? event.data.word : '';
				if (!word) break;
				// Backend serializes camelCase (`ptsMs`); accept snake_case too
				// for resilience against older/other emitters.
				const ptsRaw = event.data.ptsMs ?? event.data.pts_ms;
				const ptsMs = typeof ptsRaw === 'number' ? ptsRaw : null;
				const timestamp = typeof event.data.timestamp === 'number' ? event.data.timestamp : 0;
				this.emitter.emit('ttsword', { word, ptsMs, timestamp, data: event.data });
				break;
			}
			case 'status': {
				const status = typeof event.data.status === 'string' ? event.data.status : '';
				if (TERMINAL_CALL_STATUSES.has(status.toUpperCase() as never)) {
					this.endedExternally();
				}
				break;
			}
		}
	}

	// -- health watchdog ------------------------------------------------------

	private armHealthWatchdog(callId: string): void {
		this.pipelineConfirmed = false;
		this.healthTimer = setTimeout(() => {
			this.healthTimer = null;
			if (this.pipelineConfirmed) return;
			void this.verifyPipelineHealth(callId);
		}, PIPELINE_HEALTH_TIMEOUT_MS);
	}

	private async verifyPipelineHealth(callId: string): Promise<void> {
		try {
			const call = await this.signaling.getCall(callId);
			if (this.pipelineConfirmed || !this.pc) return;
			if (TERMINAL_CALL_STATUSES.has(call.status)) {
				this.fail(new TalkifCallError('pipeline-dead', `Backend reports terminal status '${call.status}'`));
				return;
			}
			// Backend says the call is alive — the silence was the event layer's
			// fault, not the pipeline's.
			this.pipelineConfirmed = true;
		} catch {
			if (this.pipelineConfirmed || !this.pc) return;
			// REST unreachable — fall back to the media-plane signal. Flowing
			// audio means alive; later media death is caught by
			// onconnectionstatechange. Kill only when both signals are gone.
			if (this.pc.connectionState === 'connected') {
				this.pipelineConfirmed = true;
				return;
			}
			this.fail(new TalkifCallError('pipeline-dead', 'No health signal, REST unreachable, media not connected'));
		}
	}

	// -- internals ------------------------------------------------------------

	private mustLocalSdp(): string {
		const sdp = this.pc?.localDescription?.sdp;
		if (!sdp) {
			throw new TalkifCallError('signaling-failed', 'Local SDP missing');
		}
		return sdp;
	}

	private startDurationTimer(): void {
		this._durationSecs = 0;
		this.durationTimer = setInterval(() => {
			this._durationSecs += 1;
			this.emitter.emit('tick', { durationSecs: this._durationSecs });
		}, 1_000);
	}

	private fail(error: TalkifCallError): void {
		if (this._state === 'ended' || this._state === 'error') return;
		this.teardown();
		this.setState('error');
		this.emitter.emit('error', { error });
	}

	private setState(state: CallState): void {
		const previous = this._state;
		if (previous === state) return;
		this._state = state;
		this.emitter.emit('statechange', { state, previous });
	}

	private teardown(): void {
		this.events?.close();
		this.events = null;

		if (this.healthTimer) {
			clearTimeout(this.healthTimer);
			this.healthTimer = null;
		}
		this.pipelineConfirmed = false;

		if (this.durationTimer) {
			clearInterval(this.durationTimer);
			this.durationTimer = null;
		}

		this.dataChannel?.close();
		this.dataChannel = null;

		if (this.localStream) {
			for (const track of this.localStream.getTracks()) track.stop();
			this.localStream = null;
		}

		if (this.remoteAudio) {
			this.remoteAudio.pause();
			this.remoteAudio.srcObject = null;
			if (this.ownsAudioElement) this.remoteAudio = null;
		}

		if (this.pc) {
			this.pc.ontrack = null;
			this.pc.onconnectionstatechange = null;
			this.pc.close();
			this.pc = null;
		}
	}
}

export type { CallEndReason };
