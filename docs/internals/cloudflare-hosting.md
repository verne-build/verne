# Cloudflare hosting

Verne hosts its public website and hosted web client on Cloudflare Workers. The hosting code is a
Verne-owned fork seam: upstream T3 Code deployment files remain in place as inactive reference code,
while Verne deployment entry points live in directories whose names make their ownership explicit.

## Fork boundary

The upstream `apps/marketing` package, its Vercel configuration, and `apps/web/vercel.ts` remain in
the tree. Verne does not deploy them and does not provide Vercel credentials. Keeping those files
avoids a permanent deletion patch against an upstream-owned surface and makes future upstream merges
less likely to conflict.

Verne-specific hosting is concentrated in these paths:

```text
apps/verne-marketing/                 # independently designed verne.build website
infra/verne-cloudflare/app-channel/  # hosted web static-assets Worker
infra/verne-cloudflare/app-router/   # app.verne.build channel router
.github/workflows/verne-marketing.yml
.github/workflows/web-preview.yml
```

The root marketing convenience scripts target `apps/verne-marketing`. The upstream marketing
package stays in the workspace so upstream changes can merge normally, but it is not part of a Verne
deployment. The new website starts as a minimal independent package; copying the upstream site's
components, styles, or content into it is outside this hosting change.

The release workflow and runner labels are necessarily shared seams. Changes there should remain
surgical: the release workflow calls the Verne Cloudflare deployment entry point instead of Vercel,
and workflows use standard GitHub-hosted runner labels without otherwise restructuring upstream jobs.

## Worker topology

Production uses four Workers:

| Worker              | Public hostname           | Responsibility                              |
| ------------------- | ------------------------- | ------------------------------------------- |
| `verne-marketing`   | `verne.build`             | Serve the site and `/schema/verne.json`.    |
| `verne-app-latest`  | `latest.app.verne.build`  | Serve the latest hosted web build.          |
| `verne-app-nightly` | `nightly.app.verne.build` | Serve the nightly hosted web build.         |
| `verne-app-router`  | `app.verne.build`         | Select and forward to a hosted web channel. |

The latest and nightly Workers share the code and configuration template in
`infra/verne-cloudflare/app-channel`. Each deployment supplies its Worker name and channel-specific
build output. Both expose a static-assets binding to a minimal Worker handler, which allows the
router to call them through Cloudflare service bindings rather than making a public HTTP round trip.

The router has `LATEST` and `NIGHTLY` service bindings. It contains no web assets and does not copy
the web application. A request to `app.verne.build` is forwarded unchanged to the selected service,
so paths, query parameters, request methods, and headers retain their normal meaning.

Each static hosted-web Worker serves `apps/web/dist` and falls back to `index.html` for paths that do
not resolve to an asset. This preserves client-side routing. Existing asset responses, including
not-found responses for files that look like immutable assets, follow Cloudflare's static-assets
behavior rather than being replaced by the SPA document.

## Channel behavior

The Cloudflare router preserves the current hosted-app contract:

- `app.verne.build` defaults to the latest channel.
- The `verne_web_channel` cookie selects `latest` or `nightly`; an absent or unrecognized value
  selects latest.
- `GET /__verne/channel?channel=nightly` selects nightly. Any other or missing `channel` value selects
  latest.
- The selection response redirects to `/` with status `302` and sets a one-year cookie with
  `Path=/`, `HttpOnly`, `Secure`, and `SameSite=Lax`.
- The selection query parameter is not carried into the redirect.
- The router domains and direct channel domains remain usable independently.

The router implementation is framework-free TypeScript against the Workers fetch API. Its channel
selection is a small pure function covered by focused tests; the Worker handler is covered with
requests and mock service bindings.

## Deployments

### Marketing

Every push to `main` builds the Verne site and deploys `verne-marketing`; the workflow does not use
path filters. A manual workflow dispatch is also available for recovery. The workflow uses
`ubuntu-24.04` and does not run the upstream marketing build. The site publishes the generated Verne
project schema at `https://verne.build/schema/verne.json`, preserving the product identity contract
without depending on the dormant upstream marketing package.

### Hosted web releases

The existing release workflow continues to decide the release channel. After the release artifacts
are published, it builds `apps/web` with the same release version and public client configuration as
the desktop artifacts, applies the channel-specific brand assets, and deploys the result:

- stable releases deploy `verne-app-latest`;
- prereleases deploy `verne-app-nightly`.

Deploying a channel does not redeploy or reconfigure the router. The router changes only when its own
source or bindings change, which keeps channel releases small and prevents a nightly deployment from
affecting the stable route.

### Pull-request previews

The existing `preview:web` label remains the opt-in control. A same-repository pull request with the
label builds the hosted web app without managed relay configuration and deploys a temporary Worker
named `verne-app-pr-<number>` on `workers.dev`. The workflow updates one marker comment with the exact
preview URL and commit SHA.

The preview is redeployed after subsequent pushes while the label remains. Removing the label or
closing the pull request deletes that Worker and updates the marker comment. Fork pull requests are
skipped because Cloudflare credentials are not exposed to them. Preview Workers use direct static
asset serving and do not participate in latest/nightly routing.

## GitHub-hosted runners

Verne workflows use GitHub-hosted runners instead of Blacksmith:

- Linux jobs use `ubuntu-24.04`.
- Windows jobs use `windows-2025`.
- Apple Silicon jobs use `macos-26`.
- Intel macOS jobs use `macos-26-intel`.

Desktop build jobs receive longer timeouts to account for the lower and more variable capacity of
standard hosted runners. This is a runner substitution, not a redesign of the build matrix.

## Credentials and Cloudflare setup

GitHub environments provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The API token is
limited to deploying and deleting Workers, updating Worker bindings and routes, and reading the
account information Wrangler needs. It does not need general DNS or zone administration when custom
domains are attached separately during bootstrap.

Wrangler is pinned in the repository so local validation and GitHub Actions use the same release.
Deployment commands fail immediately when either Cloudflare secret is missing. Build-time public
client configuration continues to use the existing GitHub variables and release outputs; secrets
that are embedded into a browser bundle are not introduced by this hosting change.

One-time bootstrap proceeds in dependency order:

1. Deploy `verne-app-latest` and `verne-app-nightly`.
2. Deploy `verne-app-router` with service bindings to both channel Workers.
3. Deploy `verne-marketing`.
4. Attach `latest.app.verne.build`, `nightly.app.verne.build`, `app.verne.build`, and `verne.build` as
   Worker Custom Domains in Cloudflare.
5. Enable the `workers.dev` subdomain for temporary preview Workers.

The repository documents these steps, but automation does not create zones, change nameservers, or
attach production domains. Those are deliberate one-time account operations.

## Failure behavior

A failed site or channel deployment leaves the previously deployed Worker version serving traffic.
The release workflow treats a failed hosted-web deployment as a release failure and does not report
the release as fully complete. A router request returns `502` with a short plain-text response if its
selected service binding throws; it does not silently switch channels, because that would make an
explicit nightly selection misleading.

Preview cleanup is idempotent: deleting a Worker that is already absent succeeds as a no-op. A failed
cleanup remains visible as a failed GitHub Actions job and can be retried manually.

## Verification

Changes to this seam use focused checks rather than repository-wide validation:

- router unit tests for default selection, both cookie values, the selection endpoint, cookie
  attributes, query cleanup, forwarding, and binding failures;
- hosted-web static Worker tests for asset serving and SPA fallback;
- targeted typechecks for the Worker packages and affected web or marketing package;
- production builds for `apps/web` and `apps/verne-marketing`;
- Wrangler configuration validation or dry runs for all four production Workers and a preview Worker;
- formatting validation for modified workflow files.

Local verification does not deploy Workers, modify Cloudflare domains, or open a browser. A live
deployment requires maintainer authorization and configured GitHub secrets.
