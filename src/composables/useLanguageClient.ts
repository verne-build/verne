/**
 * Minimal LSP client using raw WebSocket + Monaco provider APIs.
 * Avoids @codingame/monaco-vscode-api which is pinned to Monaco 0.45.x.
 */
import * as monaco from "monaco-editor";
import { reactive } from "vue";
import { toast } from "vue-sonner";
import { invoke } from "@/platform";
import { setTypeScriptBuiltInHoversSuppressed } from "@/lib/monacoBootstrap";
import {
  analyzeEditorContent,
  shouldDisableLanguageFeaturesForModel,
} from "@/lib/editorLargeFile";
import { useSettings } from "./useSettings";
import type {
  InitializeParams,
  InitializeResult,
  CompletionList,
  CompletionItem,
  Hover,
  Location,
  PublishDiagnosticsParams,
  SignatureHelp,
  Range,
  Position,
} from "vscode-languageserver-protocol";

interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

// Maps Monaco language IDs → LSP language registry key (matches lsp_registry.rs)
export const LSP_LANGUAGE_MAP: Record<string, string> = {
  typescript: "typescript",
  javascript: "typescript",
  vue: "typescript", // TypeScript LS handles Vue via @vue/typescript-plugin (configured by Nuxt)
};

export type LspStatus = "connecting" | "ready" | "error";
export const lspStatuses = reactive<Record<string, LspStatus>>({});

const clients = new Map<string, LspConnection>();
const startingClients = new Set<string>();
const providerDisposables = new Map<string, monaco.IDisposable[]>();

function key(rootDir: string, language: string) {
  return `${rootDir}::${language}`;
}

function languageLabel(language: string): string {
  return language === "typescript" ? "TypeScript Language Server" : "Language Server";
}

function syncTypeScriptBuiltInHoverState(): void {
  const hasTypeScriptLsp = Array.from(startingClients).some(k => k.endsWith("::typescript"))
    || Array.from(clients.values()).some(conn => conn.language === "typescript" && !conn.closed);
  setTypeScriptBuiltInHoversSuppressed(hasTypeScriptLsp);
}

function toastIdFor(statusKey: string): string {
  return `lsp-startup:${statusKey}`;
}

function showStartingToast(statusKey: string, language: string) {
  toast.loading(`Starting ${languageLabel(language)}`, {
    id: toastIdFor(statusKey),
    duration: Infinity,
  });
}

function showReadyToast(statusKey: string, language: string) {
  const id = toastIdFor(statusKey);
  toast.success(`${languageLabel(language)} Ready`, {
    id,
    duration: 1000,
  });
  setTimeout(() => toast.dismiss(id), 1000);
}

function showFailedToast(statusKey: string, language: string, error: unknown) {
  toast.error(`${languageLabel(language)} Failed`, {
    id: toastIdFor(statusKey),
    description: error instanceof Error ? error.message : String(error),
    duration: 6000,
  });
}

function normalizeFsPath(path: string): string {
  if (path.length > 1) return path.replace(/\/+$/, "");
  return path;
}

function uriFsPath(uri: monaco.Uri): string | null {
  if (uri.scheme !== "file") return null;
  return normalizeFsPath(decodeURIComponent(uri.path));
}

function isPathInRoot(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(rootPath + "/");
}

function getConnectionForModel(model: monaco.editor.ITextModel): LspConnection | null {
  const language = LSP_LANGUAGE_MAP[model.getLanguageId()];
  if (!language) return null;

  let best: LspConnection | null = null;
  let bestRootLength = -1;
  for (const conn of clients.values()) {
    if (conn.closed || conn.language !== language || !conn.matchesModel(model)) continue;
    if (conn.rootPath.length > bestRootLength) {
      best = conn;
      bestRootLength = conn.rootPath.length;
    }
  }
  return best;
}

function ensureProvidersForLanguage(monacoLanguage: string) {
  if (providerDisposables.has(monacoLanguage)) return;

  const resolve = <T>(
    model: monaco.editor.ITextModel,
    handler: (conn: LspConnection) => Promise<T | null>,
  ) => {
    const conn = getConnectionForModel(model);
    if (!conn) return Promise.resolve(null);
    return handler(conn);
  };

  providerDisposables.set(monacoLanguage, [
    monaco.languages.registerHoverProvider(monacoLanguage, {
      provideHover(model, position) {
        return resolve(model, (conn) => conn.provideHover(model, position));
      },
    }),
    monaco.languages.registerCompletionItemProvider(monacoLanguage, {
      triggerCharacters: [".", ":", "<", '"', "'", "/", "@", "*"],
      provideCompletionItems(model, position) {
        return resolve(model, (conn) => conn.provideCompletionItems(model, position));
      },
    }),
    monaco.languages.registerDefinitionProvider(monacoLanguage, {
      provideDefinition(model, position) {
        return resolve(model, (conn) => conn.provideDefinition(model, position));
      },
    }),
    monaco.languages.registerReferenceProvider(monacoLanguage, {
      provideReferences(model, position, context) {
        return resolve(model, (conn) => conn.provideReferences(model, position, context));
      },
    }),
    monaco.languages.registerSignatureHelpProvider(monacoLanguage, {
      signatureHelpTriggerCharacters: ["(", ","],
      provideSignatureHelp(model, position) {
        return resolve(model, (conn) => conn.provideSignatureHelp(model, position));
      },
    }),
    monaco.languages.registerLinkProvider(monacoLanguage, {
      provideLinks(model) {
        return resolve(model, (conn) => conn.provideLinks(model));
      },
      async resolveLink(link) {
        return link;
      },
    }),
  ]);
}

// ---- LSP ↔ Monaco type converters ----

function lspRange(r: Range): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

function monacoPos(p: monaco.Position): Position {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

function lspSeverity(s: number | undefined): monaco.MarkerSeverity {
  switch (s) {
    case 1: return monaco.MarkerSeverity.Error;
    case 2: return monaco.MarkerSeverity.Warning;
    case 3: return monaco.MarkerSeverity.Info;
    default: return monaco.MarkerSeverity.Hint;
  }
}

function lspCompletionKind(k: number | undefined): monaco.languages.CompletionItemKind {
  // LSP CompletionItemKind → Monaco CompletionItemKind (both 1-indexed, mostly match)
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    14: monaco.languages.CompletionItemKind.Keyword,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
  };
  return map[k ?? 0] ?? monaco.languages.CompletionItemKind.Text;
}

function markdownContent(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return (value as unknown[]).map(v => markdownContent(v)).join("\n\n");
  const v = value as Record<string, unknown>;
  return typeof v.value === "string" ? v.value : "";
}

// ---- JSON-RPC message router ----

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

class LspConnection {
  private ws: WebSocket;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposables: monaco.IDisposable[] = [];
  private rootUri: string;
  private statusKey: string;
  private tsserverPath?: string;
  private bundledNodeModules?: string;
  private monacoLanguages: string[];
  private peekModelUris = new Set<string>();
  private modelChangeDisposables = new Map<string, monaco.IDisposable>();
  public closed = false;
  public rootPath: string;
  public language: string;

  constructor(
    ws: WebSocket,
    rootUri: string,
    rootPath: string,
    language: string,
    statusKey: string,
    monacoLanguages: string[],
    tsserverPath?: string,
    bundledNodeModules?: string,
  ) {
    this.ws = ws;
    this.rootUri = rootUri;
    this.rootPath = normalizeFsPath(rootPath);
    this.language = language;
    this.statusKey = statusKey;
    this.monacoLanguages = monacoLanguages;
    this.tsserverPath = tsserverPath;
    this.bundledNodeModules = bundledNodeModules;
    ws.onmessage = (e) => this.onMessage(e.data as string);
    ws.onclose = () => {
      this.closed = true;
      clients.delete(this.statusKey);
      syncTypeScriptBuiltInHoverState();
      // Reject all pending requests so initialize() throws and status → error
      for (const [, req] of this.pending) req.reject(new Error("LSP WebSocket closed"));
      this.pending.clear();
      this.dispose();
    };
  }

  start() {
    this.initialize();
  }

  private onMessage(data: string) {
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }

    if ("id" in msg && "result" in msg) {
      // Client → server request response
      this.pending.get(msg.id)?.resolve(msg.result);
      this.pending.delete(msg.id);
    } else if ("id" in msg && "error" in msg) {
      this.pending.get(msg.id)?.reject(msg.error);
      this.pending.delete(msg.id);
    } else if ("id" in msg && "method" in msg) {
      // Server → client request: must reply or the server can deadlock
      this.handleServerRequest(msg.id, msg.method, msg.params);
    } else if (msg.method === "tsserver/request") {
      // Volar sends this to proxy commands to @vue/typescript-plugin via tsserver.
      // We don't have a real tsserver plugin, so respond with failure so Volar falls back internally.
      this.handleTsserverRequest(msg.params);
    } else if (msg.method === "textDocument/publishDiagnostics") {
      this.onDiagnostics(msg.params as PublishDiagnosticsParams);
    }
  }

  private handleTsserverRequest(params: unknown) {
    // params: [[requestSeq, command, args], ...]
    // response params must be [[responseObj], ...] — each entry is an array (Volar iterates it)
    const requests = Array.isArray(params) ? params : [params];
    const responses = requests.map((req: any) => {
      const requestSeq = Array.isArray(req) ? req[0] : 0;
      const command = Array.isArray(req) ? req[1] : "";

      // _vue:projectInfo: must succeed or Volar won't activate its language service
      if (command === "_vue:projectInfo") {
        const rootDir = this.rootUri.replace(/^file:\/\//, "");
        return [{ type: "response", seq: 0, request_seq: requestSeq, command, success: true, body: {
          name: rootDir + "/tsconfig.json",
          kind: "configured",
          languageService: "enabled",
        }}];
      }

      // Other _vue:* plugin commands — we don't have a real tsserver plugin
      return [{ type: "response", seq: 0, request_seq: requestSeq, command, success: false, message: "no plugin" }];
    });
    this.notify("tsserver/response", responses);
  }

  private handleServerRequest(id: number, method: string, params: unknown) {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = (params as any)?.items ?? [];
      result = items.map((item: any) => {
        const section = item?.section ?? "";
        if (section === "typescript") {
          return {
            tsserver: { maxTsServerMemory: 1024 },
            disableAutomaticTypeAcquisition: true,
          };
        }
        if (section === "javascript") {
          return { disableAutomaticTypeAcquisition: true };
        }
        return null;
      });
    }
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private request<T>(method: string, params: unknown, timeoutMs = 60000): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  private notify(method: string, params: unknown) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private buildInitOptions(): unknown {
    if (!this.tsserverPath) return undefined;
    const opts: Record<string, unknown> = { tsserver: { path: this.tsserverPath } };
    // If serving Vue files, load @vue/typescript-plugin from bundled node_modules
    if (this.monacoLanguages.includes("vue") && this.bundledNodeModules) {
      opts.plugins = [{
        name: "@vue/typescript-plugin",
        location: `${this.bundledNodeModules}/@vue/typescript-plugin`,
        languages: ["vue"],
      }];
    }
    return opts;
  }

  private async initialize() {
    try {
      lspStatuses[this.statusKey] = "connecting";
      await this.request<InitializeResult>("initialize", {
        processId: null,
        rootUri: this.rootUri,
        initializationOptions: this.buildInitOptions(),
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            completion: {
              completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"] },
            },
            definition: { linkSupport: true },
            references: {},
            publishDiagnostics: { relatedInformation: false },
            signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
          },
          workspace: { workspaceFolders: true },
        },
        workspaceFolders: [{ uri: this.rootUri, name: "root" }],
      } satisfies Partial<InitializeParams>);
      this.notify("initialized", {});
      this.registerModelLifecycle();
      this.monacoLanguages.forEach(ensureProvidersForLanguage);
      lspStatuses[this.statusKey] = "ready";
      showReadyToast(this.statusKey, this.language);
    } catch (e) {
      lspStatuses[this.statusKey] = "error";
      showFailedToast(this.statusKey, this.language, e);
      this.closed = true;
      clients.delete(this.statusKey);
      syncTypeScriptBuiltInHoverState();
      this.dispose();
      invoke("stop_lsp", { rootDir: this.rootPath, language: this.language }).catch(() => {});
    }
  }

  private onDiagnostics(params: PublishDiagnosticsParams) {
    // Find model by URI
    const uri = monaco.Uri.parse(params.uri);
    const model = monaco.editor.getModel(uri);
    if (!model || !this.matchesModel(model)) return;
    monaco.editor.setModelMarkers(model, "lsp", params.diagnostics.map(d => ({
      ...lspRange(d.range),
      // LSP 3.18 widened message to string | MarkupContent; we don't opt into
      // markupMessageSupport, so it's always a string, but normalize for the type.
      message: typeof d.message === "string" ? d.message : d.message.value,
      severity: lspSeverity(d.severity),
      source: d.source,
    })));
  }

  private textDocumentIdentifier(model: monaco.editor.ITextModel) {
    return { uri: model.uri.toString() };
  }

  private matchesUri(uri: monaco.Uri): boolean {
    const path = uriFsPath(uri);
    return path !== null && isPathInRoot(path, this.rootPath);
  }

  matchesModel(model: monaco.editor.ITextModel): boolean {
    return this.monacoLanguages.includes(model.getLanguageId())
      && this.matchesUri(model.uri)
      && !shouldDisableLanguageFeaturesForModel(model);
  }

  private openDocument(model: monaco.editor.ITextModel) {
    this.notify("textDocument/didOpen", {
      textDocument: {
        ...this.textDocumentIdentifier(model),
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
  }

  private closeDocument(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    const changeDisposable = this.modelChangeDisposables.get(uri);
    if (!changeDisposable) return;
    changeDisposable.dispose();
    this.modelChangeDisposables.delete(uri);
    monaco.editor.setModelMarkers(model, "lsp", []);
    try {
      this.notify("textDocument/didClose", {
        textDocument: this.textDocumentIdentifier(model),
      });
    } catch {}
  }

  private trackModel(model: monaco.editor.ITextModel, allowPeekOpen = false) {
    if (!this.matchesModel(model)) {
      this.closeDocument(model);
      return;
    }
    const uri = model.uri.toString();
    if (!allowPeekOpen && this.peekModelUris.delete(uri)) return;
    this.peekModelUris.delete(uri);
    if (this.modelChangeDisposables.has(uri)) return;
    this.openDocument(model);
    this.modelChangeDisposables.set(uri, model.onDidChangeContent((e) => {
      this.notify("textDocument/didChange", {
        textDocument: { ...this.textDocumentIdentifier(model), version: model.getVersionId() },
        contentChanges: e.changes.map(c => ({
          range: {
            start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
            end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 },
          },
          rangeLength: c.rangeLength,
          text: c.text,
        })),
      });
    }));
  }

  private ensureModelOpen(model: monaco.editor.ITextModel): boolean {
    this.trackModel(model, true);
    return this.modelChangeDisposables.has(model.uri.toString());
  }

  private registerModelLifecycle() {
    for (const model of monaco.editor.getModels()) {
      this.trackModel(model);
    }

    this.disposables.push(
      monaco.editor.onDidCreateModel((model) => {
        this.trackModel(model);
      }),
    );
    this.disposables.push(
      monaco.editor.onWillDisposeModel((model) => {
        this.closeDocument(model);
      }),
    );
    this.disposables.push(
      monaco.editor.onDidChangeModelLanguage((event) => {
        this.trackModel(event.model);
      }),
    );
  }

  async provideHover(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Hover | null> {
    if (this.closed || !this.ensureModelOpen(model)) return null;
    try {
      const result = await this.request<Hover | null>("textDocument/hover", {
        textDocument: this.textDocumentIdentifier(model),
        position: monacoPos(position),
      });
      if (!result) return null;
      return {
        range: result.range ? lspRange(result.range) : undefined,
        contents: [{ value: markdownContent(result.contents) }],
      };
    } catch {
      return null;
    }
  }

  async provideCompletionItems(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.CompletionList | null> {
    if (this.closed || !this.ensureModelOpen(model)) return null;
    try {
      const result = await this.request<CompletionList | CompletionItem[] | null>(
        "textDocument/completion",
        {
          textDocument: this.textDocumentIdentifier(model),
          position: monacoPos(position),
        },
      );
      if (!result) return null;
      const items = Array.isArray(result) ? result : result.items;
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: items.map(item => ({
          label: item.label,
          kind: lspCompletionKind(item.kind),
          insertText: item.insertText ?? item.label,
          detail: item.detail,
          documentation: item.documentation ? { value: markdownContent(item.documentation) } : undefined,
          range,
        })),
      };
    } catch {
      return null;
    }
  }

  async provideDefinition(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Definition | null> {
    if (this.closed || !this.ensureModelOpen(model)) return null;
    try {
      const result = await this.request<Location | Location[] | LocationLink | LocationLink[] | null>(
        "textDocument/definition",
        {
          textDocument: this.textDocumentIdentifier(model),
          position: monacoPos(position),
        },
      );
      if (!result) return null;
      const items = Array.isArray(result) ? result : [result];
      const mapped = items.map((item: any) => {
        if ("targetUri" in item) {
          const link: LocationLink = item;
          return {
            uri: monaco.Uri.parse(link.targetUri),
            range: lspRange(link.targetSelectionRange),
            originSelectionRange: link.originSelectionRange ? lspRange(link.originSelectionRange) : undefined,
          };
        }
        return {
          uri: monaco.Uri.parse(item.uri),
          range: lspRange(item.range),
        };
      });
      await Promise.all(mapped.map(async (r) => {
        if (r.uri.toString() === model.uri.toString()) return;
        if (monaco.editor.getModel(r.uri)) return;
        try {
          const file = await invoke<{ content: string; language: string }>("read_file", { path: r.uri.path });
          if (analyzeEditorContent(file.content).shouldDisableLanguageFeatures) return;
          if (monaco.editor.getModel(r.uri)) return;
          this.peekModelUris.add(r.uri.toString());
          monaco.editor.createModel(file.content, file.language ?? "plaintext", r.uri);
        } catch {}
      }));
      const curUri = model.uri.toString();
      const filtered = mapped.filter((r) => {
        if (r.uri.toString() !== curUri) return true;
        return !(r.range.startLineNumber <= position.lineNumber && position.lineNumber <= r.range.endLineNumber);
      });
      return filtered.length > 0 ? filtered : mapped;
    } catch {
      return null;
    }
  }

  async provideReferences(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.ReferenceContext,
  ): Promise<monaco.languages.Location[] | null> {
    if (this.closed || !this.ensureModelOpen(model)) return null;
    try {
      const result = await this.request<Location[] | null>("textDocument/references", {
        textDocument: this.textDocumentIdentifier(model),
        position: monacoPos(position),
        context: { includeDeclaration: context.includeDeclaration },
      });
      if (!result) return null;
      return result.map(loc => ({
        uri: monaco.Uri.parse(loc.uri),
        range: lspRange(loc.range),
      }));
    } catch {
      return null;
    }
  }

  async provideSignatureHelp(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.SignatureHelpResult | null> {
    if (this.closed || !this.ensureModelOpen(model)) return null;
    try {
      const result = await this.request<SignatureHelp | null>("textDocument/signatureHelp", {
        textDocument: this.textDocumentIdentifier(model),
        position: monacoPos(position),
      });
      if (!result) return null;
      return {
        value: {
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
          signatures: result.signatures.map(sig => ({
            label: sig.label,
            documentation: sig.documentation ? { value: markdownContent(sig.documentation) } : undefined,
            parameters: (sig.parameters ?? []).map(p => ({
              label: p.label,
              documentation: p.documentation ? { value: markdownContent(p.documentation) } : undefined,
            })),
          })),
        },
        dispose: () => {},
      };
    } catch {
      return null;
    }
  }

  async provideLinks(
    model: monaco.editor.ITextModel,
  ): Promise<monaco.languages.ILinksList | null> {
    if (this.closed || !this.ensureModelOpen(model)) return null;
    try {
      const result = await this.request<{ range: Range; target?: string }[] | null>(
        "textDocument/documentLink",
        { textDocument: this.textDocumentIdentifier(model) },
      );
      if (!result) return null;
      return {
        links: result.map(link => ({
          range: lspRange(link.range),
          url: link.target ? monaco.Uri.parse(link.target) : undefined,
        })),
      };
    } catch {
      return null;
    }
  }

  dispose() {
    this.modelChangeDisposables.forEach(d => d.dispose());
    this.modelChangeDisposables.clear();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    if (this.ws.readyState === WebSocket.OPEN) {
      // Graceful LSP shutdown: request → exit → close
      this.request("shutdown", null, 3000)
        .catch(() => {})
        .finally(() => {
          try { this.notify("exit", null); } catch {}
          setTimeout(() => this.ws.close(), 100);
        });
    }
  }
}

// ---- Public API ----

export async function getOrStartClient(
  rootDir: string,
  monacoLangId: string,
): Promise<void> {
  const language = LSP_LANGUAGE_MAP[monacoLangId];
  if (!language) return;

  const { settings } = useSettings();
  if (!settings.value.lspEnabled) return;

  const k = key(rootDir, language);
  const existing = clients.get(k);
  if (existing && !existing.closed) return;
  if (startingClients.has(k)) return;
  // Clean up any stale connection + Rust-side instance before starting fresh.
  if (existing) clients.delete(k);
  try { await invoke("stop_lsp", { rootDir, language }); } catch {}
  startingClients.add(k);
  syncTypeScriptBuiltInHoverState();

  let port: number;
  let tsserverPath: string | null = null;
  let bundledNodeModules: string | null = null;
  showStartingToast(k, language);
  try {
    const result = await invoke<{ port: number; tsserver_path: string | null; bundled_node_modules: string | null }>("start_lsp", { rootDir, language });
    port = result.port;
    tsserverPath = result.tsserver_path;
    bundledNodeModules = result.bundled_node_modules;
  } catch (e) {
    lspStatuses[k] = "error";
    showFailedToast(k, language, e);
    startingClients.delete(k);
    syncTypeScriptBuiltInHoverState();
    return;
  }

  // Retry WS connection — bridge task may not be accepting yet
  let ws: WebSocket | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 500));
    const candidate = new WebSocket(`ws://127.0.0.1:${port}`);
    const ok = await new Promise<boolean>((resolve) => {
      candidate.onopen = () => resolve(true);
      candidate.onerror = () => resolve(false);
    });
    if (ok) { ws = candidate; break; }
    candidate.close();
  }

  if (!ws) {
    lspStatuses[k] = "error";
    showFailedToast(k, language, "WebSocket connection failed after retries");
    try { await invoke("stop_lsp", { rootDir, language }); } catch {}
    startingClients.delete(k);
    syncTypeScriptBuiltInHoverState();
    return;
  }

  // Determine which Monaco language IDs this LSP server handles
  const monacoLanguages = Object.entries(LSP_LANGUAGE_MAP)
    .filter(([, lspLang]) => lspLang === language)
    .map(([monacoLang]) => monacoLang);

  const rootUri = `file://${rootDir}`;
  const conn = new LspConnection(
    ws,
    rootUri,
    rootDir,
    language,
    k,
    monacoLanguages,
    tsserverPath ?? undefined,
    bundledNodeModules ?? undefined,
  );
  clients.set(k, conn);
  startingClients.delete(k);
  syncTypeScriptBuiltInHoverState();
  conn.start();
}

export async function stopClient(rootDir: string, language: string): Promise<void> {
  const k = key(rootDir, language);
  startingClients.delete(k);
  const conn = clients.get(k);
  if (conn) {
    conn.dispose();
    clients.delete(k);
  }
  syncTypeScriptBuiltInHoverState();
  toast.dismiss(toastIdFor(k));
  delete lspStatuses[k];
  try {
    await invoke("stop_lsp", { rootDir, language });
  } catch {}
}

export async function stopAllClients(): Promise<void> {
  const entries = Array.from(clients.entries());
  clients.clear();
  startingClients.clear();
  syncTypeScriptBuiltInHoverState();
  await Promise.all(
    entries.map(async ([k, conn]) => {
      conn.dispose();
      toast.dismiss(toastIdFor(k));
      delete lspStatuses[k];
      const [rootDir, language] = k.split("::");
      try { await invoke("stop_lsp", { rootDir, language }); } catch {}
    }),
  );
}
