import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeNotesStore, notesDir } from "./notes-store";
import { browserControl } from "./browser-forward";

function internalDataDir(): string {
  if (process.env.VERNE_INTERNAL_DATA_DIR) return process.env.VERNE_INTERNAL_DATA_DIR;
  const dev = !!process.env.ELECTRON_RENDERER_URL || process.env.NODE_ENV === "development";
  return join(homedir(), "Library", "Application Support", dev ? "build.verne-dev" : "build.verne");
}

function resolveWorkspace(): string {
  return process.env.VERNE_WORKSPACE_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function resolveAutomationOwner(root: string): string {
  return process.env.VERNE_TAB_ID || `workspace:${root}`;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const jsonText = (v: unknown) => text(JSON.stringify(v));

async function main() {
  const root = resolveWorkspace();
  const automationOwner = resolveAutomationOwner(root);
  const idd = internalDataDir();
  const notes = makeNotesStore(notesDir(idd, root));
  const bc = (body: Record<string, unknown>) => browserControl(idd, root, { ...body, automationOwner });

  const server = new McpServer({ name: "verne", version: "1.0.0" });

  // --- notes ---
  server.registerTool("notes_list", { description: "List the current workspace's notes (slug + title).", inputSchema: z.object({}) },
    async () => jsonText(notes.list()));
  server.registerTool("notes_read", { description: "Read a note's markdown by name or slug. Returns { slug, title, body }.", inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => jsonText(notes.read(name)));
  server.registerTool("notes_create", { description: "Create a new note with a title and optional markdown content. Returns its slug.", inputSchema: z.object({ title: z.string(), content: z.string().optional() }) },
    async ({ title, content }) => text(`Created note '${notes.create(title, content ?? "")}'.`));
  server.registerTool("notes_write", { description: "Overwrite a note's content (creates it if missing). Address by name or slug.", inputSchema: z.object({ name: z.string(), content: z.string() }) },
    async ({ name, content }) => text(`Wrote note '${notes.writeBody(name, content)}'.`));
  server.registerTool("notes_append", { description: "Append markdown to a note (creates it if missing). Address by name or slug.", inputSchema: z.object({ name: z.string(), content: z.string() }) },
    async ({ name, content }) => text(`Appended to note '${notes.append(name, content)}'.`));

  // --- browser (forwarders) ---
  server.registerTool("browser_list", { description: "List open browser tabs in the current workspace. Returns [{id, url, active, owner}], where owner is 'ui' for user-visible tabs or 'automation' for hidden automation tabs.", inputSchema: z.object({}) },
    async () => jsonText((await bc({ action: "list" })).browsers));
  server.registerTool("browser_current", { description: "Return the active user-visible browser tab in the current workspace, or null if none is active. Use this for requests like 'look at this open tab'.", inputSchema: z.object({}) },
    async () => jsonText((await bc({ action: "current" })).browser ?? null));
  server.registerTool("browser_open", { description: "Open a URL in a browser tab. If the same URL is already open in this workspace, focuses that existing tab instead of creating a duplicate. Returns {id, reused}.", inputSchema: z.object({ url: z.string() }) },
    async ({ url }) => { const r = await bc({ action: "open", url }); return jsonText({ id: r.tabId, reused: !!r.reused }); });
  server.registerTool("browser_navigate", { description: "Navigate a browser tab to a URL. Returns {ok, url}.", inputSchema: z.object({ id: z.string(), url: z.string() }) },
    async ({ id, url }) => jsonText(await bc({ action: "navigate", tabId: id, url })));
  for (const action of ["back", "forward", "reload"] as const) {
    server.registerTool(`browser_${action}`, { description: `Browser ${action} for a tab.`, inputSchema: z.object({ id: z.string() }) },
      async ({ id }) => { await bc({ action, tabId: id }); return text("ok"); });
  }
  server.registerTool("browser_snapshot", { description: "Accessibility snapshot of a browser tab (refs like e3 for click/fill).", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => text((await bc({ action: "snapshot", tabId: id })).snapshot));
  server.registerTool("browser_click", { description: "Click an element by ref from browser_snapshot.", inputSchema: z.object({ id: z.string(), ref: z.string() }) },
    async ({ id, ref }) => { await bc({ action: "click", tabId: id, ref }); return text("ok"); });
  server.registerTool("browser_fill", { description: "Fill an input by ref.", inputSchema: z.object({ id: z.string(), ref: z.string(), value: z.string() }) },
    async ({ id, ref, value }) => { await bc({ action: "fill", tabId: id, ref, value }); return text("ok"); });
  server.registerTool("browser_select", { description: "Select an option by value for a <select> by ref.", inputSchema: z.object({ id: z.string(), ref: z.string(), value: z.string() }) },
    async ({ id, ref, value }) => { await bc({ action: "select", tabId: id, ref, value }); return text("ok"); });
  server.registerTool("browser_screenshot", { description: "JPEG screenshot of a browser tab.", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => ({ content: [{ type: "image" as const, data: (await bc({ action: "screenshot", tabId: id })).jpegBase64, mimeType: "image/jpeg" }] }));
  server.registerTool("browser_network", { description: "Recent network requests for a tab.", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => jsonText((await bc({ action: "network", tabId: id })).requests));
  server.registerTool("browser_console", { description: "Console messages for a tab.", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => jsonText((await bc({ action: "console", tabId: id })).messages));
  server.registerTool("browser_wait", { description: "Wait until load/networkidle or a CSS selector appears.", inputSchema: z.object({ id: z.string(), until: z.string(), timeoutMs: z.number().optional() }) },
    async ({ id, until, timeoutMs }) => { await bc({ action: "wait", tabId: id, until, timeoutMs }); return text("ok"); });

  await server.connect(new StdioServerTransport());
}

main().catch((e) => { console.error("verne mcp fatal:", e); process.exit(1); });
