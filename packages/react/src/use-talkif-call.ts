import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPublicConfig, TalkifCall } from '@talkif/webrtc';
import type {
	AppMessage,
	CallEndReason,
	CallEventEnvelope,
	CallState,
	StartCallOptions,
	TalkifCallError,
	TalkifConfig,
	TtsChunkEvent,
	TtsWordEvent,
} from '@talkif/webrtc';

export interface UseTalkifCallOptions {
	/**
	 * Authenticated (`accountId` + `auth`) or public (`publishableKey`)
	 * configuration — public mode also streams realtime call events.
	 */
	config: TalkifConfig;
	/** Fired for every JSON app message from the bot (e.g. transcripts). */
	onAppMessage?: (message: AppMessage) => void;
	/** Public mode: every realtime event for this call (transcript, status…). */
	onCallEvent?: (event: CallEventEnvelope) => void;
	/** Public mode: final transcript lines. */
	onTranscript?: (payload: { role: string; content: string }) => void;
	/** Public mode: word-level TTS timing (karaoke). May be dropped under backpressure. */
	onTtsWord?: (payload: TtsWordEvent) => void;
	/**
	 * Public mode: sentence-level chunk of the agent's reply, ahead of audio
	 * playback (chat-style streaming). Reconcile with the final transcript.
	 */
	onTtsChunk?: (payload: TtsChunkEvent) => void;
	onEnded?: (reason: CallEndReason) => void;
	onError?: (error: TalkifCallError) => void;
}

export interface UseTalkifCallResult {
	state: CallState;
	callId: string | null;
	botId: string | null;
	error: TalkifCallError | null;
	durationSecs: number;
	muted: boolean;
	/** Live call handle for advanced use (sendAppMessage, confirmPipelineHealthy…). */
	call: TalkifCall | null;
	start: (options: StartCallOptions) => Promise<void>;
	hangup: () => void;
	toggleMute: () => void;
	sendAppMessage: (message: AppMessage) => boolean;
}

/**
 * Headless React binding for TalkifCall. One active call at a time; starting
 * a new call disposes the previous instance. All teardown (mic, peer
 * connection, timers) happens automatically on unmount.
 */
export function useTalkifCall(options: UseTalkifCallOptions): UseTalkifCallResult {
	const { config, onAppMessage, onCallEvent, onTranscript, onTtsWord, onTtsChunk, onEnded, onError } =
		options;

	const callRef = useRef<TalkifCall | null>(null);
	const [state, setState] = useState<CallState>('idle');
	const [callId, setCallId] = useState<string | null>(null);
	const [botId, setBotId] = useState<string | null>(null);
	const [error, setError] = useState<TalkifCallError | null>(null);
	const [durationSecs, setDurationSecs] = useState(0);
	const [muted, setMuted] = useState(false);

	// Keep callbacks in refs so subscriptions survive re-renders without
	// re-wiring the emitter.
	const callbacksRef = useRef({
		onAppMessage,
		onCallEvent,
		onTranscript,
		onTtsWord,
		onTtsChunk,
		onEnded,
		onError,
	});
	callbacksRef.current = {
		onAppMessage,
		onCallEvent,
		onTranscript,
		onTtsWord,
		onTtsChunk,
		onEnded,
		onError,
	};

	// The config object identity is the session identity — memoize on fields.
	const identity = isPublicConfig(config)
		? [config.baseUrl, config.publishableKey, config.turnstileToken, config.fetch]
		: [config.baseUrl, config.accountId, config.auth, config.fetch];
	const stableConfig = useMemo(
		() => config,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		identity
	);

	useEffect(() => {
		return () => {
			callRef.current?.dispose();
			callRef.current = null;
		};
	}, []);

	const start = useCallback(
		async (startOptions: StartCallOptions) => {
			// Single-use instances: replace any prior call.
			callRef.current?.dispose();

			const call = new TalkifCall(stableConfig);
			callRef.current = call;
			setError(null);
			setCallId(null);
			setBotId(null);
			setDurationSecs(0);
			setMuted(false);

			call.on('statechange', ({ state: next }) => setState(next));
			call.on('connected', ({ callId: id, botId: bot }) => {
				setCallId(id);
				setBotId(bot);
			});
			call.on('tick', ({ durationSecs: secs }) => setDurationSecs(secs));
			call.on('mutechange', ({ muted: m }) => setMuted(m));
			call.on('appmessage', ({ message }) => callbacksRef.current.onAppMessage?.(message));
			call.on('callevent', ({ event }) => callbacksRef.current.onCallEvent?.(event));
			call.on('transcript', ({ role, content }) =>
				callbacksRef.current.onTranscript?.({ role, content })
			);
			call.on('ttsword', (payload) => callbacksRef.current.onTtsWord?.(payload));
			call.on('ttschunk', (payload) => callbacksRef.current.onTtsChunk?.(payload));
			call.on('ended', ({ reason }) => callbacksRef.current.onEnded?.(reason));
			call.on('error', ({ error: err }) => {
				setError(err);
				callbacksRef.current.onError?.(err);
			});

			await call.start(startOptions);
		},
		[stableConfig]
	);

	const hangup = useCallback(() => {
		callRef.current?.hangup();
	}, []);

	const toggleMute = useCallback(() => {
		const call = callRef.current;
		if (!call) return;
		call.setMuted(!call.muted);
	}, []);

	const sendAppMessage = useCallback((message: AppMessage): boolean => {
		return callRef.current?.sendAppMessage(message) ?? false;
	}, []);

	return {
		state,
		callId,
		botId,
		error,
		durationSecs,
		muted,
		call: callRef.current,
		start,
		hangup,
		toggleMute,
		sendAppMessage,
	};
}
