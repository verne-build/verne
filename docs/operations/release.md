# Release Checklist

> For maintainers. Using Verne? See [docs/user](../user/).

This document covers the unified release workflow for stable and nightly desktop releases.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push tag matching `v*.*.*` for stable releases
  - scheduled nightly check every three hours
  - manual `workflow_dispatch` for either channel
- Runs lint, typecheck, and tests alongside artifact builds. Publishing waits for every check.
- Packages clients without account authentication or managed relay configuration; manual pairing is the initial connection path.
- Builds four artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Publishes the CLI package (`apps/server`, npm package `@verne-build/cli`) with OIDC trusted publishing from the same workflow file:
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
- Deploys the hosted web app to Cloudflare Workers only after a release is published:
  - stable-channel releases, including suffixed tagged prereleases, deploy `verne-app-latest`
  - scheduled or manually dispatched nightly releases deploy `verne-app-nightly`
- Signing is optional and auto-detected per platform from secrets.

## Required release credentials

Stable releases require these GitHub Actions secrets in addition to the platform and deployment
credentials documented below:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

The finalize job uses them to commit and push aligned package versions to `main` as the Release App.
GitHub Release publication uses the repository-scoped workflow token so it has a rate-limit quota
independent from the shared Release App installation.

## Managed relay status

Verne does not deploy or require an account-backed relay initially. The inherited relay code and
manual deployment workflow remain isolated for possible future work, but the workflow is
`workflow_dispatch`-only and the release job deliberately injects empty relay/auth configuration.
Desktop, web, mobile, and CLI releases must remain usable through direct manual pairing.

## Hosted web app release deployment

The hosted app and public website use Cloudflare Workers. `.github/workflows/release.yml` deploys the
selected hosted-app channel after the GitHub Release succeeds; `.github/workflows/verne-marketing.yml`
deploys the website on every push to `main` and by manual dispatch. Channel releases do not deploy
the router.

Required GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`: scoped to deploy and delete Workers and manage their bindings.
- `CLOUDFLARE_ACCOUNT_ID`: the account containing all four production Workers.

Required GitHub Actions variable:

- `CLOUDFLARE_WORKERS_SUBDOMAIN`: the account's enabled `workers.dev` subdomain, without
  `.workers.dev`; preview comments use it to construct the deployed Worker URL.

`VERNE_WEB_ROUTER_URL` remains an optional public build variable and defaults to
`https://app.verne.build`.

The production topology is:

| Worker              | Custom Domain             | Deployment owner                        |
| ------------------- | ------------------------- | --------------------------------------- |
| `verne-app-latest`  | `latest.app.verne.build`  | Stable-channel release runs.            |
| `verne-app-nightly` | `nightly.app.verne.build` | Scheduled or manual nightly runs.       |
| `verne-app-router`  | `app.verne.build`         | Manual maintainer deployment.           |
| `verne-marketing`   | `verne.build`             | Marketing workflow or manual bootstrap. |

The release job aligns package versions so the hosted app's About panel renders the release version,
builds `apps/web`, applies channel-specific brand assets, and deploys only the mapped channel Worker.
It passes `VITE_HOSTED_APP_CHANNEL=latest|nightly`, which renders the hosted update track selector in
the About panel. Changing the selector navigates through
`/__verne/channel?channel=latest|nightly` on the router domain; the router stores the
`verne_web_channel` cookie and redirects to `/` before forwarding subsequent requests through the
selected service binding.

### One-time Cloudflare bootstrap

Every Wrangler-facing script in `infra/verne-cloudflare` invokes the exact
`vp dlx wrangler@4.127.1` pin rather than a locally installed Wrangler dependency. Before bootstrap,
create the scoped API token, add both secrets and `CLOUDFLARE_WORKERS_SUBDOMAIN` to the GitHub
repository, and confirm the account's `workers.dev` subdomain. With Cloudflare credentials exported
locally, bootstrap in this dependency order from the repository root:

1. Build and deploy latest:

   ```bash
   export APP_VERSION=<release-version>
   export VITE_HOSTED_APP_URL=https://app.verne.build
   export VITE_HOSTED_APP_CHANNEL=latest
   vp run --filter @t3tools/web build
   node scripts/apply-web-brand-assets.ts --channel latest
   vp run --filter @verne-build/cloudflare deploy:channel --name verne-app-latest
   ```

2. Build and deploy nightly:

   ```bash
   export APP_VERSION=<nightly-version>
   export VITE_HOSTED_APP_URL=https://app.verne.build
   export VITE_HOSTED_APP_CHANNEL=nightly
   vp run --filter @t3tools/web build
   node scripts/apply-web-brand-assets.ts --channel nightly
   vp run --filter @verne-build/cloudflare deploy:channel --name verne-app-nightly
   ```

3. After both channel Workers exist, manually deploy the router:

   ```bash
   vp run --filter @verne-build/cloudflare deploy:router
   ```

4. Build and deploy marketing:

   ```bash
   vp run --filter @verne-build/marketing build
   vp run --filter @verne-build/cloudflare wrangler deploy \
     --config ../../apps/verne-marketing/wrangler.jsonc
   ```

5. In Cloudflare, manually attach the four Custom Domains shown in the topology table. Repository
   automation does not create zones, mutate DNS or nameservers, or attach production domains.

The router deploy remains manual after bootstrap. Run it only when router source or service bindings
change, and only after both channel Workers exist. Stable and nightly releases update their channel
Workers independently without changing router configuration.

### Pull-request previews

Adding `preview:web` to a same-repository pull request builds the web app and deploys
`verne-app-pr-<number>` to
`https://verne-app-pr-<number>.<CLOUDFLARE_WORKERS_SUBDOMAIN>.workers.dev`. Subsequent pushes redeploy
the same Worker while the label remains. The workflow maintains one marker comment containing the
exact preview URL and commit SHA. Removing the label, or closing the pull request while that label
remains, deletes the Worker and updates that comment; an already-absent Worker is treated as a
successful no-op. Cleanup runs from the trusted pull-request base SHA. Fork pull requests are skipped
because GitHub does not expose Cloudflare credentials to them.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - scheduled check every three hours
  - manual `workflow_dispatch` with `channel=nightly`
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI package (`apps/server`, npm package `@verne-build/cli`) to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching `@verne-build/cli@<version>` package available on
npm before users can receive that client.

The workflow enforces this ordering:

1. `publish_cli` publishes the exact stable or nightly version to npm.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.
3. `deploy_web` depends on `release` before moving the hosted channel to the new client.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view @verne-build/cli@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run `npx @verne-build/cli@<version> service update` once on the
server machine. Also test the manual or desktop-managed guidance when those environments are
available.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `VERNE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship a
Linux-only `resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar. WSL verifies
and extracts that archive into `~/.verne/wsl-runtime/sha256-<archive-digest>` inside
the selected distro, then reuses it for later launches of the same update. The
Windows-side `wsl-server-tree/<version>` extraction remains a fallback and is
removed after the distro-local runtime passes preflight.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build with a WSL node-pty prebuild omits the WSL archive or SHA-256
  sidecar, the sidecar digest does not match the emitted archive, or required
  Linux runtime members are absent.
- The emitted WSL archive contains Windows/Darwin node-pty payloads, ConPTY,
  pnpm install metadata, or Windows-only FFF, ffi-rs, or msgpackr bindings.
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow invokes `node apps/server/scripts/cli.ts publish` after aligning package versions. That
script temporarily prepares the `@verne-build/cli` package, then runs `vp pm publish --filter @verne-build/cli ...` from the
repository root so workspace publish configuration is applied correctly.

Checklist:

1. Confirm npm org/user owns package `@verne-build/cli` (or rename package first if needed).
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - align the release package versions to `X.Y.Z`
   - build web + server
   - invoke the CLI publish script with npm dist-tag `latest`
5. Nightly runs invoke the same publish script with npm dist-tag `nightly`.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1`, classifies the run as the stable channel. It publishes `@verne-build/cli` with npm dist-tag
`latest`, creates a real GitHub Release, deploys `verne-app-latest`, and can commit a version bump to
`main` in the finalize job. Do not push a test tag
to validate the workflow.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly`; this still publishes a real nightly npm package, GitHub
prerelease, desktop updater release, and `verne-app-nightly`, but it does not update the latest Worker or
commit a version bump to `main`. Only run it when a real nightly release is acceptable.

Manual `channel=stable` with a version input is also a real stable-channel release. Omitting signing
secrets only makes platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create a `Developer ID Application` certificate for the Verne distribution team.
3. Export the certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. In App Store Connect, create an API key (Team key).
7. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
8. Re-run a tag release and confirm macOS artifacts are signed and notarized.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Create release tag: `vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - all matrix builds pass
   - `publish_cli` publishes the exact release version before the release job
   - release job uploads expected files
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple certificate and notarization secrets are populated and non-empty.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
