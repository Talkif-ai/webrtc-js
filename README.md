# Talkif WebRTC JS

Browser client libraries for talking to [Talkif](https://talkif.ai) AI voice agents over WebRTC.

| Package | Description |
|---|---|
| [`@talkif/webrtc`](packages/core) | Framework-agnostic core: signaling, peer connection, audio, data-channel protocol |
| [`@talkif/webrtc-react`](packages/react) | Headless React hook (`useTalkifCall`) on top of the core |

## Quick start (core)

```ts
import { TalkifCall } from '@talkif/webrtc';

const call = new TalkifCall({
  baseUrl: 'https://api.talkif.ai',
  accountId: '<account-id>',
  auth: async () => `Bearer ${await getToken()}`,
});

call.on('connected', ({ callId }) => console.log('live', callId));
call.on('appmessage', ({ message }) => console.log('bot says', message));
call.on('ended', ({ reason }) => console.log('ended', reason));
call.on('error', ({ error }) => console.error(error.code, error.message));

await call.start({ flowId: '<published-flow-id>' });

// later
call.setMuted(true);
call.hangup();
```

## Quick start (React)

```tsx
import { useTalkifCall } from '@talkif/webrtc-react';

function CallButton({ config, flowId }) {
  const { state, durationSecs, muted, start, hangup, toggleMute } = useTalkifCall({ config });

  return state === 'connected' ? (
    <>
      <span>{durationSecs}s</span>
      <button onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
      <button onClick={hangup}>Hang up</button>
    </>
  ) : (
    <button onClick={() => start({ flowId })} disabled={state === 'requesting' || state === 'connecting'}>
      Start call
    </button>
  );
}
```

## What the core handles for you

- **Signaling** against the Talkif API: call creation (published or draft flows), TURN credential fetch, SDP offer/answer relay.
- **Fast connect**: relay-only ICE with first-relay-candidate dispatch (no 5s+ gathering stalls), bot warmup runs in parallel with local media setup.
- **Data-channel protocol** spoken by Talkif bots: keepalive pings, `peerLeft` teardown, bot-initiated renegotiation, arbitrary JSON app messages both ways.
- **Health watchdog**: if no health signal arrives after connect, call liveness is verified over REST before anything is torn down — a silent event stream never kills a healthy call.
- **Deterministic teardown**: microphone, audio element, timers, and the peer connection are always released on hangup/error/dispose.

## What it deliberately does not do

- No UI. Both packages are headless; bring your own components.
- No transcript/state store. Subscribe to events (`appmessage`, `tick`, `statechange`) and feed whatever store you use.
- No auth. You supply an `auth` provider returning the `Authorization` header value; the library never persists credentials.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm type-check
```

Requires Node ≥ 20 and pnpm ≥ 10.
