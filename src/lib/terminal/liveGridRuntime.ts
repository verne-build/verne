import type { GridSession } from './GridSession';
import type { GridStore } from './GridStore';

export const LIVE_GRID_RUNTIME_GRACE_MS = 250;

export interface LiveGridRuntime {
  store: GridStore;
  session: GridSession;
}

export interface LiveGridRuntimeLease {
  runtime: LiveGridRuntime;
  retained: boolean;
  release(): void;
}

export function hasRetainedGridFrame(lease: LiveGridRuntimeLease): boolean {
  const { store } = lease.runtime;
  return lease.retained && store.syncGen > 0 && store.cols > 0 && store.rows > 0;
}

interface Entry {
  owner: number;
  runtime?: LiveGridRuntime;
  creating?: Promise<LiveGridRuntime>;
  disposalTimer?: ReturnType<typeof setTimeout>;
}

export class LiveGridRuntimeRegistry {
  private entries = new Map<string, Entry>();

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  acquireRetained(sessionId: string): LiveGridRuntimeLease | null {
    const entry = this.entries.get(sessionId);
    if (!entry?.runtime) return null;
    if (entry.disposalTimer) {
      clearTimeout(entry.disposalTimer);
      entry.disposalTimer = undefined;
    }
    const token = ++entry.owner;
    return this.lease(sessionId, entry, token, entry.runtime, true);
  }

  async acquire(
    sessionId: string,
    create: () => Promise<LiveGridRuntime>,
  ): Promise<LiveGridRuntimeLease> {
    let entry = this.entries.get(sessionId);
    const retained = entry?.runtime != null;
    if (!entry) {
      entry = { owner: 0 };
      this.entries.set(sessionId, entry);
    }
    if (entry.disposalTimer) {
      clearTimeout(entry.disposalTimer);
      entry.disposalTimer = undefined;
    }
    const token = ++entry.owner;

    if (!entry.runtime) {
      entry.creating ??= Promise.resolve().then(create);
      try {
        entry.runtime = await entry.creating;
      } catch (error) {
        if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
        throw error;
      } finally {
        entry.creating = undefined;
      }
    }

    return this.lease(sessionId, entry, token, entry.runtime, retained);
  }

  private lease(
    sessionId: string,
    entry: Entry,
    token: number,
    runtime: LiveGridRuntime,
    retained: boolean,
  ): LiveGridRuntimeLease {
    let released = false;
    return {
      runtime,
      retained,
      release: () => {
        if (released) return;
        released = true;
        if (this.entries.get(sessionId) !== entry || entry.owner !== token) return;
        entry.disposalTimer = setTimeout(() => {
          if (this.entries.get(sessionId) !== entry || entry.owner !== token) return;
          runtime.session.dispose();
          this.entries.delete(sessionId);
        }, LIVE_GRID_RUNTIME_GRACE_MS);
      },
    };
  }
}

const registry = new LiveGridRuntimeRegistry();

export function acquireLiveGridRuntime(
  sessionId: string,
  create: () => Promise<LiveGridRuntime>,
): Promise<LiveGridRuntimeLease> {
  return registry.acquire(sessionId, create);
}

export function acquireRetainedLiveGridRuntime(
  sessionId: string,
): LiveGridRuntimeLease | null {
  return registry.acquireRetained(sessionId);
}
