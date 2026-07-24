import type {
	CreateCallRequest,
	CreateCallResponse,
	CreateTestCallRequest,
	IceServersResponse,
	OfferRequest,
	OfferResponse,
	PublicSessionResponse,
	TalkifConfig,
	TalkifPublicClientConfig,
	WebRTCCall,
} from './types.js';
import { isPublicConfig, TalkifCallError } from './types.js';
import { TurnstileManager } from './turnstile.js';

export class SignalingError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, message: string, body: unknown) {
		super(message);
		this.name = 'SignalingError';
		this.status = status;
		this.body = body;
	}
}

/** Re-exchange the publishable key this many ms before the token expires. */
const SESSION_REFRESH_MARGIN_MS = 60_000;

/**
 * Holds the short-lived session token for the public surface: exchanges the
 * publishable key on first use, re-exchanges near expiry, and can be
 * invalidated on a 401 so the next request retries with a fresh token.
 */
export class PublicSession {
	private readonly config: TalkifPublicClientConfig;
	private token: string | null = null;
	private expiresAt = 0;
	private flowIdValue: string | null = null;
	private inflight: Promise<string> | null = null;
	private turnstile: TurnstileManager | null = null;

	constructor(config: TalkifPublicClientConfig) {
		this.config = config;
		// Built-in Turnstile: render an invisible challenge from the sitekey,
		// unless the caller supplies their own token provider.
		if (config.turnstileSiteKey && !config.turnstileToken) {
			this.turnstile = new TurnstileManager(config.turnstileSiteKey);
		}
	}

	/** A fresh Turnstile token, from the manual supplier or the built-in
	 * manager; undefined when no gate is configured (dev/local). */
	private async turnstileToken(): Promise<string | undefined> {
		if (this.config.turnstileToken) {
			return this.config.turnstileToken();
		}
		if (this.turnstile) {
			return this.turnstile.getToken();
		}
		return undefined;
	}

	/** Tear down the Turnstile widget (call when the client is disposed). */
	dispose(): void {
		this.turnstile?.dispose();
		this.turnstile = null;
	}

	/** Flow bound to the publishable key (known after the first exchange). */
	get flowId(): string | null {
		return this.flowIdValue;
	}

	async getToken(): Promise<string> {
		if (this.token && Date.now() < this.expiresAt - SESSION_REFRESH_MARGIN_MS) {
			return this.token;
		}
		// Single-flight the exchange: concurrent requests share one round-trip.
		this.inflight ??= this.exchange().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	invalidate(): void {
		this.token = null;
		this.expiresAt = 0;
	}

	private async exchange(): Promise<string> {
		const doFetch = this.config.fetch ?? fetch;
		const turnstileToken = await this.turnstileToken();
		const response = await doFetch(
			`${this.config.baseUrl.replace(/\/$/, '')}/api/v1/public/calls/session`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					publishableKey: this.config.publishableKey,
					...(turnstileToken !== undefined ? { turnstileToken } : {}),
				}),
			}
		);
		const parsed: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			throw new SignalingError(
				response.status,
				'Session exchange failed — check the publishable key and that this origin is on its allowlist',
				parsed
			);
		}
		const session = parsed as PublicSessionResponse;
		this.token = session.token;
		this.expiresAt = Date.now() + session.expiresIn * 1_000;
		this.flowIdValue = session.flowId;
		return session.token;
	}
}

/**
 * Thin HTTP client for the Talkif WebRTC signaling routes. Two modes:
 * - authenticated (dashboard/API): `/api/v1/accounts/{accountId}/calls/webrtc`
 * - public (embed): `/api/v1/public/calls`, session token minted from the
 *   publishable key and refreshed transparently.
 */
export class SignalingClient {
	private readonly config: TalkifConfig;
	readonly session: PublicSession | null;

	constructor(config: TalkifConfig) {
		this.config = config;
		this.session = isPublicConfig(config) ? new PublicSession(config) : null;
	}

	get isPublic(): boolean {
		return this.session !== null;
	}

	private get base(): string {
		const baseUrl = this.config.baseUrl.replace(/\/$/, '');
		if (isPublicConfig(this.config)) {
			return `${baseUrl}/api/v1/public/calls`;
		}
		return `${baseUrl}/api/v1/accounts/${this.config.accountId}/calls/webrtc`;
	}

	private async authorization(): Promise<string> {
		if (this.session) {
			return `Bearer ${await this.session.getToken()}`;
		}
		return (this.config as { auth: () => string | Promise<string> }).auth();
	}

	private async request<T>(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
		retriedAuth = false
	): Promise<T> {
		const doFetch = this.config.fetch ?? fetch;
		const authorization = await this.authorization();
		const response = await doFetch(`${this.base}${path}`, {
			method,
			headers: {
				authorization,
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});

		// Public mode: an expired/rotated session token gets one transparent
		// re-exchange + retry before surfacing the failure.
		if (response.status === 401 && this.session && !retriedAuth) {
			this.session.invalidate();
			return this.request(method, path, body, true);
		}

		let parsed: unknown = null;
		const text = await response.text();
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}

		if (!response.ok) {
			const message =
				typeof parsed === 'object' && parsed !== null && 'detail' in parsed
					? String((parsed as { detail: unknown }).detail)
					: typeof parsed === 'object' && parsed !== null && 'message' in parsed
						? String((parsed as { message: unknown }).message)
						: `Signaling request failed: ${method} ${path} → ${response.status}`;
			throw new SignalingError(response.status, message, parsed);
		}
		return parsed as T;
	}

	createCall(body: CreateCallRequest): Promise<CreateCallResponse> {
		if (this.isPublic) {
			// Flow is bound to the publishable key server-side; body is empty.
			return this.request('POST', '/calls', {});
		}
		return this.request('POST', '', body);
	}

	createTestCall(body: CreateTestCallRequest): Promise<CreateCallResponse> {
		if (this.isPublic) {
			throw new TalkifCallError(
				'signaling-failed',
				'Draft test calls are not available on the public surface'
			);
		}
		return this.request('POST', '/test', body);
	}

	getIceServers(): Promise<IceServersResponse> {
		return this.request('GET', '/ice-servers');
	}

	sendOffer(callId: string, body: OfferRequest): Promise<OfferResponse> {
		const path = this.isPublic ? `/calls/${callId}/offer` : `/${callId}/offer`;
		return this.request('POST', path, body);
	}

	getCall(callId: string): Promise<WebRTCCall> {
		const path = this.isPublic ? `/calls/${callId}` : `/${callId}`;
		return this.request('GET', path);
	}
}

/** Map a signaling failure to the library's typed error. */
export function asSignalingCallError(error: unknown): TalkifCallError {
	if (error instanceof TalkifCallError) return error;
	if (error instanceof SignalingError) {
		const code =
			error.status === 401
				? 'session-rejected'
				: error.status === 409
					? 'call-active'
					: error.status === 429
						? 'rate-limited'
						: error.status === 503
							? 'no-agent'
							: 'signaling-failed';
		return new TalkifCallError(code, error.message, error);
	}
	const message = error instanceof Error ? error.message : 'Signaling request failed';
	return new TalkifCallError('signaling-failed', message, error);
}
