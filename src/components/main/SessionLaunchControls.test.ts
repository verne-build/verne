// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { resetAgentAvailabilityCacheForTests } from "@/lib/agentRegistry";
import type { AgentLaunchSelection } from "@/types";

const rpc = vi.hoisted(() => ({ agentBinsAvailable: vi.fn() }));

vi.mock("@/composables/useRpc", () => ({
  useRpc: () => ({ request: rpc }),
}));

vi.mock("@/composables/useTheme", () => ({
  useTheme: () => ({ getActiveThemeSpec: () => ({ type: "dark" }) }),
}));

import SessionLaunchControls from "./SessionLaunchControls.vue";

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function namedButton(name: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!match) throw new Error(`Missing named button: ${name}`);
  return match;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((element) => element.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function menuItem(label: string): HTMLElement {
  const match = Array.from(document.querySelectorAll<HTMLElement>("[data-slot=dropdown-menu-item]"))
    .find((element) => element.textContent?.trim() === label);
  if (!match) throw new Error(`Missing menu item: ${label}`);
  return match;
}

async function selectFrom(menu: string, item: string): Promise<void> {
  namedButton(menu).click();
  await flush();
  menuItem(item).click();
  await flush();
}

function radios(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[role=radiogroup] button[role=radio]"));
}

function radio(label: string): HTMLButtonElement {
  const match = radios().find((element) => element.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Missing radio: ${label}`);
  return match;
}

function checkedRadio(): string {
  const match = radios().find((element) => element.getAttribute("aria-checked") === "true");
  if (!match) throw new Error("No checked radio");
  return match.getAttribute("aria-label") ?? "";
}

async function pickAgent(label: string): Promise<void> {
  radio(label).click();
  await flush();
}

describe("SessionLaunchControls", () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp>;
  let starts: Array<AgentLaunchSelection | undefined>;

  function mount(): void {
    app = createApp({
      render: () => h(SessionLaunchControls, {
        onStart: (selection: AgentLaunchSelection | undefined) => starts.push(selection),
      }),
    });
    app.mount(host);
  }

  beforeEach(() => {
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: ["claude", "agy"] });
    starts = [];
    host = document.createElement("div");
    document.body.append(host);
    mount();
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    document.body.replaceChildren();
  });

  it("loads installed agents and emits the selected model, effort, and fast mode", async () => {
    await flush();
    await selectFrom("Select Model", "Opus");
    await selectFrom("Select Effort Or Fast Mode", "High");
    await selectFrom("Select Effort Or Fast Mode", "On");

    button("Start").click();

    expect(rpc.agentBinsAvailable).toHaveBeenCalledOnce();
    expect(starts).toEqual([{
      agentType: "claude",
      modelId: "opus",
      effort: "high",
      fast: true,
    }]);
  });

  it("emits undefined for Terminal", async () => {
    await flush();
    await pickAgent("Terminal");

    button("Start").click();

    expect(starts).toEqual([undefined]);
  });

  it("does not replace an explicit Terminal choice when availability resolves late", async () => {
    let resolve!: (value: { available: string[] }) => void;
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockImplementation(() => new Promise((done) => { resolve = done; }));
    mount();
    await nextTick();
    await pickAgent("Terminal");

    resolve({ available: ["claude"] });
    await flush();
    button("Start").click();

    expect(checkedRadio()).toBe("Terminal");
    expect(starts).toEqual([undefined]);
  });

  it("keeps Terminal available and retries a failed availability check", async () => {
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ available: ["agy"] });
    mount();
    await flush();

    expect(document.body.textContent).toContain("Couldn't Load Agents");
    expect(checkedRadio()).toBe("Terminal");
    button("Retry").click();
    await flush();

    expect(rpc.agentBinsAvailable).toHaveBeenCalledTimes(2);
    expect(checkedRadio()).toBe("Antigravity");
  });

  it("renders one radio per installed agent plus Terminal, first agent checked", async () => {
    await flush();

    expect(radios().map((element) => element.getAttribute("aria-label")))
      .toEqual(["Claude", "Antigravity", "Terminal"]);
    expect(checkedRadio()).toBe("Claude");
  });

  it("switches agent in one click", async () => {
    await flush();
    await pickAgent("Antigravity");

    button("Start").click();

    expect(checkedRadio()).toBe("Antigravity");
    expect(starts).toEqual([{ agentType: "agy", modelId: null, effort: null, fast: null }]);
  });

  it("moves selection with arrow keys and wraps at the ends", async () => {
    await flush();
    radio("Claude").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await flush();

    expect(checkedRadio()).toBe("Antigravity");

    radio("Antigravity").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await flush();

    expect(checkedRadio()).toBe("Terminal");

    radio("Terminal").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await flush();

    expect(checkedRadio()).toBe("Claude");
  });

  it("exposes a single tab stop", async () => {
    await flush();

    expect(radios().map((element) => element.tabIndex)).toEqual([0, -1, -1]);
  });

  it("keeps Model and Effort visible but disabled for Terminal", async () => {
    await flush();
    await pickAgent("Terminal");

    expect(namedButton("Select Model").disabled).toBe(true);
    expect(namedButton("Select Effort Or Fast Mode").disabled).toBe(true);
    expect(namedButton("Select Model").textContent).toContain("Model Default");
    expect(namedButton("Select Effort Or Fast Mode").textContent).toContain("Effort Default");
  });

  it("renders Effort disabled when the selected model has no tuning", async () => {
    await flush();

    expect(namedButton("Select Effort Or Fast Mode").disabled).toBe(true);
    expect(namedButton("Select Effort Or Fast Mode").textContent).toContain("Effort Default");
  });

  it("enables Effort once a tunable model is selected", async () => {
    await flush();
    await selectFrom("Select Model", "Opus");

    expect(namedButton("Select Effort Or Fast Mode").disabled).toBe(false);
  });

  it("shows Fast Mode only, no Effort label, for a fast-only model with zero effort levels", async () => {
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: ["cursor-agent"] });
    mount();
    await flush();
    await selectFrom("Select Model", "Composer 2.5");

    const effortButton = namedButton("Select Effort Or Fast Mode");
    expect(effortButton.disabled).toBe(false);
    expect(effortButton.textContent).toContain("Fast Mode");
    expect(effortButton.textContent).not.toContain("Effort");
  });
});
