# Verne release versioning and upstream provenance

Verne is a product fork of T3 Code. Product versions identify Verne releases; upstream T3 Code
versions identify the source boundary incorporated by a Verne build. These values are related, but
they have different jobs and must never be substituted for one another.

## Version model

Verne uses two release trains:

- **Verne core** covers the CLI and background server, server-hosted and hosted web clients,
  Electron desktop app, and wire contracts. These surfaces share one coordinated SemVer version.
- **Verne Mobile** has its own user-facing app version and platform build numbers. App Store and Play
  Store review cycles, native runtime compatibility, and Expo updates make mobile an independent
  release train.

The first coordinated Verne core release is `0.2.0`. The first Verne Mobile release line is `0.1.0`.
Versions below those boundaries already present in npm or GitHub are inherited or bootstrap history:

- `@verne-build/cli` versions `0.0.35` through `0.0.37` bootstrapped the renamed server and manual
  pairing path before the coordinated release model existed.
- GitHub releases through `v0.1.15` predate the Verne rewrite.

These historical versions remain valid immutable records. They do not determine future Verne
version numbers, and the first coordinated release must sort after all of them.

## Canonical version sources

The core version stays in the existing releasable package manifests:

- `apps/server/package.json`
- `apps/desktop/package.json`
- `apps/web/package.json`
- `packages/contracts/package.json`

`scripts/update-release-package-versions.ts` updates these files together and rejects partial
release preparation through its tests. A checked-in core version describes the next coordinated
Verne build; it does not publish anything by itself.

Mobile keeps its user-facing version in `apps/mobile/app.config.ts`. EAS owns the monotonically
increasing iOS and Android build identifiers. The mobile package manifest remains private workspace
metadata and is not a third product version.

## Build identity

Every diagnosable build has four identity fields:

| Field            | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| Verne version    | Core or mobile product version used by that surface                      |
| Verne revision   | Exact Verne Git commit used to produce the build                         |
| T3 Code version  | Human-readable upstream version at the recorded synchronization boundary |
| T3 Code revision | Exact upstream T3 Code commit incorporated by the fork                   |

The T3 Code revision is authoritative. The version is a label read from upstream release metadata
or the upstream server package at that revision. Verne can synchronize between T3 releases, so the
label must not imply that the fork exactly matches an upstream release tree.

Committed upstream provenance lives at `config/verne-upstream.json`:

```json
{
  "schemaVersion": 1,
  "product": "T3 Code",
  "repository": "pingdotgg/t3code",
  "version": "0.0.37",
  "revision": "b883fc066ea5c9bebbe1c3e9b4bc2471aab3685f"
}
```

An upstream synchronization updates this file in the same integration change as the upstream merge.
Build tooling validates its schema and embeds it alongside the Verne revision supplied by the build
environment. Local development may report the Verne revision as `dirty` or `unknown`; publishable
artifacts must have an exact revision and valid committed upstream provenance.

Release and preview automation sets `VERNE_RELEASE_BUILD=1` and supplies `VERNE_REVISION` (or uses
the exact Git revision supplied by GitHub Actions/EAS). Build configuration rejects a publishable
artifact when that revision is missing or malformed instead of embedding `unknown`.

## User-visible behavior

Normal product labels lead with the version relevant to the user:

```text
Verne 0.2.0
Verne Mobile 0.1.0 (42)
```

Upstream provenance is secondary diagnostic information. About or diagnostics surfaces show the
full identity without presenting T3 Code as a runtime dependency:

```text
Verne version: 0.2.0
Verne revision: 0123456
Based on T3 Code 0.0.37
T3 Code revision: b883fc0
```

The CLI keeps `verne --version` short and script-friendly. Structured or verbose diagnostics expose
the remaining fields. A remote client distinguishes its own version from the connected server
version; mobile therefore reports both Verne Mobile identity and the remote Verne core identity when
a connection is available. Servers predating this model expose their Verne version but have no
revision or upstream provenance, which clients render as unavailable rather than guessing.

## Operational boundaries

Only the Verne version controls:

- npm package versions and dist-tags;
- GitHub release tags and names;
- Electron and mobile update comparisons;
- artifact filenames and update manifests;
- compatibility decisions and telemetry version dimensions.

T3 Code version and revision are informational provenance. They never select packages, update
channels, migrations, or compatibility behavior.

Stable coordinated releases use tags such as `v0.2.0` and publish the CLI to npm `latest`.
Prereleases use SemVer identifiers such as `0.2.0-alpha.1` and a non-`latest` npm dist-tag such as
`next`. Nightlies keep their dedicated nightly version and dist-tag. Creating a prerelease must not
replace the last stable `latest` package.

Changing checked-in versions, merging development branches, or updating provenance does not release
software. Publication still requires the release workflow's explicit tag or manual release entry
point.

## Upstream synchronization

Each upstream sync records one exact `upstream/main` commit and updates
`config/verne-upstream.json`. The merge commit remains the historical integration boundary; the
metadata file makes the same boundary available to builds without requiring a full Git history.

During the pre-release rewrite, `rewrite/t3` temporarily acts as the Verne integration base. Sync
branches start from it and return to it after review. Production `main` and every release channel
remain unchanged. The temporary branch model is defined in
[Maintaining the Verne fork](verne-fork-maintenance.md).

After the rewrite is promoted, upstream syncs return to the permanent model: branches start from
Verne `main` and merge back through the protected-branch process.

## Failure behavior and verification

Release preparation fails before publishing when:

- coordinated core manifests disagree;
- a stable or prerelease version maps to the wrong npm dist-tag;
- upstream provenance is missing, malformed, or contains a non-full commit SHA;
- publishable build identity lacks an exact Verne revision;
- a requested release is not newer than relevant Verne package and update history.

Focused tests cover the version updater, provenance decoder, build-identity formatting, release
channel selection, and each changed diagnostics surface. An upstream sync additionally verifies that
the recorded upstream revision is an ancestor of the integration branch and that the direct tree
delta from upstream is explainable as Verne product decisions.
