# Talkif WebRTC JS

Browser client libraries for talking to [Talkif](https://talkif.ai) AI voice agents over WebRTC.

| Package | Description |
|---|---|
| [`@talkif/webrtc`](packages/core) | Framework-agnostic core: signaling, peer connection, audio, data-channel protocol, realtime events |
| [`@talkif/webrtc-react`](packages/react) | Headless React hook (`useTalkifCall`) on top of the core |

Both packages are headless — no UI ships with them. Requires a browser with WebRTC and microphone access; the React package needs React ≥ 18.

## Installation

```bash
npm install @talkif/webrtc
# React bindings (peer-depends on @talkif/webrtc)
npm install @talkif/webrtc-react
```

## Two modes

The libraries speak to the Talkif API in one of two modes, chosen by the config shape you pass:

**Authenticated mode** — for your own dashboard or backend-authenticated apps. You supply the account id and an `auth` provider returning the `Authorization` header value. Call any published flow, or test a draft flow definition.

```ts
const config = {
  baseUrl: 'https://api.talkif.ai',
  accountId: '<account-id>',
  auth: async () => `Bearer ${await getToken()}`,
};
```

**Public (embed) mode** — for widgets on any web page. You ship only a publishable key (`pk_live_...`, safe in page source); the library exchanges it for a short-lived session token itself. The page's origin must be on the key's allowlist, the flow is bound to the key, and realtime call events (transcripts, word timing, speaking indicators) stream over an events WebSocket.

```ts
const config = {
  baseUrl: 'https://api.talkif.ai',
  publishableKey: 'pk_live_...',
};
```

If the flow's bot gate is active, the library handles the Cloudflare Turnstile challenge invisibly — no setup needed. To supply your own token instead, pass `turnstileToken: () => Promise<string>`.

## Quick start (core)

```ts
import { TalkifCall } from '@talkif/webrtc';

const call = new TalkifCall(config);

call.on('connected', ({ callId }) => console.log('live', callId));
call.on('transcript', ({ role, content }) => console.log(role, content));
call.on('ended', ({ reason }) => console.log('ended', reason));
call.on('error', ({ error }) => console.error(error.code, error.message));

await call.start({ flowId: '<published-flow-id>' }); // flowId ignored in public mode

// later
call.setMuted(true);
call.hangup();
```

### `TalkifCall` API

| Member | Description |
|---|---|
| `start(options)` | Request mic, create the call, connect. `options`: `flowId`, `draftDefinition` (authenticated test calls), `metadata`, `audio` (getUserMedia constraints), `audioElement` (your own `<audio>`, or `null` to handle the `track` event yourself) |
| `hangup()` | End the call locally. Always safe to call. |
| `dispose()` | Tear everything down (mic, peer connection, timers, listeners). Instances are single-use. |
| `setMuted(muted)` | Toggle the local microphone track. |
| `sendAppMessage(json)` | Send an arbitrary JSON message to the bot over the data channel. Returns `false` if the channel isn't open. |
| `on(event, fn)` / `off(event, fn)` | Subscribe / unsubscribe. `on` returns an unsubscribe function. |
| `state`, `callId`, `botId`, `muted`, `durationSecs` | Current snapshot getters. |

State machine: `idle → requesting → connecting → connected → ended` (or `error`).

### Events

| Event | Payload | When |
|---|---|---|
| `statechange` | `{ state, previous }` | Every state transition |
| `connected` | `{ callId, botId }` | Media flowing, answer applied |
| `track` | `{ stream }` | Remote (bot) audio track arrived |
| `tick` | `{ durationSecs }` | Once per second while connected |
| `mutechange` | `{ muted }` | Mute toggled |
| `appmessage` | `{ message }` | JSON from the bot over the data channel |
| `renegotiated` | `{ ok }` | Bot-initiated renegotiation attempted |
| `ended` | `{ reason }` | `local-hangup` \| `peer-left` \| `terminal-status` \| `external` |
| `error` | `{ error: TalkifCallError }` | Fatal failure; call is torn down |

**Realtime call events** (public mode — delivered over the events WebSocket):

| Event | Payload | Notes |
|---|---|---|
| `transcript` | `{ role, content, data }` | Final transcript line for a turn. On interruption, `content` includes text synthesized but never spoken. |
| `interim` | `{ data }` | Caller's in-progress transcription. Droppable under backpressure. |
| `ttschunk` | `{ text, timestamp, data }` | Sentence-level chunk of the agent's reply, emitted when the LLM output reaches synthesis — ahead of audio playback. Droppable. |
| `ttsword` | `{ word, ptsMs, timestamp, data }` | Word-level timing at playback pace (karaoke-style captions). Only words actually spoken. Droppable. |
| `callevent` | `{ event }` | Every delivered envelope, including types without a dedicated event (`speech`, `turn`, `node_transition`, `status`, `error`). |

"Droppable" events may be shed by the server under backpressure; the final `transcript` is authoritative — reconcile incremental displays against it.

### Errors

`error.code` on `TalkifCallError`:

| Code | Meaning |
|---|---|
| `media-unavailable` | Microphone denied or unavailable |
| `signaling-failed` | Call creation / SDP exchange failed |
| `connection-failed` | ICE/peer connection failed |
| `pipeline-dead` | Connected, but the bot pipeline never became healthy |
| `renegotiation-failed` | Bot-requested renegotiation failed |
| `session-rejected` | Publishable key rejected, origin not allowed, or session expired |
| `call-active` | This session already has an active call (another tab) |
| `rate-limited` | Rate/concurrency limit hit — retry later |
| `no-agent` | No agent available right now — retry shortly |

## Quick start (React)

```tsx
import { useTalkifCall } from '@talkif/webrtc-react';

function CallWidget({ config }) {
  const { state, durationSecs, muted, start, hangup, toggleMute } = useTalkifCall({
    config,
    onTranscript: ({ role, content }) => console.log(role, content),
    onTtsChunk: ({ text }) => console.log('agent (streaming):', text),
    onEnded: (reason) => console.log('ended', reason),
    onError: (error) => console.error(error.code),
  });

  return state === 'connected' ? (
    <>
      <span>{durationSecs}s</span>
      <button onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
      <button onClick={hangup}>Hang up</button>
    </>
  ) : (
    <button onClick={() => start({})} disabled={state === 'requesting' || state === 'connecting'}>
      Start call
    </button>
  );
}
```

`useTalkifCall` returns `{ state, callId, botId, error, durationSecs, muted, call, start, hangup, toggleMute, sendAppMessage }`. Callbacks: `onAppMessage`, `onCallEvent`, `onTranscript`, `onTtsWord`, `onTtsChunk`, `onEnded`, `onError`. One active call at a time — starting a new call disposes the previous one, and unmount tears everything down (mic, peer connection, timers).

## What the core handles for you

- **Signaling** against the Talkif API: call creation (published or draft flows), TURN credential fetch, SDP offer/answer relay, public session token exchange and refresh.
- **Fast connect**: relay-only ICE with first-relay-candidate dispatch (no 5s+ gathering stalls), bot warmup runs in parallel with local media setup.
- **Data-channel protocol** spoken by Talkif bots: keepalive pings, `peerLeft` teardown, bot-initiated renegotiation, arbitrary JSON app messages both ways.
- **Realtime events** (public mode): WebSocket with auto-reconnect, backoff, and server-side replay after a gap — a dropped connection never loses call history.
- **Health watchdog**: if no health signal arrives after connect, call liveness is verified over REST before anything is torn down — a silent event stream never kills a healthy call.
- **Deterministic teardown**: microphone, audio element, timers, and the peer connection are always released on hangup/error/dispose.

## What it deliberately does not do

- No UI. Both packages are headless; bring your own components.
- No transcript/state store. Subscribe to events and feed whatever store you use.
- No auth storage. You supply an `auth` provider (or a publishable key); the library never persists credentials.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm type-check
```

Requires Node ≥ 20 and pnpm ≥ 10.

## License

[MIT](LICENSE)
