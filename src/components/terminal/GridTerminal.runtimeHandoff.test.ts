// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';

const testState = vi.hoisted(() => ({
  acquire: vi.fn(),
  controllerResize: vi.fn(),
  controllerCommitResize: vi.fn(),
  controllerSetMetrics: vi.fn(),
  controllerRepaint: vi.fn(),
  rendererResize: vi.fn(),
  lease: null as unknown,
}));

vi.mock('@/composables/useRpc', () => ({
  useRpc: () => ({ request: { getWsPort: vi.fn() } }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      __v_isRef: true,
      value: {
        terminalPadding: 10,
        terminalFontFamily: 'monospace',
        terminalFontSize: 13,
        terminalLineHeight: 1.2,
        terminalFontLigatures: false,
        terminalBoldIsBright: false,
        terminalMinimumContrast: 1,
        terminalRenderer: 'canvas',
      },
    },
  }),
}));

const ansi = {
  black: '#000000', red: '#ff0000', green: '#00ff00', yellow: '#ffff00',
  blue: '#0000ff', magenta: '#ff00ff', cyan: '#00ffff', white: '#ffffff',
};

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    themeVersion: { __v_isRef: true, value: 0 },
    getActiveThemeSpec: () => ({
      editor: { 'editor.background': '#000000' },
      terminal: {
        background: '#000000',
        foreground: '#ffffff',
        cursor: '#ffffff',
        ansi,
        ansiBright: ansi,
      },
    }),
  }),
}));

vi.mock('@/composables/useTerminal', () => ({
  registerGridSession: vi.fn(),
  unregisterGridSession: vi.fn(),
}));

vi.mock('@/platform', () => ({ invoke: vi.fn() }));

vi.mock('@/lib/terminal/liveGridRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/terminal/liveGridRuntime')>();
  return {
    ...actual,
    acquireLiveGridRuntime: (...args: unknown[]) => testState.acquire(...args),
  };
});

const fakeRenderer = {
  cursorVisible: true,
  resize: (...args: unknown[]) => testState.rendererResize(...args),
  paint: vi.fn(),
  dispose: vi.fn(),
  setDpr: vi.fn(),
  setFocused: vi.fn(),
};

vi.mock('@/lib/terminal/createRenderer', () => ({
  createRenderer: () => ({ renderer: fakeRenderer, kind: 'canvas2d' }),
  makeCanvas2D: () => fakeRenderer,
}));

vi.mock('@/lib/terminal/TerminalController', () => ({
  TerminalController: class {
    store: unknown;
    ime = { onPreedit: undefined as (() => void) | undefined };
    onAfterPaint?: () => void;
    onScroll?: () => void;
    onResizeCommit?: (cols: number, rows: number) => void;

    constructor(opts: { store: unknown }) {
      this.store = opts.store;
    }

    resize(...args: unknown[]) { testState.controllerResize(...args); }
    commitResize() { testState.controllerCommitResize(); }
    setMetrics(...args: unknown[]) { testState.controllerSetMetrics(...args); }
    repaint() { testState.controllerRepaint(); }
    dispose() {}
  },
}));

import GridTerminal from './GridTerminal.vue';
import { GridStore } from '@/lib/terminal/GridStore';

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe('GridTerminal retained runtime handoff', () => {
  let host: HTMLDivElement;
  let app: ReturnType<typeof createApp> | null;

  beforeEach(() => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: () => ({ width: 8 }),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const store = new GridStore();
    store.applySync({
      type: 'sync', rev: 1, cols: 80, rows: 24, cursor: [0, 0],
      altScreen: false,
      modes: {
        mouseReporting: false,
        altScreen: false,
        appCursor: false,
        bracketedPaste: false,
      },
      totalLines: 24,
      runs: [],
    });
    testState.lease = {
      runtime: { store, session: { dispose: vi.fn() } },
      retained: true,
      release: vi.fn(),
    };
    testState.acquire.mockReset().mockResolvedValue(testState.lease);
    testState.controllerResize.mockReset();
    testState.controllerCommitResize.mockReset();
    testState.controllerSetMetrics.mockReset();
    testState.controllerRepaint.mockReset();
    testState.rendererResize.mockReset();
    fakeRenderer.dispose.mockReset();

    host = document.createElement('div');
    document.body.append(host);
    app = createApp({ render: () => h(GridTerminal, { sessionId: 's1', autoFocus: false }) });
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    host.remove();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('holds the first resize after painting a retained frame at unchanged DPR', async () => {
    app!.mount(host);
    await flush();

    expect(testState.rendererResize).toHaveBeenCalledWith(80, 24, 1);
    expect(testState.controllerRepaint).toHaveBeenCalled();
    expect(testState.controllerResize).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      { hold: true },
    );
    expect(testState.controllerCommitResize).not.toHaveBeenCalled();
  });

  it('disposes the renderer once when unmounted during runtime acquisition', async () => {
    let resolveAcquire!: (lease: unknown) => void;
    testState.acquire.mockReturnValue(new Promise((resolve) => {
      resolveAcquire = resolve;
    }));
    app!.mount(host);
    await flush();

    app!.unmount();
    app = null;
    expect(fakeRenderer.dispose).toHaveBeenCalledOnce();

    resolveAcquire(testState.lease);
    await flush();
    expect(fakeRenderer.dispose).toHaveBeenCalledOnce();
  });
});
