export type HostedChannel = "latest" | "nightly";

export interface RouterEnv {
  readonly LATEST: {
    fetch(request: Request): Promise<Response>;
  };
  readonly NIGHTLY: {
    fetch(request: Request): Promise<Response>;
  };
}

function getCookie(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return undefined;

  for (const entry of cookie.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return value.join("=");
  }

  return undefined;
}

export function selectChannel(request: Request): HostedChannel {
  return getCookie(request, "verne_web_channel") === "nightly" ? "nightly" : "latest";
}

export async function handleRouterRequest(request: Request, env: RouterEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/__verne/channel") {
    const channel: HostedChannel =
      url.searchParams.get("channel") === "nightly" ? "nightly" : "latest";
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": `verne_web_channel=${channel}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  try {
    return await (selectChannel(request) === "nightly" ? env.NIGHTLY : env.LATEST).fetch(request);
  } catch {
    return new Response("Hosted Verne channel unavailable.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=UTF-8" },
    });
  }
}

export default { fetch: handleRouterRequest };
