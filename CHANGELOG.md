# Changelog

All notable changes to `@talkif/webrtc` and `@talkif/webrtc-react` are documented here.
Both packages are versioned in lockstep; one entry covers both.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] — 2026-09-15

### Fixed

- `hangup()` or `dispose()` called while `start()` was still awaiting call creation or
  the SDP exchange was undone by `start()` resuming: the call went `ended → connecting →
  connected` with a live microphone. `start()` now checks after every await whether the
  call was ended/disposed, releases the freshly acquired mic and peer connection, and
  returns without changing state or throwing. ([#3](https://github.com/Talkif-ai/webrtc-js/issues/3))
- `hangup()` and `dispose()` now tell the API the call ended (`POST .../calls/{id}/end`)
  so the agent stops immediately instead of after the media connection times out. This
  is best-effort and needs API support; older API versions simply ignore it.

## [0.1.4] — 2026-09-11

### Changed

- Authenticated mode signals through root-scoped routes (`/api/v1/calls/webrtc/...`) and
  sends the account via the `X-Account-Id` header. API keys imply the account; JWT users
  must set `accountId` in the config.
- Data channel renamed to `talkif`.

## [0.1.3] — 2026-09-10

### Fixed

- A transient `disconnected` peer-connection state no longer ends the call immediately:
  a grace period (4 s for `disconnected`, 1.5 s for `failed`) lets the connection recover
  or the realtime `ENDED` status win the race.
- The realtime `ENDED` pipeline status ends the call cleanly (`ended`, reason
  `external`) instead of surfacing as an error.

### Changed

- Releases are published to npm with provenance via Trusted Publishing (OIDC).

## [0.1.2] — 2026-07-26

### Fixed

- Realtime events are subscribed before the media handshake so nothing the agent says
  first is missed; the subscription always replays buffered events.
- Accept `ptsMs` in camelCase on `ttsword` events.

## [0.1.1] — 2026-07-24

### Changed

- Per-package READMEs so npm renders documentation for each package.

## [0.1.0] — 2026-07-24

### Added

- Initial release: `@talkif/webrtc` core client (`TalkifCall`) with authenticated and
  publishable-key modes, realtime transcript/TTS/call events, mute, data-channel app
  messages; `@talkif/webrtc-react` headless `useTalkifCall` hook.

[Unreleased]: https://github.com/Talkif-ai/webrtc-js/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/Talkif-ai/webrtc-js/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Talkif-ai/webrtc-js/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Talkif-ai/webrtc-js/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Talkif-ai/webrtc-js/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Talkif-ai/webrtc-js/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Talkif-ai/webrtc-js/releases/tag/v0.1.0
