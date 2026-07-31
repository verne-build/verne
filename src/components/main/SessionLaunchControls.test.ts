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

function buttonLabel(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("kbd").forEach((kbd) => kbd.remove());
  return clone.textContent?.trim() ?? "";
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((element) => buttonLabel(element) === label);
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

// Always dispatch from the element that really holds focus — a real browser sets
// `event.target` to the focused node, never to `window`.
function pressKey(init: KeyboardEventInit, target: HTMLElement): void {
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

function rootOf(hostElement: HTMLElement): HTMLElement {
  const match = hostElement.firstElementChild;
  if (!(match instanceof HTMLElement)) throw new Error("Missing root element");
  return match;
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
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: [] });
    mount();
    await flush();

    expect(radios().map((element) => element.getAttribute("aria-label"))).toEqual(["Terminal"]);
    await pickAgent("Terminal");

    button("Start").click();

    expect(starts).toEqual([undefined]);
  });

  it("replaces a stale Terminal choice when availability resolves late", async () => {
    let resolve!: (value: { available: string[] }) => void;
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockImplementation(() => new Promise((done) => { resolve = done; }));
    mount();
    await nextTick();

    expect(radios().map((element) => element.getAttribute("aria-label"))).toEqual(["Terminal"]);
    await pickAgent("Terminal");

    resolve({ available: ["claude"] });
    await flush();

    expect(radios().map((element) => element.getAttribute("aria-label"))).toEqual(["Claude"]);
    expect(checkedRadio()).toBe("Claude");
    button("Start").click();

    expect(starts).toEqual([{ agentType: "claude", modelId: null, effort: null, fast: null }]);
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
    expect(radios().map((element) => element.getAttribute("aria-label"))).toEqual(["Terminal"]);
    expect(checkedRadio()).toBe("Terminal");
    button("Retry").click();
    await flush();

    expect(rpc.agentBinsAvailable).toHaveBeenCalledTimes(2);
    expect(radios().map((element) => element.getAttribute("aria-label"))).toEqual(["Antigravity"]);
    expect(checkedRadio()).toBe("Antigravity");
  });

  it("renders one radio per installed agent plus Terminal, first agent checked", async () => {
    await flush();

    expect(radios().map((element) => element.getAttribute("aria-label")))
      .toEqual(["Claude", "Antigravity"]);
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

    expect(checkedRadio()).toBe("Antigravity");

    radio("Antigravity").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await flush();

    expect(checkedRadio()).toBe("Claude");
  });

  it("exposes a single tab stop", async () => {
    await flush();

    expect(radios().map((element) => element.tabIndex)).toEqual([0, -1]);
  });

  it("keeps Model and Effort visible but disabled for Terminal", async () => {
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: [] });
    mount();
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

  it("pressing 2 selects the second agent; 9 with only two agents changes nothing", async () => {
    await flush();

    pressKey({ key: "2" }, radio("Claude"));
    await flush();
    expect(checkedRadio()).toBe("Antigravity");

    pressKey({ key: "9" }, radio("Antigravity"));
    await flush();
    expect(checkedRadio()).toBe("Antigravity");
  });

  it("pressing 1 while an input has focus does not change the selection", async () => {
    await flush();
    await pickAgent("Antigravity");

    const input = document.createElement("input");
    rootOf(host).append(input);
    input.focus();

    pressKey({ key: "1" }, input);
    await flush();

    expect(checkedRadio()).toBe("Antigravity");
    input.remove();
  });

  it("does not switch agents while the Model menu is open", async () => {
    await flush();
    await pickAgent("Antigravity");
    namedButton("Select Model").click();
    await flush();

    pressKey({ key: "2" }, namedButton("Select Model"));
    await flush();

    expect(checkedRadio()).toBe("Antigravity");
  });

  it("pressing Enter emits start once with the current selection; Enter while busy emits nothing", async () => {
    await flush();
    await pickAgent("Antigravity");

    pressKey({ key: "Enter" }, radio("Antigravity"));
    await flush();

    expect(starts).toEqual([{ agentType: "agy", modelId: null, effort: null, fast: null }]);

    app.unmount();
    host.replaceChildren();
    starts = [];
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: ["claude", "agy"] });
    app = createApp({
      render: () => h(SessionLaunchControls, {
        busy: true,
        onStart: (selection: AgentLaunchSelection | undefined) => starts.push(selection),
      }),
    });
    app.mount(host);
    await flush();

    pressKey({ key: "Enter" }, radio("Claude"));
    await flush();

    expect(starts).toEqual([]);
  });

  it("pressing Enter on the checked radio starts without resetting Model", async () => {
    await flush();
    await selectFrom("Select Model", "Opus");

    const checked = radio("Claude");
    pressKey({ key: "Enter" }, checked);
    // The browser synthesises a click on a focused button after an unprevented Enter.
    checked.click();
    await flush();

    expect(namedButton("Select Model").textContent).toContain("Opus");
    expect(starts).toEqual([{ agentType: "claude", modelId: "opus", effort: null, fast: false }]);
  });

  it("pressing 1 with a modifier held does nothing", async () => {
    await flush();
    await pickAgent("Antigravity");

    pressKey({ key: "1", metaKey: true }, radio("Antigravity"));
    await flush();

    expect(checkedRadio()).toBe("Antigravity");
  });

  it("removes the keydown listener on unmount", async () => {
    await flush();
    await pickAgent("Claude");
    const checked = radio("Claude");
    app.unmount();

    pressKey({ key: "2" }, checked);
    await flush();

    expect(starts).toEqual([]);
  });

  it("keeps the radios focusable and tooltip-capable while starting", async () => {
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockResolvedValue({ available: ["claude", "agy"] });
    app = createApp({
      render: () => h(SessionLaunchControls, {
        busy: true,
        onStart: (selection: AgentLaunchSelection | undefined) => starts.push(selection),
      }),
    });
    app.mount(host);
    await flush();

    expect(radio("Claude").disabled).toBe(false);
    expect(radio("Claude").getAttribute("aria-disabled")).toBe("true");
    expect(radios().map((element) => element.tabIndex)).toEqual([0, -1]);

    radio("Antigravity").click();
    await flush();

    expect(checkedRadio()).toBe("Claude");
  });

  it("checks the first option and keeps a tab stop while the probe is in flight", async () => {
    app.unmount();
    host.replaceChildren();
    resetAgentAvailabilityCacheForTests();
    rpc.agentBinsAvailable.mockReset();
    rpc.agentBinsAvailable.mockImplementation(() => new Promise(() => {}));
    mount();
    await nextTick();

    expect(checkedRadio()).toBe("Terminal");
    expect(radios().map((element) => element.tabIndex)).toEqual([0]);
  });

  it("hides the shortcut badges from accessible names", async () => {
    await flush();

    const badges = Array.from(document.querySelectorAll("kbd"));
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.every((badge) => badge.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("ignores keypresses when focus belongs to a different mounted picker", async () => {
    const hostB = document.createElement("div");
    document.body.append(hostB);
    const startsB: Array<AgentLaunchSelection | undefined> = [];
    const appB = createApp({
      render: () => h(SessionLaunchControls, {
        onStart: (selection: AgentLaunchSelection | undefined) => startsB.push(selection),
      }),
    });
    appB.mount(hostB);

    await flush();
    const radiosA = () => Array.from(host.querySelectorAll<HTMLButtonElement>("[role=radiogroup] button[role=radio]"));
    const radiosB = () => Array.from(hostB.querySelectorAll<HTMLButtonElement>("[role=radiogroup] button[role=radio]"));

    pressKey({ key: "Enter" }, radiosA()[0]!);
    await flush();

    expect(starts).toEqual([{ agentType: "claude", modelId: null, effort: null, fast: null }]);
    expect(startsB).toEqual([]);

    pressKey({ key: "Enter" }, radiosB()[0]!);
    await flush();

    expect(starts).toEqual([{ agentType: "claude", modelId: null, effort: null, fast: null }]);
    expect(startsB).toEqual([{ agentType: "claude", modelId: null, effort: null, fast: null }]);

    appB.unmount();
    hostB.remove();
  });
});
