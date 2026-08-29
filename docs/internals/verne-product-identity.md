# Verne product identity

## Goal

Present this fork as Verne on every user-facing surface while preserving access to projects,
settings, links, and installations created by T3 Code. Credit T3 Code in the README, legal copy,
and other provenance surfaces instead of carrying its name through the product UI.

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

## Compatibility identity

Verne introduces aliases and migrations only where users benefit from them. Low-level renaming
adds migration risk and makes upstream syncs harder without changing the product experience.

| Identity                   | Verne behavior                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Project files              | Prefer `verne.json`; accept and continue writing an existing `t3.json`                                              |
| Environment variables      | Prefer `VERNE_*`; fall back to matching `T3CODE_*` variables                                                        |
| Deep links                 | Generate `verne:` links; accept `verne:` and `t3code:`                                                              |
| Persisted client state     | Use Verne keys for new state and import missing state from T3 Code keys                                             |
| Database and data paths    | Use Verne names for fresh installs and adopt legacy data through a tested migration                                 |
| Package and CLI names      | Offer Verne-facing names while retaining the existing `t3` command where compatibility requires it                  |
| Bundle and application IDs | Use Verne IDs only when the platform can transfer or import legacy application data safely                          |
| Wire contracts             | Keep existing protocol fields and values unless they expose visible product copy                                    |
| Telemetry                  | Report Verne as the product while retaining stable installation continuity                                          |
| Internal names             | Keep package scopes, CSS hooks, test fixtures, and internal symbols unless a user-facing alias needs them to change |

[Verne project file compatibility](verne-project-file-compatibility.md) defines project-file
precedence and failure behavior in detail.

## Migration rules

Each client checks for legacy T3 Code state when Verne has no corresponding state. The migration
copies or translates values, records completion, and leaves the source untouched. Existing Verne
values win; legacy values fill only missing fields. Repeating an interrupted or completed migration
must produce the same result.

Platform sandboxes may prevent one application identity from reading another application's data.
In that case, keep the compatible identity until Verne has a tested transfer path, or provide an
explicit import flow. Do not ship a new bundle ID with an unverified claim that existing settings,
connections, or threads transfer automatically.

Migration errors must not damage Verne state or block startup. Report the failed operation with
enough context to diagnose it and allow a safe retry.

## Precedence and conflicts

Verne identity wins when both forms specify the same setting:

1. Use the Verne value when present.
2. Otherwise use the T3 Code value.
3. Otherwise use the existing default.

When both values exist and disagree, use the Verne value and expose a focused diagnostic where the
repository already reports configuration problems. Do not spread conflict handling through feature
components; keep it beside the resolver for that identity.

## Surfaces

Brand work must account for all applicable clients:

- Web and the Electron-rendered web UI share product copy and visual assets.
- Desktop also owns native menus, window identity, protocols, packaging, updates, and OS metadata.
- Mobile owns native app metadata, permission descriptions, deep links, widgets, notifications, and
  React Native accessibility labels.
- Server and shared packages own project-file discovery, environment compatibility, data paths, CLI
  behavior, and values that cross the wire.
- Marketing, README, user docs, and release automation describe the shipped Verne product and retain
  concise upstream attribution.

Provider names and behavior do not change as part of branding.

## Verification

Use focused tests for each changed boundary:

- brand constants and channel display names;
- `verne.json` and `t3.json` precedence, invalid files, and write-back behavior;
- Verne-only, T3-only, matching, and conflicting environment variables;
- generation of `verne:` links and handling of both deep-link schemes;
- fresh state, legacy import, partial Verne state, repeated migration, and migration failure;
- desktop and mobile manifests, packaging labels, permission copy, and accessibility labels;
- static checks that prevent visible T3 Code copy from returning outside approved attribution and
  compatibility contexts.

Run targeted typechecks and tests for affected packages. Browser and simulator verification remain
an explicit maintainer choice because they launch interactive clients.

## Upstream maintenance

Keep Verne-specific code in the brand module, compatibility resolvers, migration boundaries, assets,
and static product metadata. Avoid renaming unrelated upstream internals. During an upstream sync,
classify each new T3 Code occurrence as visible product copy, an accurate upstream reference, a
compatibility identifier, or an internal implementation name before changing it.
