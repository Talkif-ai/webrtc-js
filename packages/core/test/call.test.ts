import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TalkifCall } from '../src/call.js';
import type { TalkifPublicClientConfig } from '../src/types.js';

/**
 * Minimal RTCPeerConnection double: enough surface for TalkifCall.start()
 * plus a `setConnectionState` knob to drive `onconnectionstatechange`.
 */
class FakePeerConnection {
	static instances: FakePeerConnection[] = [];
	connectionState: RTCPeerConnectionState = 'new';
	iceGatheringState: RTCIceGatheringState = 'complete';
	localDescription: { sdp: string } | null = null;
	onconnectionstatechange: (() => void) | null = null;
	ontrack: ((event: unknown) => void) | null = null;
	closed = false;

	constructor() {
		FakePeerConnection.instances.push(this);
	}
	addTrack(): void {}
	addEventListener(): void {}
	removeEventListener(): void {}
	createDataChannel() {
		return { onopen: null, onmessage: null, onclose: null, readyState: 'open', send() {}, close() {} };
	}
	async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
		return { type: 'offer', sdp: 'v=0 offer' };
	}
	async setLocalDescription(desc: { sdp: string }): Promise<void> {
		this.localDescription = desc;
	}
	async setRemoteDescription(): Promise<void> {}
	close(): void {
		this.closed = true;
	}
	setConnectionState(state: RTCPeerConnectionState): void {
		this.connectionState = state;
		this.onconnectionstatechange?.();
	}
}

/** WebSocket double for the realtime events channel. */
class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	closedWith: number | null = null;
	sent: string[] = [];

	constructor(_url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(code = 1000): void {
		this.closedWith = code;
	}
	/** Server-side helper: deliver one event envelope. */
	deliver(type: string, seq: number, data: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify({ v: 1, type, seq, ts: 0, data }) });
	}
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function fetchStub(): typeof fetch {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith('/public/calls/session')) {
			return jsonResponse({ token: 'sess', expiresIn: 3600, flowId: 'flow-1' });
		}
		if (url.endsWith('/ice-servers')) return jsonResponse({ iceServers: [], ttl: 3600 });
		if (url.endsWith('/offer')) return jsonResponse({ sdp: 'v=0 answer', sdpType: 'answer', botId: 'bot-1' });
		if (url.endsWith('/public/calls/calls')) {
			return jsonResponse({ callId: 'call-1', flowId: 'flow-1', status: 'IN_PROGRESS' });
		}
		throw new Error(`unexpected fetch ${url}`);
	}) as unknown as typeof fetch;
}

async function startCall(): Promise<{
	call: TalkifCall;
	pc: FakePeerConnection;
	ws: FakeWebSocket;
	ended: unknown[];
	errors: unknown[];
}> {
	const config: TalkifPublicClientConfig = {
		baseUrl: 'https://api.talkif.ai',
		publishableKey: 'pk_test',
		fetch: fetchStub(),
	};
	const call = new TalkifCall(config);
	const ended: unknown[] = [];
	const errors: unknown[] = [];
	call.on('ended', (p) => ended.push(p));
	call.on('error', (p) => errors.push(p));

	await call.start({ audioElement: null });

	const pc = FakePeerConnection.instances[0];
	if (!pc) throw new Error('peer connection was not created');
	// The events client awaits the session token before opening the socket.
	await vi.advanceTimersByTimeAsync(0);
	const ws = FakeWebSocket.instances[0];
	if (!ws) throw new Error('events socket was not opened');
	ws.onopen?.();
	pc.setConnectionState('connected');
	return { call, pc, ws, ended, errors };
}

describe('TalkifCall end-of-call handling', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakePeerConnection.instances = [];
		FakeWebSocket.instances = [];
		vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
		vi.stubGlobal('WebSocket', FakeWebSocket);
		vi.stubGlobal('navigator', {
			mediaDevices: {
				getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }),
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('ends cleanly on the ENDED realtime status', async () => {
		const { call, ws, ended, errors } = await startCall();

		ws.deliver('status', 1, { type: 'status.pipeline', status: 'ENDED', message: 'pipeline ended' });

		expect(call.state).toBe('ended');
		expect(ended).toEqual([{ reason: 'external' }]);
		expect(errors).toEqual([]);
	});

	it('does not fail on a transient disconnected state that recovers', async () => {
		const { call, pc, errors } = await startCall();

		pc.setConnectionState('disconnected');
		await vi.advanceTimersByTimeAsync(2_000);
		pc.setConnectionState('connected');
		await vi.advanceTimersByTimeAsync(10_000);

		expect(call.state).toBe('connected');
		expect(errors).toEqual([]);
	});

	it('keeps the events channel open during the grace period so ENDED wins the race', async () => {
		const { call, pc, ws, ended, errors } = await startCall();

		pc.setConnectionState('disconnected');
		await vi.advanceTimersByTimeAsync(1_000);
		expect(ws.closedWith).toBeNull();

		ws.deliver('status', 1, { type: 'status.pipeline', status: 'ENDED', message: 'pipeline ended' });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(call.state).toBe('ended');
		expect(ended).toEqual([{ reason: 'external' }]);
		expect(errors).toEqual([]);
	});

	it('fails with connection-failed once the disconnected grace period expires', async () => {
		const { call, pc, errors } = await startCall();

		pc.setConnectionState('disconnected');
		await vi.advanceTimersByTimeAsync(3_999);
		expect(call.state).toBe('connected');

		await vi.advanceTimersByTimeAsync(1);
		expect(call.state).toBe('error');
		expect(errors).toHaveLength(1);
		expect((errors[0] as { error: { code: string } }).error.code).toBe('connection-failed');
	});

	it('shortens the deadline when disconnected escalates to failed', async () => {
		const { call, pc } = await startCall();

		pc.setConnectionState('disconnected');
		await vi.advanceTimersByTimeAsync(1_000);
		pc.setConnectionState('failed');
		await vi.advanceTimersByTimeAsync(1_499);
		expect(call.state).toBe('connected');

		await vi.advanceTimersByTimeAsync(1);
		expect(call.state).toBe('error');
	});

	it('peer-left during the grace period ends cleanly and cancels the failure', async () => {
		const { call, pc, ended, errors } = await startCall();

		pc.setConnectionState('disconnected');
		// Drive the data-channel protocol through the private handler; the
		// DataChannel double has no wire, so this is the narrowest entry point.
		(call as unknown as { handleSignalling(m: { type: 'peerLeft' }): void }).handleSignalling({ type: 'peerLeft' });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(call.state).toBe('ended');
		expect(ended).toEqual([{ reason: 'peer-left' }]);
		expect(errors).toEqual([]);
	});
});

/** Track double: lets a test assert the mic was released. */
class FakeTrack {
	stopped = false;
	enabled = true;
	stop(): void {
		this.stopped = true;
	}
}

/**
 * fetch double whose create-call response is held until `release()` is
 * called, so a test can hang up while start() is still awaiting warmup.
 */
function deferredFetchStub(): { fetch: typeof fetch; release: () => void; ended: string[] } {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ended: string[] = [];
	const stub = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith('/end')) {
			ended.push(url);
			return new Response(null, { status: 204 });
		}
		if (url.endsWith('/public/calls/session')) {
			return jsonResponse({ token: 'sess', expiresIn: 3600, flowId: 'flow-1' });
		}
		if (url.endsWith('/ice-servers')) return jsonResponse({ iceServers: [], ttl: 3600 });
		if (url.endsWith('/offer')) return jsonResponse({ sdp: 'v=0 answer', sdpType: 'answer', botId: 'bot-1' });
		if (url.endsWith('/public/calls/calls')) {
			await gate;
			return jsonResponse({ callId: 'call-1', flowId: 'flow-1', status: 'IN_PROGRESS' });
		}
		throw new Error(`unexpected fetch ${url}`);
	}) as unknown as typeof fetch;
	return { fetch: stub, release, ended };
}

describe('TalkifCall hangup during start()', () => {
	let track: FakeTrack;

	beforeEach(() => {
		vi.useFakeTimers();
		FakePeerConnection.instances = [];
		FakeWebSocket.instances = [];
		track = new FakeTrack();
		vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
		vi.stubGlobal('WebSocket', FakeWebSocket);
		vi.stubGlobal('navigator', {
			mediaDevices: {
				getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function makeCall(fetchImpl: typeof fetch) {
		const call = new TalkifCall({ baseUrl: 'https://api.talkif.ai', publishableKey: 'pk_test', fetch: fetchImpl });
		const states: string[] = [];
		const ended: unknown[] = [];
		call.on('statechange', (p) => states.push(p.state));
		call.on('ended', (p) => ended.push(p));
		return { call, states, ended };
	}

	it('hangup while requesting releases the mic and never connects', async () => {
		const { fetch, release, ended: endedCalls } = deferredFetchStub();
		const { call, states, ended } = makeCall(fetch);

		const started = call.start({ audioElement: null });
		await vi.advanceTimersByTimeAsync(0); // let prepareLocal() acquire the mic
		expect(call.state).toBe('requesting');

		call.hangup();
		expect(call.state).toBe('ended');
		expect(ended).toEqual([{ reason: 'local-hangup' }]);

		release();
		await expect(started).resolves.toBeUndefined();

		expect(call.state).toBe('ended');
		expect(states).toEqual(['requesting', 'ended']);
		expect(track.stopped).toBe(true);
		expect(FakePeerConnection.instances[0]?.closed).toBe(true);
		expect(FakeWebSocket.instances).toHaveLength(0);
		// The bot was assigned server-side even though no offer was sent: end it.
		await vi.advanceTimersByTimeAsync(0);
		expect(endedCalls).toEqual(['https://api.talkif.ai/api/v1/public/calls/calls/call-1/end']);
	});

	it('dispose while requesting releases the mic and stays silent', async () => {
		const { fetch, release, ended: endedCalls } = deferredFetchStub();
		const { call, states } = makeCall(fetch);

		const started = call.start({ audioElement: null });
		await vi.advanceTimersByTimeAsync(0);
		call.dispose();

		release();
		await expect(started).resolves.toBeUndefined();

		expect(states).toEqual(['requesting']);
		expect(track.stopped).toBe(true);
		expect(FakePeerConnection.instances[0]?.closed).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(endedCalls).toHaveLength(1);
	});

	it('hangup while the offer is in flight does not resurrect the call', async () => {
		const { fetch, release, ended: endedCalls } = deferredFetchStub();
		const { call, states } = makeCall(fetch);
		const pcProto = FakePeerConnection.prototype;
		const originalSetRemote = pcProto.setRemoteDescription;
		// Hang up at the moment the answer arrives, before setRemoteDescription.
		pcProto.setRemoteDescription = async function () {
			call.hangup();
		};

		const started = call.start({ audioElement: null });
		release();
		await expect(started).resolves.toBeUndefined();
		pcProto.setRemoteDescription = originalSetRemote;

		expect(call.state).toBe('ended');
		expect(states).toEqual(['requesting', 'connecting', 'ended']);
		expect(track.stopped).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(endedCalls).toHaveLength(1);
	});

	it('hangup on a connected call sends end-call to the backend', async () => {
		const { fetch, release, ended: endedCalls } = deferredFetchStub();
		const { call, ended } = makeCall(fetch);
		release();
		await call.start({ audioElement: null });
		expect(call.state).toBe('connected');

		call.hangup();
		await vi.advanceTimersByTimeAsync(0);

		expect(ended).toEqual([{ reason: 'local-hangup' }]);
		expect(endedCalls).toEqual(['https://api.talkif.ai/api/v1/public/calls/calls/call-1/end']);
	});
});
