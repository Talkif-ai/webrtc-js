/**
 * Wire types for the Talkif WebRTC signaling API and the pipecat SmallWebRTC
 * data-channel protocol spoken by Talkif voice bots.
 *
 * These shapes are the public contract. Field casing matches the backend JSON
 * exactly (camelCase over HTTP).
 */

// ---------------------------------------------------------------------------
// HTTP signaling
// ---------------------------------------------------------------------------

export interface IceServer {
	urls: string;
	username?: string;
	credential?: string;
}

export interface IceServersResponse {
	iceServers: IceServer[];
	/** Seconds remaining on the underlying TURN credential. */
	ttl: number;
}

export interface CreateCallRequest {
	flowId: string;
	metadata?: Record<string, unknown>;
}

export interface CreateTestCallRequest {
	flowId: string;
	/**
	 * Draft flow definition (frontend `FlowDefinition` shape). The library does
	 * not interpret it — it is passed through to the backend, which validates
	 * and compiles it for the bot.
	 */
	definition: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export type CallStatus =
	| 'CREATED'
	| 'BOT_ASSIGNED'
	| 'QUEUED'
	| 'RINGING'
	| 'IN_PROGRESS'
	| 'COMPLETED'
	| 'FAILED'
	| 'NO_ANSWER'
	| 'BUSY'
	| 'CANCELED';

/** REST statuses that mean the call is genuinely over. */
export const TERMINAL_CALL_STATUSES: ReadonlySet<CallStatus> = new Set([
	'COMPLETED',
	'FAILED',
	'NO_ANSWER',
	'BUSY',
	'CANCELED',
]);

export interface CreateCallResponse {
	callId: string;
	flowId: string;
	status: CallStatus;
	botId?: string | null;
}

export interface WebRTCCall {
	callId: string;
	status: CallStatus;
}

export interface OfferRequest {
	sdp: string;
	iceServers?: IceServer[];
}

/** Public surface: token-exchange response (`POST /public/calls/session`). */
export interface PublicSessionResponse {
	/** Signed session token — sent as `Authorization: Bearer <token>`. */
	token: string;
	/** Seconds until the token expires (~15 min). */
	expiresIn: number;
	/** The flow this session may call (bound to the publishable key). */
	flowId: string;
}

export interface OfferResponse {
	sdp: string;
	sdpType: string;
	botId?: string | null;
}

// ---------------------------------------------------------------------------
// Data-channel protocol (pipecat SmallWebRTC — bot side)
// ---------------------------------------------------------------------------

/** Bot → client: bot requests a new offer/answer cycle. */
export interface RenegotiateMessage {
	type: 'renegotiate';
}

/** Bot → client: bot is closing the connection. */
export interface PeerLeftMessage {
	type: 'peerLeft';
}

/** Client → bot: enable/disable a media receiver. 0=audio, 1=video, 2=screen. */
export interface TrackStatusMessage {
	type: 'trackStatus';
	receiver_index: 0 | 1 | 2;
	enabled: boolean;
}

export type SignallingPayload = RenegotiateMessage | PeerLeftMessage | TrackStatusMessage;

export interface SignallingEnvelope {
	type: 'signalling';
	message: SignallingPayload;
}

/**
 * Anything on the data channel that is not the signalling envelope (and not a
 * `"ping"` keepalive string) is an app message: arbitrary JSON exchanged with
 * the bot pipeline.
 */
export type AppMessage = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Realtime events WebSocket (`/api/v1/public/ws/events`)
// ---------------------------------------------------------------------------

/**
 * Server envelope on the realtime events WebSocket. `seq` is per-connection
 * and monotonic — a gap means THIS connection dropped frames under
 * backpressure, not that the call missed anything.
 */
export interface CallEventEnvelope {
	v: number;
	type: string;
	call_id?: string;
	seq: number;
	ts: number;
	data: Record<string, unknown>;
}

/** Event types the public WS delivers for the session's call. */
export type CallEventType =
	| 'transcript'
	| 'interim'
	| 'status'
	| 'tts'
	| 'tts_word'
	| 'speech'
	| 'turn'
	| 'node_transition'
	| 'error';

// ---------------------------------------------------------------------------
// Client state machine & events
// ---------------------------------------------------------------------------

export type CallState =
	| 'idle'
	| 'requesting'
	| 'connecting'
	| 'connected'
	| 'ended'
	| 'error';

export interface TalkifCallEventMap {
	/** State machine transition. */
	statechange: { state: CallState; previous: CallState };
	/** Media is flowing and the SDP answer is applied. */
	connected: { callId: string; botId: string | null };
	/** Remote (bot) audio track arrived. */
	track: { stream: MediaStream };
	/** Call finished normally (user hangup, bot peerLeft, terminal status). */
	ended: { reason: CallEndReason };
	/** Fatal failure. The call is torn down; state is 'error'. */
	error: { error: TalkifCallError };
	/** One-second duration tick while connected. */
	tick: { durationSecs: number };
	/** JSON app message from the bot over the data channel. */
	appmessage: { message: AppMessage };
	/** Bot asked for renegotiation. Emitted after the re-offer is attempted. */
	renegotiated: { ok: boolean };
	/** Mute toggled. */
	mutechange: { muted: boolean };
	/**
	 * Any realtime event for this call from the events WebSocket (public mode).
	 * Fires for every delivered envelope, including those with dedicated
	 * events below.
	 */
	callevent: { event: CallEventEnvelope };
	/** Final transcript line (public mode, via the events WebSocket). */
	transcript: { role: string; content: string; data: Record<string, unknown> };
	/** Interim (in-progress) transcription (public mode). May be dropped under backpressure. */
	interim: { data: Record<string, unknown> };
	/**
	 * Word-level TTS timing (public mode). Drives karaoke-style caption
	 * highlighting; only words actually spoken are delivered. May be dropped
	 * under backpressure.
	 */
	ttsword: TtsWordEvent;
	/**
	 * Sentence-level chunk of the agent's reply (public mode), emitted when the
	 * LLM output is handed to TTS synthesis — ahead of audio playback. Use for
	 * chat-style streaming of the reply; reconcile with the final `transcript`
	 * (on interruption the tail may never be spoken). May be dropped under
	 * backpressure.
	 */
	ttschunk: TtsChunkEvent;
}

/** Payload of a `tts` realtime event. */
export interface TtsChunkEvent {
	/** Sentence-level text chunk of the agent's reply. */
	text: string;
	/** Unix timestamp from the bot (seconds, fractional). */
	timestamp: number;
	/** Full raw event payload (character counts, TTS timing metrics…). */
	data: Record<string, unknown>;
}

/** Payload of a `tts_word` realtime event. */
export interface TtsWordEvent {
	/** The spoken word. */
	word: string;
	/** Presentation timestamp — when the word is spoken in the audio (ms), if known. */
	ptsMs: number | null;
	/** Unix timestamp from the bot (seconds, fractional). */
	timestamp: number;
	/** Full raw event payload. */
	data: Record<string, unknown>;
}

export type CallEndReason =
	| 'local-hangup'
	| 'peer-left'
	| 'terminal-status'
	| 'external';

export type TalkifCallErrorCode =
	| 'media-unavailable'
	| 'signaling-failed'
	| 'connection-failed'
	| 'pipeline-dead'
	| 'renegotiation-failed'
	/** Publishable key rejected, origin not allowed, or session expired. */
	| 'session-rejected'
	/** This session already has an active call (multi-tab). */
	| 'call-active'
	/** Rate/concurrency limit hit — retry later. */
	| 'rate-limited'
	/** No bot available right now — retry shortly. */
	| 'no-agent';

export class TalkifCallError extends Error {
	readonly code: TalkifCallErrorCode;
	override readonly cause?: unknown;

	constructor(code: TalkifCallErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = 'TalkifCallError';
		this.code = code;
		this.cause = cause;
	}
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Supplies the Authorization header value for signaling requests.
 * Called per request so short-lived tokens (JWT refresh, widget session
 * tokens) stay current. Return e.g. `"Bearer <token>"`.
 */
export type AuthProvider = () => string | Promise<string>;

export interface TalkifClientConfig {
	/** API origin, e.g. `https://api.talkif.ai`. No trailing slash. */
	baseUrl: string;
	accountId: string;
	auth: AuthProvider;
	/** Override fetch (tests, SSR polyfills). Defaults to global fetch. */
	fetch?: typeof fetch;
}

/**
 * Public (embeddable) configuration: the browser-safe publishable key from the
 * flow's public-access settings. The library exchanges it for a short-lived
 * session token itself — no bearer token, no account id. The page's Origin
 * must be on the key's allowlist.
 */
export interface TalkifPublicClientConfig {
	/** API origin, e.g. `https://api.talkif.ai`. No trailing slash. */
	baseUrl: string;
	/** Publishable key (`pk_live_...`) — safe to ship in page source. */
	publishableKey: string;
	/**
	 * Cloudflare Turnstile sitekey (Talkif's — public, safe to ship). When set,
	 * the library renders an invisible Turnstile challenge and produces a token
	 * for each session exchange automatically. Leave unset to disable the gate
	 * (dev/local, or before Turnstile is provisioned).
	 */
	turnstileSiteKey?: string;
	/**
	 * Manual Turnstile token supplier. Overrides `turnstileSiteKey` — supply
	 * this only if you render Turnstile yourself. Called at each exchange.
	 */
	turnstileToken?: () => string | Promise<string>;
	/** Override fetch (tests, SSR polyfills). Defaults to global fetch. */
	fetch?: typeof fetch;
}

export type TalkifConfig = TalkifClientConfig | TalkifPublicClientConfig;

export function isPublicConfig(config: TalkifConfig): config is TalkifPublicClientConfig {
	return 'publishableKey' in config;
}

export interface StartCallOptions {
	/**
	 * Start a call against a published flow. Required in authenticated mode.
	 * Ignored in public mode — the flow is bound to the publishable key.
	 */
	flowId?: string;
	/**
	 * When set, uses the draft test-call endpoint with this definition instead
	 * of the published flow.
	 */
	draftDefinition?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	/** Constraints for getUserMedia. Defaults to `{ audio: true }`. */
	audio?: MediaTrackConstraints | boolean;
	/**
	 * Attach remote audio to this element instead of an internally created
	 * autoplay `Audio()`. Pass `null` to disable playback entirely (consumer
	 * handles the `track` event itself).
	 */
	audioElement?: HTMLAudioElement | null;
}
