# CLAUDE.md — webrtc-js

Browser SDK monorepo: `@talkif/webrtc` (core, `packages/core`) and `@talkif/webrtc-react`
(headless hook, `packages/react`). pnpm workspaces + Turborepo. **This repo is PUBLIC**
(github.com/Talkif-ai/webrtc-js) — no internal service names, infra details, or NATS
subjects in code, comments, or docs. Public API surfaces only.

## Commands

```bash
pnpm install
pnpm build        # tsup, both packages (react needs core's dist — build before type-check)
pnpm test         # vitest (core only)
pnpm type-check
```

## Releasing to npm

**Publishing happens ONLY when a `v*` tag is pushed** — `.github/workflows/release.yml`
builds, tests, and publishes both packages (core first; react peer-depends on it).
Pushes to `main` run tests only (`ci.yml`), never publish.

```bash
# 1. bump "version" in packages/core/package.json AND packages/react/package.json
git commit -am "release: vX.Y.Z" && git push
git tag vX.Y.Z && git push origin vX.Y.Z   # ← this triggers the publish
```

Rules:
- Bump first, tag second — npm rejects re-publishing an existing version (versions are immutable).
- Keep both package versions in lockstep with the tag.
- Use `pnpm publish` semantics everywhere (the workflow does): it rewrites the react
  package's `"@talkif/webrtc": "workspace:^"` peer dep to a real semver. `npm publish`
  would ship the literal `workspace:^` and break installs.
- Releases publish with `--provenance` (linked to the exact commit + workflow run).

Auth: `NPM_TOKEN` repo secret (granular token, `@talkif` scope, bypass-2FA).
TODO: switch both packages to npm Trusted Publishing (OIDC) and delete the token —
then remove `NODE_AUTH_TOKEN` from release.yml (`id-token: write` is already set).

## Gotchas

- `pnpm/action-setup@v4` must NOT pin a version in the workflows — it reads
  `packageManager` from package.json; specifying both is a hard error.
- Per-package `README.md` files are what npm renders (tarball is `files: ["dist"]`
  + README/LICENSE auto-included). Core's README is a copy of the root one — update both.
- Realtime events (`transcript`, `interim`, `ttschunk`, `ttsword`, `callevent`) exist in
  public (publishable-key) mode only. `ttschunk`/`interim`/`ttsword` are droppable under
  backpressure; the final `transcript` is authoritative.
- No fallback code paths (e.g. "prefer X, fall back to Y" rendering sources) — pick the
  single correct event/source for a use case.
