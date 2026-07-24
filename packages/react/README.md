# @talkif/webrtc-react

Headless React bindings for [`@talkif/webrtc`](https://www.npmjs.com/package/@talkif/webrtc) — talk to [Talkif](https://talkif.ai) AI voice agents over WebRTC from React.

```bash
npm install @talkif/webrtc @talkif/webrtc-react
```

```tsx
import { useTalkifCall } from '@talkif/webrtc-react';

function CallWidget() {
  const { state, durationSecs, muted, start, hangup, toggleMute } = useTalkifCall({
    config: { baseUrl: 'https://api.talkif.ai', publishableKey: 'pk_live_...' },
    onTranscript: ({ role, content }) => console.log(role, content),
    onTtsChunk: ({ text }) => console.log('agent (streaming):', text),
  });

  return state === 'connected' ? (
    <>
      <span>{durationSecs}s</span>
      <button onClick={toggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
      <button onClick={hangup}>Hang up</button>
    </>
  ) : (
    <button onClick={() => start({})} disabled={state !== 'idle' && state !== 'ended' && state !== 'error'}>
      Start call
    </button>
  );
}
```

`useTalkifCall` returns `{ state, callId, botId, error, durationSecs, muted, call, start, hangup, toggleMute, sendAppMessage }`. Callbacks: `onAppMessage`, `onCallEvent`, `onTranscript`, `onTtsWord`, `onTtsChunk`, `onEnded`, `onError`. One active call at a time; unmount tears everything down (mic, peer connection, timers).

Full documentation — config modes (authenticated vs public embed), the complete event reference, and error codes — lives in the [`@talkif/webrtc` README](https://www.npmjs.com/package/@talkif/webrtc) and the [GitHub repository](https://github.com/Talkif-ai/webrtc-js).

## License

MIT
