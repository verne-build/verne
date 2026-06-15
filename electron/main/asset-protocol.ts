import { protocol, net } from "electron";
import { pathToFileURL } from "node:url";

// Must be called BEFORE app.whenReady (privileged scheme registration).
export function registerAssetSchemePrivilege(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "verne-asset",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
      },
    },
  ]);
}

// Call after app.whenReady.
export function handleAssetProtocol(): void {
  protocol.handle("verne-asset", (request) => {
    const url = new URL(request.url); // verne-asset://local/<encoded absolute path>
    const filePath = decodeURIComponent(url.pathname); // pathname is the absolute path, already leading-slash
    return net.fetch(pathToFileURL(filePath).toString());
  });
}
