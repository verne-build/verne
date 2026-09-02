# Dev server preview access

## Summary

This document describes the architecture for opening environment-local development servers from
Verne desktop and web clients. It extends the authenticated desktop port-forwarding model in
[remote.md](./remote.md) with private Tailnet publication for web clients.

The central decision is to keep discovery independent of transport and choose the access transport
on the client surface:

- desktop preserves local-looking `http://localhost:<port>` URLs through its existing authenticated
  forward;
- hosted and environment-served web clients open an authenticated Tailscale Serve URL in a separate
  browser tab;
- mobile is intentionally excluded until it has a mobile-specific Ports surface.

Cloudflare tunnels, public preview URLs, Durable Objects, and an embedded web preview pane are not
part of this design.

## Goals

- Detect development servers started in a thread, including servers listening on `localhost`,
  `127.0.0.1`, `::1`, or a wildcard address.
- Give desktop and web clients one current-thread Ports UI while preserving the transport that fits
  each surface.
- Keep desktop preview URLs equivalent to local development URLs whenever the requested local port
  is available.
- Let a paired web client open the same server privately through the environment's tailnet without a
  public relay.
- Require both Tailnet authorization and Verne preview authorization for web access.
- Support HTTP and WebSocket development traffic, including HMR.
- Make enable, disable, status, conflict, and recovery states visible and reversible.
- Avoid modifying Tailscale Serve mappings Verne does not own.

## Non-goals

- Public or unauthenticated preview sharing.
- Access from a browser device that is not connected to the environment's tailnet.
- A Verne-managed Tailscale account or automatic tailnet policy changes.
- Replacing desktop forwarding with Tailscale.
- Adding an iframe or browser-preview runtime to the hosted web app.
- Adding a mobile Ports screen.
- Supporting arbitrary TCP services. Published targets must be discovered HTTP development servers.

## User experience

### Bottom drawer

The thread bottom drawer has two top-level tabs:

- **Terminal** retains the current terminal groups, splits, actions, and shortcuts.
- **Ports** lists development servers attributed to the current thread.

The selected tab and drawer height are client-local, per-thread UI state. Terminal shortcuts open the
drawer on **Terminal**. The existing globe indicator beside a thread opens that thread and selects
**Ports**. The Ports tab remains available when a thread has no active terminal session.

Each Ports row shows:

- process name when known;
- environment port;
- resolved URL for the current client;
- forwarding or publication status;
- copy URL;
- an explicit browser-open action;
- an enable or disable action.

Only ports whose discovered process belongs to the current thread appear. Environment-level or
unattributed listeners do not leak into an unrelated thread's drawer.

### Desktop interaction

For an environment running on the desktop machine, desktop uses the real localhost URL directly.
For every remote environment, desktop resolves the environment port through the existing
authenticated port-forwarding path. The control connection being reachable over LAN or Tailscale
does not replace this forward. Single-clicking a row opens the resolved localhost URL in Verne
Preview. Cmd-click on macOS or Ctrl-click elsewhere opens the same resolved URL in the system
browser, matching pull-request link behavior. The explicit browser action provides the same result
without a modifier.

The local listener prefers the environment port, so port 3000 normally appears as
`http://localhost:3000`. If that port is already occupied on the desktop, the displayed and opened
URL uses the actual fallback port. The existing local-server list in the desktop Preview empty state
remains as an additional entry point.

### Web interaction

The hosted app at `app.verne.build` and a web app served by a Verne environment have no embedded
preview runtime. Their Ports rows open a Tailnet HTTPS URL in a separate browser tab. Top-level
navigation avoids iframe compatibility, cross-origin embedding, and browser private-network request
restrictions.

Settings -> Connections exposes **Enable Tailscale previews** for a capable environment. Enabling it
is a one-time environment opt-in. While enabled, each web session automatically acquires publication
leases for the active thread's discovered ports. A disabled individual port stays suppressed for
that process lifetime; a newly discovered process may publish again.

The browser device must have Tailscale connected to the same tailnet and must be allowed to reach the
environment. Verne cannot reliably preflight that private route from `app.verne.build`, so the Ports
tab states this requirement and retains retry and copy actions when navigation fails outside Verne.

## Architecture

```text
environment port discovery
          |
          v
 current-thread Ports model
          |
   +------+------+
   |             |
desktop adapter  web adapter
   |             |
authenticated    Tailnet publication lease
WS/TCP forward   + authenticated HTTP gateway
   |             |
localhost:port   machine.tailnet.ts.net:port
```

Discovery remains transport-neutral. The client surface selects a preview-access adapter only when
it needs to make a discovered loopback URL reachable.

### UI boundaries

`ThreadBottomDrawer` owns drawer resizing and Terminal/Ports selection. The existing
`ThreadTerminalDrawer` remains responsible for terminal rendering rather than accumulating port
publication behavior. `ThreadPortsPanel` consumes the existing current-thread discovery projection
and delegates enable, disable, resolve, copy, and open operations to a preview-access controller.

The controller exposes one presentation model regardless of transport. It does not hide meaningful
transport states: desktop rows describe local forwarding, while web rows describe Tailnet
publication and setup failures.

### Desktop adapter

The desktop adapter returns the requested localhost URL without a tunnel when the selected
environment runs on the desktop machine. For a remote environment, it retains protocol version 1 of
the existing flow:

1. Acquire a session-owned, single-use preview ticket for a discovered port.
2. Pass the ticket to Electron main.
3. Open the authenticated `/preview/tunnel` WebSocket.
4. Bind a loopback-only desktop listener, preferring the requested port.
5. Return the actual localhost URL.

This choice depends on environment locality, not whether the remote control endpoint happens to use
a private LAN or Tailnet address. The desktop path must not install, configure, or require
Tailscale.

### Web adapter

The web adapter acquires a session-owned Tailnet publication lease for `{ threadId, port }`. The
server verifies that the listener is still discovered and is attributed to the supplied thread. It
then starts or reuses an authenticated loopback gateway and ensures an HTTPS Tailscale Serve mapping
from the same Tailnet port to that gateway.

Publication is reference-counted by environment, port, and paired session. Multiple web clients can
use one mapping without racing to replace it. Releasing or disconnecting one session leaves the
mapping active while another valid lease remains.

## Server components

### Port discovery

The current scanner remains the allowlist. Publication never accepts a caller-provided host or an
undiscovered port. Thread ownership comes from the scanner's terminal/process attribution. The
normalized connect host remains server-derived.

### Tailnet publisher

The Tailnet publisher owns:

- publication leases and reference counts;
- the environment opt-in setting;
- per-process suppression;
- bounded capacity;
- mapping creation and exact-target cleanup;
- disappearance and restart grace periods;
- startup reconciliation.

It calls the shared Tailscale package. UI and RPC handlers do not spawn `tailscale` directly.

### Authenticated preview gateway

The gateway listens only on loopback and proxies one approved development server. It supports HTTP
requests and WebSocket upgrades. It removes gateway cookies and internal headers before forwarding
and normalizes `Host` and `Origin` to the environment-local target where required by common dev-server
host checks. It does not rewrite response bodies or arbitrary absolute URLs.

Every mapping has an unambiguous gateway target. A gateway is stopped after its last publication
lease is released and its disappearance grace period has elapsed.

### Tailscale adapter

The existing Tailscale package is extended to read Serve configuration, ensure one HTTPS mapping,
and remove one verified mapping. It returns classified diagnostics rather than raw stderr. Relevant
states include:

- Tailscale unavailable;
- environment not logged in;
- MagicDNS or HTTPS consent required;
- current server account lacks Tailscale operator permission;
- the Tailnet port is already mapped to another target;
- Serve configuration or cleanup failed.

Verne never invokes `sudo`, runs `tailscale serve reset`, edits the tailnet policy, or replaces an
unknown target. On Linux, the permission remedy is the one-time operator command appropriate for the
account running Verne, for example `sudo tailscale set --operator=verne`.

## Contracts and compatibility

Environment capabilities advertise `tailnetPreviewPublishing` with an explicit protocol version,
separate from desktop `portForwarding`. A client hides unsupported controls when the capability is
absent. This lets new clients remain compatible with old servers and lets desktop forwarding evolve
independently.

Typed requests cover:

- reading Tailnet readiness and Verne-owned publication state;
- enabling or disabling the environment opt-in;
- acquiring or renewing `{ threadId, port }`;
- releasing a publication lease;
- enabling or suppressing an individual discovered process.

An acquisition result contains the lease identifier, environment port, clean Tailnet URL,
publication status, and a short-lived one-time launch capability. All mutations require the paired
session's `preview:access` scope. Sessions paired before that scope existed must pair again rather
than receiving an implicit upgrade.

Publication state is runtime state, not an event-sourced project or thread aggregate. The persisted
environment opt-in and exact mapping ownership records live with server settings/runtime metadata;
short-lived leases and browser capabilities remain memory-only.

## Authentication

Tailscale provides device identity, encrypted transport, and tailnet policy enforcement. It is not
the complete application authorization boundary because another user or device may also be allowed
to reach the environment.

A browser open starts at a reserved gateway path:

```text
https://machine.tailnet.ts.net:3000/.well-known/verne-preview/auth#<capability-and-target>
```

The fragment is not sent in the initial HTTP request. The gateway serves a minimal bootstrap page
that posts the capability and intended same-origin path to the gateway. A successful exchange
consumes the one-time value, validates the target path, sets an `HttpOnly`, `Secure`,
`SameSite=Strict` gateway-session cookie, and redirects to the requested development path. The
credential value is bound server-side to the environment, port, and lease. Browser cookies are not
scoped by TCP port, so each port uses a distinct cookie name and every gateway rejects credentials
bound to another port. HTTP and WebSocket requests require the matching credential. The gateway
strips it before forwarding.

The displayed URL is always clean. The copy action requests a fresh short-lived launch capability
instead of copying an expired credential or a permanently bearer-authenticated URL. Disabling a
port, releasing the final lease, disconnecting the owning session, or stopping the process revokes
the corresponding gateway authorization.

## Mapping ownership and recovery

Tailscale Serve background configuration can survive both Verne and machine restarts. Verne stores
the exact public port and loopback gateway target for every mapping it successfully creates. Before
removing a mapping, it reads current Serve configuration and requires an exact match with that
record. A changed or unknown mapping is reported as a conflict and left untouched.

Clean shutdown releases active mappings. At startup, Verne compares its persisted registry with the
current Serve configuration:

- an exact stale match is removed before the port is reused;
- a missing mapping clears the stale registry entry;
- a mismatched mapping is preserved and surfaced as a conflict.

Multiple Verne homes on one machine cannot own the same Tailnet port simultaneously. The later
request fails visibly rather than stealing the route.

## Lifecycle and limits

Automatic publication follows the active thread of each opted-in web session. Switching threads or
disconnecting releases that session's prior leases. A mapping remains while any session still holds
a lease. When a development server disappears, cleanup waits 15 seconds to tolerate normal restart
flapping. A replacement process creates a new discovery identity, clears process-lifetime
suppression, and must pass discovery authorization again.

Publication uses the same bounded scale as desktop forwarding: at most 16 active preview exposures
per environment. Duplicate leases for the same port share one gateway and Serve mapping. No new
continuous polling or animation is introduced; the Ports UI consumes the existing bounded discovery
refresh and publishes only on meaningful state changes.

## Failure behavior

Failures remain local to the affected row. One bad port does not hide other discovered servers or
disconnect the Verne environment.

- Setup-required states show the consent or operator remedy and a retry action.
- Conflicts name the port and state that Verne left the existing mapping unchanged.
- A vanished server removes its open action and proceeds through grace-period cleanup.
- Gateway or Serve failures retain the clean requested port and allow retry.
- If the browser is outside the tailnet, navigation fails in that browser tab; the Ports row keeps
  the published URL and explains the device requirement.
- Disabling the environment setting releases web publication leases and removes only exact
  Verne-owned mappings. Desktop forwarding is unaffected.

## Surface matrix

| Surface                | Current-thread Ports tab | Access transport              | Default open    | Alternate open                                   |
| ---------------------- | ------------------------ | ----------------------------- | --------------- | ------------------------------------------------ |
| Desktop                | Yes                      | Authenticated local forward   | Verne Preview   | Cmd/Ctrl-click or explicit system browser action |
| Hosted web             | Yes                      | Authenticated Tailscale Serve | New browser tab | Copy fresh launch URL                            |
| Environment-served web | Yes                      | Authenticated Tailscale Serve | New browser tab | Copy fresh launch URL                            |
| Mobile                 | No                       | None                          | Not applicable  | Not applicable                                   |

The behavior is provider-independent. Pairing URL, relay, direct LAN, Tailnet, and desktop-managed
SSH connections all use the same surface rule because discovery and publication execute on the
environment machine.

## Verification

Focused contract tests prove version decoding and old-client/server behavior. Server tests cover:

- current-thread and currently-discovered authorization;
- lease sharing, renewal, release, session disconnect, and capacity;
- one-time browser capability consumption and cookie revocation;
- HTTP and WebSocket proxying;
- process disappearance and restart grace;
- exact mapping ownership, conflicts, clean cleanup, and crash reconciliation;
- classified Tailscale availability, consent, and operator errors.

Web tests cover drawer tab state, thread-only filtering, automatic acquisition, individual
suppression, status presentation, explicit browser actions, and Cmd/Ctrl behavior. Desktop-focused
tests prove that the existing localhost resolver and Preview open remain unchanged.

After focused tests and targeted type checks, integrated verification consists of one desktop remote
environment pass and one hosted-web pass with both browser and environment on the same tailnet.
Browser or computer-use verification requires maintainer approval. Repository-wide checks are left
to CI.

## Documentation and rollout

User documentation describes the Ports tab, desktop localhost behavior, Tailnet prerequisites,
one-time Linux operator setup, enable/disable controls, and the fact that web previews open in a
separate tab. Existing desktop forwarding ships unchanged while the new Tailnet capability is
negotiated independently. A server without the capability continues to show desktop forwarding and
does not offer web Tailnet controls.

The architecture deliberately keeps a preview-access adapter seam. A future public relay or mobile
transport can implement that seam without changing discovery, the desktop forward, or the Ports
presentation model.
