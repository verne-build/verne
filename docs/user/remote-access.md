# Remote Access

Use this when you want to connect to a Verne server from another device such as a phone, tablet, or separate desktop app.

## Quick Pairing for a Running Server

If a server is already running on this machine, mint a fresh pairing token and QR code without restarting anything:

```bash
npx @verne-build/cli pair
```

`verne pair` finds the running server (the shared `~/.verne` install, or the current worktree's dev server when run inside one), issues a one-time pairing token, and prints the pairing URL as a QR code you can scan from your phone.

If the server is only bound to loopback, the printed URL is not reachable from another device. Pair over your tailnet instead:

```bash
npx @verne-build/cli pair --tailscale
```

This publishes the server over Tailscale Serve HTTPS (configuring the mapping if needed — it persists until you run `tailscale serve --https=443 off`) and pairs through the `https://machine.tailnet.ts.net/` URL. Use `--tailscale-serve-port` for a different HTTPS port, `--ttl` to change the token lifetime, and `--base-dir` to target a specific data directory.

If no server is running, `verne pair` says so and points you at `npx @verne-build/cli serve` or `npx @verne-build/cli connect`.

## Recommended Setup

Use a trusted private network that meshes your devices together, such as a tailnet.

That gives you:

- a stable address to connect to
- transport security at the network layer
- less exposure than opening the server to the public internet

## Enabling Network Access

There are three ways to reach your server from another device: expose the desktop app's backend,
run a headless server from the CLI, or have the desktop app launch Verne over SSH.

### Option 1: Desktop App

If you are already running the desktop app and want to make it reachable from other devices:

1. Open **Settings** → **Connections**.
2. Under **This environment**, toggle **Network access** on. This will restart the app and run the backend on all network interfaces.
3. The settings panel will show the default reachable endpoint, with a `+N` control when more endpoints are available. Expand it to inspect alternatives such as loopback, LAN, private-network, or HTTPS endpoints.
4. Use **Create Link** to generate a pairing link you can share with another device.

The default endpoint controls the QR code and primary copy action for pairing links. You can change it from the expanded endpoint list. The preference is stored by endpoint type, so choosing the local LAN endpoint survives normal IP address changes when you move between networks.

When no user default is saved, the app uses the built-in LAN endpoint for pairing links when
available. You can set another endpoint as the default from the expanded endpoint list.

- HTTPS/WSS-compatible endpoints work from `https://app.verne.build`, but are not made the default
  automatically.
- Non-loopback HTTP endpoints are useful for direct LAN pairing.
- Loopback-only endpoints are not useful for another device unless that device is the same machine.

If the copied link points directly at `http://192.168.x.y:3773`, open it from a client that can reach that LAN address. If it points at `https://app.verne.build/pair?...`, the hosted web app will save the environment and connect directly to the backend URL in the link.

In the mobile app's **Add Environment** form, a numeric IP address without a scheme uses HTTP. Include `https://` explicitly when the backend is served over HTTPS.

### Tailscale Endpoints

When the desktop app can detect Tailscale, it adds Tailnet endpoints to the reachable endpoint list.

Depending on your Tailscale setup, this may include:

- the machine's `100.x.y.z` Tailnet IP
- a MagicDNS name
- an HTTPS MagicDNS endpoint when Tailscale Serve is configured for this backend

The Tailscale HTTPS endpoint uses the clean MagicDNS URL, such as
`https://machine.tailnet.ts.net/`, and is off until you opt in. Turn on **Enable Tailscale HTTPS**
on the **Tailscale HTTPS** row in **Settings** → **Connections**. The desktop app restarts the
backend with the same server-side behavior as `verne serve --tailscale-serve`, then the server asks
Tailscale Serve to proxy HTTPS traffic to the local backend. Turn the same switch off to stop it.

The Tailscale support is an endpoint provider add-on. The core remote model still works without Tailscale: LAN HTTP endpoints, custom HTTPS endpoints, future tunnels, and SSH-launched environments all use the same saved environment and pairing flow.

For `https://app.verne.build`, prefer an HTTPS Tailnet or other HTTPS endpoint. A plain `http://100.x.y.z:3773` endpoint can still work from a desktop client or another browser page served over HTTP, but it will not work from the hosted HTTPS app because of browser mixed-content rules.

### Option 2: Headless Server (CLI)

Use this when you want to run the server without a GUI, for example on a remote machine over SSH.

Run the server with `verne serve`.

```bash
npx @verne-build/cli serve --host "$(tailscale ip -4)"
```

`verne serve` starts the server without opening a browser and prints:

- a connection string
- a pairing token
- a pairing URL
- a QR code for the pairing URL

From there, connect from another device in either of these ways:

- scan the QR code on your phone
- in the desktop app, enter the full pairing URL
- in the desktop app, enter the host and token separately
- in the hosted web app, open a hosted pairing URL when the backend is reachable over HTTPS

Use `verne serve --help` for the full flag reference. It supports the same general startup options as the normal server command, including an optional `cwd` argument.

For hosted web pairing over Tailscale HTTPS, opt in to Tailscale Serve:

```bash
npx @verne-build/cli serve --tailscale-serve
```

By default this configures Tailscale Serve on HTTPS port 443 and advertises
`https://machine.tailnet.ts.net/`. Advanced users can choose a different HTTPS port:

```bash
npx @verne-build/cli serve --tailscale-serve --tailscale-serve-port 8443
```

Once paired, add projects normally: open the Command Palette and choose **Add Project**, then pick
the environment the project lives on. Every saved environment is offered, not only the local one.

### Opening Dev Server Previews

In any thread, open the bottom drawer and choose **Ports**. The drawer keeps **Terminal** and
**Ports** side by side. **Ports** only shows development servers attributed to the current thread,
and it stays available even when that thread does not currently have an open terminal.

#### Desktop app

The desktop app detects HTTP dev servers running on a connected environment and makes them
available on your desktop automatically. This includes environments added with a pairing URL and
desktop-managed SSH environments.

If the environment is running on the same desktop machine, Verne opens the real localhost URL
directly. For every remote environment, Verne opens an authenticated local URL such as
`http://localhost:5173/`, even when the environment itself is paired over LAN, Tailnet, or SSH.
The local listener binds only to `127.0.0.1`, tries to preserve the remote port, and falls back to
another local port if that port is already occupied.

Click a port row to open it in Verne Preview. Cmd-click on macOS or Ctrl-click on other platforms
opens the same URL in your system browser. The browser action on the row does the same thing
without a modifier. The Preview empty state also keeps its list of discovered local servers as an
additional entry point.

Desktop auto-forwarding is on by default. Use **Settings** → **Connections** →
**Auto-forward dev servers** to turn it off for an environment, or use the power control on an
individual port. Verne keeps a mapping alive for 15 seconds after the server disappears so normal
dev-server restarts do not flap.

#### Web clients

In `https://app.verne.build` and in a web app served by a Verne environment, opening a port starts
a separate Tailnet HTTPS tab instead of an embedded preview. Turn on **Enable Tailscale previews**
once in **Settings** → **Connections** for that environment.

Each browser open or copy action requests a fresh short-lived sign-in handoff, so the displayed
Tailnet URL stays clean. Your browser device must be connected to the same Tailnet and allowed to
reach the environment by that tailnet's ACL.

Use the same power control on a port row to disable or re-enable one discovered process. Turning
off **Enable Tailscale previews** closes active Tailnet publications for that environment and stops
new ones from opening until you enable it again.

#### Limits and troubleshooting

These previews stay private. Verne does not create public sharing links for them and does not fall
back to Cloudflare or another public route when Tailnet access is unavailable.

An environment supports up to 16 distinct active preview openings at a time. If another port shows
**Capacity reached**, disable an unused port or wait for an older server or process to disappear
before retrying.

If Tailnet previews show setup is required, install and start Tailscale on the environment, sign in
to Tailscale, and enable MagicDNS and Tailscale HTTPS for your tailnet. On Linux, an operator may
also need to run `sudo tailscale set --operator=<service account>`. Verne never runs `sudo` for
you.

Forward authorization is part of the paired client session. Sessions created before
`preview:access` was added may not be allowed to open previews; if opening is rejected after an
upgrade, remove and pair the environment again.

Mobile can connect to environments in this release, but it does not open Ports previews yet.

### Option 3: Desktop-Managed SSH Launch

Use this when you want the desktop app to start or reuse Verne on another machine over SSH.

1. Open **Settings** → **Connections**.
2. Under **Remote Environments**, choose **Add environment**.
3. Select the SSH launch flow.
4. Enter the SSH target, such as `user@example.com`.
5. Confirm the launch. The desktop app probes the host, starts or reuses a remote Verne server, opens a local port forward, and saves the environment.

After setup, the renderer connects to a local forwarded HTTP/WebSocket endpoint. The remote host still owns the actual Verne server, projects, files, git state, terminals, and provider sessions.

SSH launch is a desktop feature because it needs local process and SSH access. Once the environment is paired and saved, it uses the same environment list and connection model as direct LAN, Tailscale, HTTPS, or future tunnel-backed environments.

#### SSH Launch Troubleshooting

The desktop SSH launcher connects with a non-interactive `sh` session, writes a small launcher script under `~/.verne/ssh-launch/<host-key>/`, starts or reuses a remote Verne server, and forwards the remote loopback port back to your desktop.

The remote host must have a compatible Node.js runtime. Verne uses the server package's `engines.node` requirement:

```text
^22.16 || ^23.11 || >=24.10
```

During SSH launch, Verne first checks whether `node` is on `PATH`. If it is missing, the launcher
looks in the usual install directories and tries to activate a version manager if it finds one
(Volta, asdf, mise, fnm, nodenv, nvm). That covers most setups, but a version manager that only
initializes from an interactive shell profile will not be picked up.

If launch fails with `node: command not found`, a port-scan failure, or a message that the remote Node version does not satisfy the required range, SSH into the host and check the same non-interactive shell path Verne uses:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

If that does not print a compatible Node version, configure your version manager for non-interactive shells or install a compatible Node binary in one of the searched locations. For example, with nvm you may need a default alias:

```bash
nvm alias default 24
```

With mise, asdf, fnm, or nodenv, make sure the tool's shim directory is installed and resolves to a Node version satisfying the range above without an interactive shell.

If reconnecting after an app update fails, retry the SSH launch once. The launcher now compares its generated runner script, stops stale launcher-managed remote servers, clears the SSH launch PID/port state, and starts a fresh remote server. You should not normally need to delete `~/.verne/ssh-launch` or kill `verne` processes manually.

## Updating a Remote Server

When the Verne web or desktop app and a remote server use different versions, a warning appears in
the conversation and in **Settings** → **Connections**. Follow the action shown there: Verne may
be able to update and reconnect the server for you, or it may ask you to update the desktop app or
run a copied command on the server machine.

Finish active work before updating because the server restarts briefly. For step-by-step guidance,
see [Keeping Verne in Sync](./updating.md).

On a Linux host, you can keep the server running after logout and manage it independently of the
connection method. See [Running Verne in the Background](./background-service.md).

## How Pairing Works

The remote device does not need a long-lived secret up front.

Instead:

1. `verne serve` issues a one-time owner pairing token.
2. The remote device exchanges that token with the server.
3. The server creates an authenticated session for that device.

After pairing, future access is session-based. You do not need to keep reusing the original token unless you are pairing a new device.

## Hosted Web App Pairing

The hosted web app at `https://app.verne.build` can save a remote backend in browser local storage from a URL like:

```text
https://app.verne.build/pair?host=https://backend.example.com:3773#token=PAIRCODE
```

Use hosted pairing when the backend is reachable from the browser over HTTPS/WSS. This includes a backend behind a trusted HTTPS tunnel or another HTTPS endpoint you operate.

Do not use hosted pairing for plain HTTP LAN URLs such as `http://192.168.x.y:3773`. Browsers block an HTTPS page from connecting to an insecure HTTP or WS backend. For those endpoints, use the direct pairing URL shown by the desktop app or CLI from a client that can open that HTTP URL directly.

Hosted pairing does not proxy traffic through Verne. The browser still connects directly to the backend URL in the pairing link.

## Managing Access Later

Use `verne auth` to manage access after the initial pairing flow.

Typical uses:

- issue additional pairing credentials
- inspect active sessions
- revoke old pairing links or sessions

Use `verne auth --help` and the nested subcommand help pages for the full reference.

## Security Notes

- Treat pairing URLs and pairing tokens like passwords.
- Prefer binding `--host` to a trusted private address, such as a Tailnet IP, instead of exposing the server broadly.
- Anyone with a valid pairing credential can create a session until that credential expires or is revoked.
- Hosted pairing links keep the credential in the URL hash so it is not sent to the hosted app server, but it can still be exposed through browser history, screenshots, logs, or copy/paste.
- Use `verne auth` to revoke credentials or sessions you no longer trust.
