import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { handleRouterRequest, selectChannel } from "./index.ts";

describe("selectChannel", () => {
  it("uses latest unless the exact nightly cookie is present", () => {
    expect(selectChannel(new Request("https://app.verne.build/"))).toBe("latest");
    expect(
      selectChannel(
        new Request("https://app.verne.build/", {
          headers: { Cookie: "verne_web_channel=nightly" },
        }),
      ),
    ).toBe("nightly");
    expect(
      selectChannel(
        new Request("https://app.verne.build/", {
          headers: { Cookie: "verne_web_channel=latest" },
        }),
      ),
    ).toBe("latest");
    expect(
      selectChannel(
        new Request("https://app.verne.build/", {
          headers: { Cookie: "verne_web_channel=unknown" },
        }),
      ),
    ).toBe("latest");
  });
});

describe("handleRouterRequest", () => {
  const latest = { fetch: vi.fn(async () => new Response("latest")) };
  const nightly = { fetch: vi.fn(async () => new Response("nightly")) };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets the nightly channel cookie and redirects home", async () => {
    const response = await handleRouterRequest(
      new Request("https://app.verne.build/__verne/channel?channel=nightly"),
      { LATEST: latest, NIGHTLY: nightly },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toBe(
      "verne_web_channel=nightly; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("sets the latest cookie when the requested channel is missing or not nightly", async () => {
    for (const pathname of ["/__verne/channel", "/__verne/channel?channel=preview"]) {
      const response = await handleRouterRequest(
        new Request(`https://app.verne.build${pathname}`),
        { LATEST: latest, NIGHTLY: nightly },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("Set-Cookie")).toBe(
        "verne_web_channel=latest; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax",
      );
    }
  });

  it("forwards ordinary requests unchanged to the selected binding", async () => {
    const request = new Request("https://app.verne.build/projects/one?tab=chat", {
      headers: { Cookie: "other=value; verne_web_channel=nightly" },
    });
    const response = await handleRouterRequest(request, { LATEST: latest, NIGHTLY: nightly });

    await expect(response.text()).resolves.toBe("nightly");
    expect(nightly.fetch).toHaveBeenCalledOnce();
    expect(nightly.fetch).toHaveBeenCalledWith(request);
    expect(latest.fetch).not.toHaveBeenCalled();
  });

  it("returns a gateway error when the selected binding throws", async () => {
    const unavailable = {
      fetch: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    };
    const response = await handleRouterRequest(new Request("https://app.verne.build/"), {
      LATEST: unavailable,
      NIGHTLY: nightly,
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
    await expect(response.text()).resolves.toBe("Hosted Verne channel unavailable.");
    expect(nightly.fetch).not.toHaveBeenCalled();
  });

  it("forwards non-GET channel requests without mutating the cookie", async () => {
    const request = new Request("https://app.verne.build/__verne/channel?channel=nightly", {
      method: "POST",
    });
    const response = await handleRouterRequest(request, { LATEST: latest, NIGHTLY: nightly });

    await expect(response.text()).resolves.toBe("latest");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(latest.fetch).toHaveBeenCalledOnce();
    expect(latest.fetch).toHaveBeenCalledWith(request);
    expect(nightly.fetch).not.toHaveBeenCalled();
  });
});
