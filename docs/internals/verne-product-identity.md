# Verne product identity

## Goal

Present this fork as Verne on every user-facing surface and give it an independent physical
identity. Verne uses its own CLI, application IDs, protocols, state paths, databases, storage keys,
release artifacts, and public domains. When a Verne state owner is still empty, it imports the
corresponding T3 Code state where the platform makes that possible. Credit T3 Code in the README,
legal copy, migration UI, and other provenance surfaces instead of carrying its name through the
product UI.

Verne remains a single product. The repository does not need a general-purpose build system that
can produce either T3 Code or Verne.

## Brand seam

A small product-brand module owns reusable visible identity, including the base name `Verne` and
display-name formatting for development, preview, nightly, and release channels. Web, desktop, and
mobile consume that identity where their build tools permit. Static manifests and prose use the
same values by convention and focused tests keep them aligned.

The brand applies to:

- app, window, menu, notification, and accessibility labels;
- web metadata, install surfaces, permission descriptions, and release labels;
- README and user documentation;
- Verne-owned icons, wordmarks, and other product assets.

Names for an upstream service or another organization stay accurate. Verne does not relabel a
T3-hosted endpoint or a T3 Code compatibility format as a Verne-operated service.

## Product identity map

Verne is not yet released, so new installations do not need operational aliases for T3 Code.
Legacy names exist only at migration and project-import boundaries, in accurate upstream
attribution, or when naming a service still operated by T3. Private workspace package scopes and
upstream-shaped source symbols stay unchanged to keep upstream integrations reviewable.

| Identity                   | Verne behavior                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CLI package and command    | Publish `@verne-build/cli`; install and document the `verne` binary                                                      |
| Default state paths        | Use `~/.verne` for user state and `.verne` for worktree development state                                                |
| Project files              | Prefer `verne.json`; accept and continue writing an existing `t3.json` as legacy project input                           |
| Project schema             | Generate `verne.json` with `https://verne.build/schema/verne.json`; retain the existing schema URL inside `t3.json`      |
| Environment variables      | Use `VERNE_*`; do not retain `T3CODE_*` as operational aliases                                                           |
| Deep links                 | Use `verne:`, `verne-dev:`, and `verne-preview:` without operational `t3code:` aliases                                   |
| Persisted client state     | Use Verne-prefixed keys and import legacy state only when the corresponding Verne store is uninitialized                 |
| Database and data paths    | Use Verne names and automatically import supported state from T3 Code paths into an empty Verne destination              |
| Bundle and application IDs | Use `build.verne.app`, `build.verne.app.dev`, and `build.verne.app.preview`, plus product-specific extension suffixes    |
| Public web                 | Use `https://verne.build` and `https://app.verne.build`                                                                  |
| Wire contracts             | Keep existing protocol fields and values unless they expose visible product copy                                         |
| Telemetry                  | Report Verne as the product and use a new Verne installation identity                                                    |
| Internal names             | Keep private `@t3tools/*` scopes, upstream-shaped source symbols, CSS hooks, and fixtures unless they become user-facing |

[Verne project file compatibility](verne-project-file-compatibility.md) defines project-file
precedence and failure behavior in detail.

## Migration rules

Each state owner checks its destination before normal initialization. When that destination is
uninitialized, it may import the corresponding T3 Code state. Migration never merges into populated
Verne state and never modifies the source.

The server and CLI import supported settings, secrets, registered projects, and thread history from
`~/.t3` into `~/.verne`. Desktop imports supported application settings into the new Verne desktop
data directory. Web imports a legacy browser store only when the corresponding Verne store has not
been initialized. Checked-in `t3.json` remains readable as legacy project input.

Migration uses a staging destination and a consistent SQLite backup mechanism, validates the staged
state, atomically installs it, and records a receipt. Existing Verne state always wins. Repeating a
completed migration is a no-op; retrying an interrupted migration produces the same result.
Migration errors leave both source and destination intact, do not block startup, and emit a focused
diagnostic.

The new mobile bundle IDs cannot read another application's iOS or Android sandbox. Verne therefore
does not promise automatic import of legacy mobile-only credentials or preferences. Projects and
threads migrated by a server become available to mobile after manual pairing with that server.

## Runtime inputs

New runtime inputs use Verne names only. Verne does not accept legacy CLI commands, environment
variables, or deep-link schemes as aliases. Legacy identifiers are read only by explicit migration
boundaries and project-file selection. This prevents migrated state from turning into a permanent
second product configuration model.

The published CLI package is `@verne-build/cli` and exposes `verne`, including commands such as
`verne pair` and `verne service update`. Remote server updates install the exact matching Verne CLI
package version before a client release becomes available.

## Distribution and hosted services

Desktop releases and Electron update metadata are published to GitHub Releases in
`verne-build/verne`. A dedicated download page on `verne.build` is deferred until the real site is
built; for now, users obtain the `.dmg`, `.exe`, and `.AppImage` assets directly from GitHub Releases.
Verne does not operate a custom desktop update service.

The hosted client uses separate `latest.app.verne.build` and `nightly.app.verne.build` channel
Workers behind `app.verne.build`. The router defaults to latest and uses the `verne_web_channel`
cookie to preserve a user's selection; `GET /__verne/channel?channel=latest|nightly` updates that
selection and redirects to the hosted app root. The project schema is served from
`verne.build/schema/verne.json` by the independent Verne marketing site.

Mobile uses a new Verne-owned Expo/EAS project, project ID, update endpoint, bundle IDs, and store
records. Download pages must not link to T3 Code store listings; Verne store actions remain absent or
unavailable until their real URLs exist.

The initial product does not ship account, Clerk, T3 Connect, or relay flows. Users connect to
remote servers manually with the existing pair-code workflow. Provider adapters remain unchanged.

## Surfaces

Brand work must account for all applicable clients:

- Web and the Electron-rendered web UI share product copy and visual assets.
- Desktop also owns native menus, window identity, protocols, packaging, updates, and OS metadata.
- Mobile owns native app metadata, permission descriptions, deep links, widgets, notifications, and
  React Native accessibility labels.
- Server and shared packages own project-file discovery, environment compatibility, data paths, CLI
  behavior, and values that cross the wire.
- Marketing, README, user docs, and release automation describe the shipped Verne product, use
  Verne-owned destinations, and retain concise upstream attribution.

Provider names and behavior do not change as part of branding.

## Verification

Use focused tests for each changed boundary:

- brand constants and channel display names;
- `verne.json` and `t3.json` precedence, invalid files, schema URLs, and write-back behavior;
- Verne environment variables and rejection or non-use of obsolete aliases;
- generation and handling of Verne deep-link schemes;
- fresh state, legacy import into an empty destination, populated Verne state, interrupted import,
  repeated migration, validation failure, and SQLite consistency;
- CLI package publication, `verne` invocation, service installation, and exact-version self-update;
- desktop and mobile manifests, packaging labels, permission copy, and accessibility labels;
- GitHub update repository selection, release artifact names, hosted app URLs, and links to GitHub Releases;
- manual pairing with account and T3 Connect entry points disabled;
- static checks that prevent visible T3 Code copy from returning outside approved attribution and
  migration contexts.

Run targeted typechecks and tests for affected packages. Browser and simulator verification remain
an explicit maintainer choice because they launch interactive clients.

## Upstream maintenance

Keep Verne-specific code in the brand module, compatibility resolvers, migration boundaries, assets,
and static product metadata. Avoid renaming unrelated upstream internals. During an upstream sync,
classify each new T3 Code occurrence as visible product copy, an accurate upstream reference, a
compatibility identifier, or an internal implementation name before changing it.
