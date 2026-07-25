import type { CallEventEnvelope } from './types.js';

/** Reconnect backoff schedule (ms). Caps at the last entry. */
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];

export interface CallEventsOptions {
	/** API origin, e.g. `https://api.talkif.ai`. */
	baseUrl: string;
	/** Fresh session token per (re)connect — first-message auth. */
	getToken: () => Promise<string>;
	/** Every delivered envelope for the session's call. */
	onEvent: (event: CallEventEnvelope) => void;
	/**
	 * A `seq` gap was observed: this connection shed frames under backpressure.
	 * The client auto-requests a server-side replay on reconnect; consumers that
	 * render transcripts incrementally may want to clear-and-rebuild on replay.
	 */
	onGap?: (expected: number, received: number) => void;
	/** Optional WebSocket constructor override (tests, Node). */
	webSocket?: typeof WebSocket;
}

/**
 * Client for the public realtime events WebSocket
 * (`/api/v1/public/ws/events`).
 *
 * Protocol: connect → send `{"type":"auth","token":...}` within 5s → send
 * `{"type":"subscribe"}` (the session is auto-bound to its one call) →
 * receive `{v, type, call_id?, seq, ts, data}` envelopes. Reconnects with
 * backoff; after the first successful connection, reconnect subscribes with
 * `replay: true` to recover anything missed during the gap.
 */
export class CallEventsClient {
	private readonly options: CallEventsOptions;
	private ws: WebSocket | null = null;
	private closed = false;
	private attempts = 0;
	private lastSeq = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: CallEventsOptions) {
		this.options = options;
	}

	connect(): void {
		if (this.closed || this.ws) return;
		void this.open();
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close(1000);
		this.ws = null;
	}

	private wsUrl(): string {
		const base = this.options.baseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
		return `${base}/api/v1/public/ws/events`;
	}

	private async open(): Promise<void> {
		let token: string;
		try {
			token = await this.options.getToken();
		} catch {
			this.scheduleReconnect();
			return;
		}
		if (this.closed) return;

		const WS = this.options.webSocket ?? WebSocket;
		const ws = new WS(this.wsUrl());
		this.ws = ws;

		ws.onopen = () => {
			ws.send(JSON.stringify({ type: 'auth', token }));
			// Replay recovers anything emitted before this subscribe landed
			// (the opening word) and anything shed during a reconnect gap.
			ws.send(JSON.stringify({ type: 'subscribe', replay: true }));
		};

		ws.onmessage = (message: MessageEvent) => {
			if (typeof message.data !== 'string') return;
			let envelope: CallEventEnvelope;
			try {
				envelope = JSON.parse(message.data) as CallEventEnvelope;
			} catch {
				return;
			}
			if (typeof envelope.type !== 'string' || typeof envelope.seq !== 'number') return;

			if (envelope.type === 'subscribed') {
				this.attempts = 0;
				this.lastSeq = envelope.seq;
				return;
			}
			if (envelope.type === 'pong' || envelope.type === 'unsubscribed') {
				this.lastSeq = envelope.seq;
				return;
			}

			if (this.lastSeq > 0 && envelope.seq > this.lastSeq + 1) {
				this.options.onGap?.(this.lastSeq + 1, envelope.seq);
			}
			this.lastSeq = envelope.seq;
			this.options.onEvent(envelope);
		};

		ws.onclose = (event: CloseEvent) => {
			if (this.ws !== ws) return;
			this.ws = null;
			// seq is per-connection — reset the tracker.
			this.lastSeq = 0;
			// 4401/4403 are auth/scope rejections: retrying with the same session
			// can still succeed after a token refresh (getToken re-exchanges), but
			// a scope violation (4403) will never heal — stop there.
			if (event.code === 4403) {
				this.closed = true;
				return;
			}
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			// onclose follows and handles reconnection.
		};
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer) return;
		const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] ?? 8_000;
		this.attempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.open();
		}, delay);
	}
}
