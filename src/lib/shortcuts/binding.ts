// src/lib/shortcuts/binding.ts
// Pure helpers for the normalized binding format used by the shortcut registry.
//
// Format: "+"-joined tokens. Modifiers (any order): Mod (Cmd on macOS / Ctrl
// elsewhere — matches Electron CmdOrCtrl and the renderer's metaKey||ctrlKey),
// plus literal Cmd, Ctrl, Alt, Shift. The final non-modifier token is the key.
// Examples: "Mod+K", "Mod+Shift+P", "Ctrl+`", "Cmd+D".

const MOD_TOKENS = new Set(["Mod", "Cmd", "Ctrl", "Alt", "Shift"]);

export interface ParsedBinding {
  mods: string[];
  key: string;
}

export function parseBinding(binding: string): ParsedBinding {
  const parts = binding.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    if (MOD_TOKENS.has(p)) mods.push(p);
    else key = p; // last non-modifier wins
  }
  return { mods, key };
}

const ELECTRON_MODS: Record<string, string> = {
  Mod: "CmdOrCtrl",
  Cmd: "Command",
  Ctrl: "Control",
  Alt: "Alt",
  Shift: "Shift",
};

export function toElectronAccelerator(binding: string): string {
  const { mods, key } = parseBinding(binding);
  return [...mods.map((m) => ELECTRON_MODS[m] ?? m), key].filter(Boolean).join("+");
}

const MAC_SYMBOLS: Record<string, string> = {
  Mod: "⌘",
  Cmd: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};
const OTHER_SYMBOLS: Record<string, string> = {
  Mod: "Ctrl",
  Cmd: "Win",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
};

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  return /Mac/i.test(uaPlatform ?? navigator.platform ?? "");
}

export function toDisplayKeys(binding: string, platform?: "mac" | "other"): string[] {
  const mac = platform ? platform === "mac" : detectMac();
  const sym = mac ? MAC_SYMBOLS : OTHER_SYMBOLS;
  const { mods, key } = parseBinding(binding);
  return [...mods.map((m) => sym[m] ?? m), key].filter(Boolean);
}

export function matchesEvent(binding: string, e: KeyboardEvent): boolean {
  const { mods, key } = parseBinding(binding);
  const wantMod = mods.includes("Mod");
  const wantCmd = mods.includes("Cmd");
  const wantCtrl = mods.includes("Ctrl");
  const wantAlt = mods.includes("Alt");
  const wantShift = mods.includes("Shift");

  // Mod already means "Cmd or Ctrl"; combining it with a literal Ctrl is not a
  // supported binding and can never match coherently.
  if (wantMod && wantCtrl) return false;

  if (wantMod) {
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else {
    if (wantCmd !== e.metaKey) return false;
    if (wantCtrl !== e.ctrlKey) return false;
  }
  if (wantAlt !== e.altKey) return false;
  if (wantShift !== e.shiftKey) return false;

  const eventKey = e.key.toLowerCase();
  const bindingKey = key.toLowerCase();
  if (eventKey === bindingKey) return true;
  // Shift+/ is reported as "?" by most browsers, but "/" is the shortcut key
  // users expect to see and configure.
  return bindingKey === "/" && wantShift && (eventKey === "?" || e.code === "Slash");
}
