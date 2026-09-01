// @effect-diagnostics nodeBuiltinImport:off -- This source contract test reads adjacent static assets.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const mainSource = NodeFS.readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const composerSurfaceSource = NodeFS.readFileSync(
  new URL("./components/chat/ComposerSurface.tsx", import.meta.url),
  "utf8",
);
const verneCssUrl = new URL("./verne-theme.css", import.meta.url);
const verneCssExists = NodeFS.existsSync(verneCssUrl);
const verneCss = verneCssExists ? NodeFS.readFileSync(verneCssUrl, "utf8") : "";

function cssRuleContaining(fragment: string): string {
  const fragmentIndex = verneCss.indexOf(fragment);
  const ruleStart = verneCss.indexOf("{", fragmentIndex);
  const ruleEnd = verneCss.indexOf("}", ruleStart);
  return verneCss.slice(fragmentIndex, ruleEnd + 1);
}

describe("Verne theme CSS", () => {
  it("targets the semantic hooks exposed by the upstream composer surface", () => {
    const composerSlots = ["composer-shell", "composer-host", "composer-context-strip"];

    for (const slot of composerSlots) {
      expect(composerSurfaceSource).toContain(`data-slot="${slot}"`);
      expect(verneCss).toContain(`[data-slot="${slot}"]`);
    }
  });

  it("loads one scoped material layer after the base stylesheet", () => {
    const baseImport = 'import "./index.css";';
    const verneImport = 'import "./verne-theme.css";';

    expect(verneCssExists).toBe(true);
    expect(mainSource).toContain(baseImport);
    expect(mainSource).toContain(verneImport);
    expect(mainSource.indexOf(verneImport)).toBeGreaterThan(mainSource.indexOf(baseImport));
    expect(verneCss).toContain('html[data-theme-id="verne"]');
    expect(verneCss).toContain("--radius: 0.625rem");
    expect(verneCss).toContain("--control-radius: var(--radius-md)");
    expect(verneCss).toContain('[data-slot="card"]');
    expect(verneCss).toContain('[data-slot="input-control"]');
    expect(verneCss).toContain('[data-slot="dialog-popup"]');
    expect(verneCss).toContain('[data-slot="composer-shell"]');
  });

  it("preserves contextual controls while frosting floating surfaces", () => {
    expect(verneCss).toContain('[data-slot="input-control"]:not([data-unstyled])');
    expect(verneCss).toContain('[data-slot="textarea-control"]:not([data-unstyled])');
    expect(verneCss).toContain("backdrop-filter: blur(var(--glass-blur))");
    expect(verneCss).toContain('[data-command-palette="true"]');
    expect(verneCss).toContain("backdrop-filter: blur(24px)");
  });

  it("keeps the command search flat and uses Verne interaction states", () => {
    expect(verneCss).toMatch(/\[data-command-palette="true"\]\s+\[data-slot="input-control"\]/);
    expect(verneCss).toContain('[data-slot="button"]:not([data-variant="link"]):active');
    expect(verneCss).toContain("scale: 0.96");
    expect(verneCss).toContain('[data-slot="command-item"]:is(:hover, [data-highlighted])');
    expect(verneCss).toContain('[data-slot="menu-item"]');
    expect(verneCss).toContain('[data-slot="select-item"]');
  });

  it("gives sidebar metadata and thread titles a quieter hierarchy", () => {
    const rootRule = cssRuleContaining('html[data-theme-id="verne"] {');
    const metadataRule = cssRuleContaining("[data-sidebar-project-name],");
    const branchRule = cssRuleContaining("[data-sidebar-branch-name] {");
    const titleRule = cssRuleContaining("[data-sidebar-thread-title]");

    expect(rootRule).toContain("--sidebar-metadata-foreground:");
    expect(rootRule).toContain("var(--sidebar-muted-foreground) 84%");
    expect(metadataRule).toContain("color: var(--sidebar-metadata-foreground)");
    expect(branchRule).toContain("font-weight: 400");
    expect(titleRule).toContain("font-size: 0.8125rem");
    expect(titleRule).toContain("line-height: 1rem");
  });

  it("keeps repository context uncontained and top drawers attached to the prompt", () => {
    const composerShellRule = cssRuleContaining('[data-slot="composer-shell"] {');
    expect(composerShellRule).toContain("--chat-composer-glass-surface: var(--secondary)");
    const contextStripRule = cssRuleContaining('[data-slot="composer-context-strip"] {');
    expect(contextStripRule).toContain("max-width: 48rem");
    expect(contextStripRule).toContain("border: 0");
    expect(contextStripRule).toContain("border-radius: 0");
    expect(contextStripRule).toContain("background: transparent");
    expect(verneCss).toContain("border: 1px solid var(--chat-composer-outline)");
    const mainSurfaceRule = cssRuleContaining('[data-chat-composer-main-surface="true"] {');
    expect(mainSurfaceRule).not.toContain("border-bottom: 0");
    expect(verneCss).toMatch(
      /\[data-chat-composer-main-surface="true"\]::after\s*\{\s*display: none;/s,
    );
    expect(verneCss).toMatch(
      /\[data-slot="composer-shell"\]:has\(\[data-composer-banner-surface="attached"\]\)\s*:is\(\[data-slot="composer-host"\], \[data-chat-composer-main-surface="true"\]\)\s*\{[^}]*border-top-left-radius: 0;[^}]*border-top-right-radius: 0;/s,
    );
    expect(verneCss).toMatch(
      /\[data-slot="composer-shell"\]:has\(\[data-composer-banner-surface="attached"\]\)\s*\[data-chat-composer-main-surface="true"\]\s*\{[^}]*border-top-color: transparent;/s,
    );
    expect(verneCss).toMatch(
      /\[data-composer-banner-surface="attached"\]::after\s*\{[^}]*bottom: var\(--chat-composer-attachment-overlap\);[^}]*border-bottom: 1px solid var\(--chat-composer-attached-outline\);/s,
    );
    expect(verneCss).toMatch(
      /\[data-composer-command-drawer="true"\]::before\s*\{[^}]*bottom: var\(--chat-composer-attachment-overlap\);[^}]*border: 1px solid var\(--border\);[^}]*border-bottom: 0;[^}]*background: color-mix\([^;]+;[^}]*-webkit-mask-image: none;[^}]*mask-image: none;[^}]*box-shadow: none;/s,
    );
    expect(verneCss).toMatch(
      /\[data-composer-command-drawer="true"\]::after\s*\{[^}]*border-bottom-color: var\(--border\);/s,
    );
    expect(verneCss).toMatch(
      /\[data-chat-composer-main-surface="true"\]\[data-chat-composer-menu-open="true"\]\s*\{[^}]*border-top-left-radius: 0;[^}]*border-top-right-radius: 0;/s,
    );
    expect(verneCss).toMatch(
      /\[data-slot="composer-shell"\]:has\(\[data-chat-composer-menu-open="true"\]\)::before\s*\{[^}]*border-radius: 0 0 22px 22px;/s,
    );
    expect(verneCss).not.toMatch(
      /\[data-chat-composer-main-surface="true"\]\[data-chat-composer-menu-open="true"\]\s*\{[^}]*background:/s,
    );
    expect(verneCss).toContain("box-shadow: none");
  });

  it("removes inset highlights without flattening floating surfaces or modals", () => {
    const floatingSurfaceRule = cssRuleContaining(".dropdown-glass,");
    const modalRule = cssRuleContaining('[data-slot="dialog-popup"],');
    const glassSurfaceRule = cssRuleContaining(".surface-glass {");

    expect(floatingSurfaceRule).toContain("border: 1px solid var(--border)");
    expect(floatingSurfaceRule).toContain("0 12px 32px rgb(0 0 0 / 45%)");
    expect(floatingSurfaceRule).not.toContain("inset");
    expect(glassSurfaceRule).toContain("0 1px 2px rgb(0 0 0 / 20%)");
    expect(glassSurfaceRule).not.toContain("inset");
    expect(modalRule).toContain("inset 1px 0 0 rgb(255 255 255 / 8%)");
    expect(verneCss).toMatch(/\[data-slot="button"\]\s*\{[^}]*--tw-inset-shadow: 0 0 #0000;/s);
    expect(verneCss).toMatch(/\[data-slot="button"\]::before\s*\{\s*box-shadow: none;/s);
  });

  it("avoids repaint-heavy or uninterruptible global transitions", () => {
    expect(verneCss).not.toMatch(/transition\s*:\s*all/i);
    expect(verneCss).not.toMatch(/animation\s*:\s*[^;]*infinite/i);
    expect(verneCss).not.toContain("will-change: all");
  });
});
