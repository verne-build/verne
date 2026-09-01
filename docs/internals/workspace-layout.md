# Workspace layout

> For maintainers. Using Verne? See [docs/user](../user/).

A pnpm workspace driven by [vite-plus](https://vite.plus) (`vp`). See [scripts.md](./scripts.md) for
the task commands.

## apps

- `apps/server` (`@verne-build/cli`): the execution runtime and the published CLI. Owns orchestration, provider
  drivers, checkpointing, VCS, terminals, filesystem access, auth, and the HTTP + WebSocket surface.
  Also serves the built web app.
- `apps/web` (`@t3tools/web`): React + Vite UI. Consumes the shared client runtime and adds routing,
  components, and web-specific platform layers.
- `apps/desktop` (`@t3tools/desktop`): Electron shell. Supervises a desktop-scoped Verne backend,
  loads the web bundle over the `verne://` protocol, and owns SSH-managed remote environments.
- `apps/mobile` (`@t3tools/mobile`): Expo/React Native client. Same client runtime composition as
  web, different platform layer and UI.
- `apps/verne-marketing` (`@verne-build/marketing`): deployed Astro site for `verne.build`, including
  the generated Verne project schema.
- `apps/marketing` (`@t3tools/marketing`): dormant upstream Astro/Vercel site retained as reference;
  Verne does not deploy it.

## packages

- `packages/contracts` (`@t3tools/contracts`): shared Effect Schema definitions. RPC group,
  orchestration commands/events/read model, auth scopes, environment descriptors, settings.
- `packages/shared` (`@t3tools/shared`): framework-agnostic utilities used by server and clients
  (`DrainableWorker`, git and source-control helpers, relay auth and signing, DPoP, semver, logging,
  observability, and more).
- `packages/client-runtime` (`@t3tools/client-runtime`): connection lifecycle, authorization, RPC
  session, environment registry, and Atom-based domain state shared by web and mobile. See its
  [README](../../packages/client-runtime/README.md).
- `packages/ssh` (`@t3tools/ssh`): SSH config parsing, auth prompts, command execution, and the
  tunnel/environment manager behind desktop-managed SSH environments.
- `packages/tailscale` (`@t3tools/tailscale`): Tailscale CLI wrapper, including the
  `ensureTailscaleServe` / `disableTailscaleServe` serve lifecycle the server drives.
- `packages/effect-acp` (`effect-acp`): Effect client and agent implementation of the Agent Client
  Protocol, used by ACP-speaking provider drivers.
- `packages/effect-codex-app-server` (`effect-codex-app-server`): Effect client for the
  `codex app-server` JSON-RPC protocol.

## infra

- `infra/verne-cloudflare` (`@verne-build/cloudflare`): Verne-owned Cloudflare Worker sources and
  exact-pinned deployment entry points for hosted web channels, previews, and channel routing.
- `infra/relay` (`t3code-relay`): dormant inherited managed-relay implementation, deployable manually with Alchemy. Handles
  environment discovery, cloud-side records, and mobile notifications. It is not in the hot path;
  after connect, client traffic goes directly to the environment. See
  [t3-connect.md](./t3-connect.md).

## Other top-level directories

- `scripts/`: workspace tooling run through `vp run`. Dev runner, desktop artifact builds, release
  helpers, mobile static checks and showcase capture, update-manifest merging.
- `assets/`: brand and app icon sources per channel (`dev`, `nightly`, `prod`).
- `patches/`: pnpm patches for pinned upstream dependencies.
- `oxlint-plugin-t3code/`: repo-specific lint rules.
- `experiments/`: throwaway prototypes. Not part of the shipped build.
- `docs/`: this documentation tree.

## Import conventions

`@t3tools/shared` and `@t3tools/client-runtime` use explicit subpath exports with no barrel index and
no root export. Import the narrow path (`@t3tools/shared/DrainableWorker`,
`@t3tools/client-runtime/state/threads`) rather than the package root. Files that are not exported
are implementation details. `@t3tools/contracts` does export a root alongside `./settings` and
`./relay`.
