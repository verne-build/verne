import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";

export function buildBrowserRequest(body: Record<string, unknown>, secret: string, workspaceDir: string) {
  return { ...body, secret, workspaceDir };
}

/** Forward a browser action to the Electron control server; resolve the {ok,...} response. */
export function browserControl(
  internalDataDir: string,
  workspaceDir: string,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let cfg: { port: number; secret: string };
    try {
      cfg = JSON.parse(readFileSync(join(internalDataDir, "browser-control.json"), "utf8"));
    } catch {
      reject(new Error("browser control unavailable"));
      return;
    }
    const sock = connect(cfg.port, "127.0.0.1");
    sock.setTimeout(10_000, () => sock.destroy(new Error("browser-control timeout")));
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify(buildBrowserRequest(body, cfg.secret, workspaceDir)) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      sock.destroy();
      try {
        const v = JSON.parse(buf.slice(0, nl));
        if (v.ok === true) resolve(v);
        else reject(new Error(v.error ?? "browser op failed"));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on("close", () => reject(new Error("browser-control closed without response")));
    sock.on("error", (e) => reject(e));
  });
}
