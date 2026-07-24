import type { AppMessage, SignallingPayload, TrackStatusMessage } from './types.js';

const KEEPALIVE_INTERVAL_MS = 2_000;

export interface DataChannelHandlers {
	onSignalling: (message: SignallingPayload) => void;
	onAppMessage: (message: AppMessage) => void;
}

/**
 * Client side of the pipecat SmallWebRTC data-channel protocol:
 *
 * - `"ping"` strings every 2s keep the bot's liveness check happy (the bot
 *   treats a connection as active when the last ping is <3s old, with the
 *   ICE connection state as fallback).
 * - Inbound JSON is either `{type: "signalling", message: {...}}` (protocol)
 *   or an arbitrary app message (forwarded to the consumer).
 */
export class DataChannel {
	private channel: RTCDataChannel;
	private keepalive: ReturnType<typeof setInterval> | null = null;
	private readonly handlers: DataChannelHandlers;

	constructor(pc: RTCPeerConnection, handlers: DataChannelHandlers) {
		this.handlers = handlers;
		this.channel = pc.createDataChannel('pipecat', { ordered: true });
		this.channel.onopen = () => this.startKeepalive();
		this.channel.onclose = () => this.stopKeepalive();
		this.channel.onmessage = (event) => this.handleMessage(event.data);
	}

	private startKeepalive(): void {
		this.stopKeepalive();
		this.keepalive = setInterval(() => {
			if (this.channel.readyState === 'open') {
				this.channel.send('ping');
			}
		}, KEEPALIVE_INTERVAL_MS);
	}

	private stopKeepalive(): void {
		if (this.keepalive) {
			clearInterval(this.keepalive);
			this.keepalive = null;
		}
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== 'string') return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return; // Non-JSON payloads (e.g. bot-side pings) carry no protocol meaning here.
		}
		if (typeof parsed !== 'object' || parsed === null) return;

		const record = parsed as Record<string, unknown>;
		if (record['type'] === 'signalling' && typeof record['message'] === 'object' && record['message'] !== null) {
			this.handlers.onSignalling(record['message'] as SignallingPayload);
			return;
		}
		this.handlers.onAppMessage(record as AppMessage);
	}

	/** Send an arbitrary JSON app message to the bot pipeline. */
	sendAppMessage(message: AppMessage): boolean {
		if (this.channel.readyState !== 'open') return false;
		this.channel.send(JSON.stringify(message));
		return true;
	}

	/** Tell the bot to enable/disable one of our media receivers. */
	sendTrackStatus(message: Omit<TrackStatusMessage, 'type'>): boolean {
		if (this.channel.readyState !== 'open') return false;
		this.channel.send(JSON.stringify({ type: 'signalling', message: { type: 'trackStatus', ...message } }));
		return true;
	}

	close(): void {
		this.stopKeepalive();
		this.channel.onopen = null;
		this.channel.onclose = null;
		this.channel.onmessage = null;
		if (this.channel.readyState === 'open' || this.channel.readyState === 'connecting') {
			this.channel.close();
		}
	}
}
