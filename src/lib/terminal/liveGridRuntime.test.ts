import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridStore } from './GridStore';
import type { GridSession } from './GridSession';
import { LiveGridRuntimeRegistry, LIVE_GRID_RUNTIME_GRACE_MS } from './liveGridRuntime';

function runtime() {
  return {
    store: new GridStore(),
    session: { dispose: vi.fn() } as unknown as GridSession,
  };
}

describe('LiveGridRuntimeRegistry', () => {
  afterEach(() => vi.useRealTimers());

  it('reclaims the same runtime and cancels pending disposal', async () => {
    vi.useFakeTimers();
    const registry = new LiveGridRuntimeRegistry();
    const firstRuntime = runtime();
    const first = await registry.acquire('s1', async () => firstRuntime);
    first.release();
    const second = await registry.acquire('s1', async () => runtime());
    await vi.advanceTimersByTimeAsync(LIVE_GRID_RUNTIME_GRACE_MS);
    expect(second.runtime).toBe(firstRuntime);
    expect(second.retained).toBe(true);
    expect(firstRuntime.session.dispose).not.toHaveBeenCalled();
    second.release();
    await vi.advanceTimersByTimeAsync(LIVE_GRID_RUNTIME_GRACE_MS);
  });

  it('disposes an unreclaimed runtime after the grace period', async () => {
    vi.useFakeTimers();
    const registry = new LiveGridRuntimeRegistry();
    const value = runtime();
    const lease = await registry.acquire('s1', async () => value);
    lease.release();
    await vi.advanceTimersByTimeAsync(LIVE_GRID_RUNTIME_GRACE_MS);
    expect(value.session.dispose).toHaveBeenCalledOnce();
    expect(registry.has('s1')).toBe(false);
  });

  it('ignores a stale lease release after reacquisition', async () => {
    vi.useFakeTimers();
    const registry = new LiveGridRuntimeRegistry();
    const value = runtime();
    const first = await registry.acquire('s1', async () => value);
    first.release();
    const second = await registry.acquire('s1', async () => runtime());
    first.release();
    await vi.advanceTimersByTimeAsync(LIVE_GRID_RUNTIME_GRACE_MS);
    expect(value.session.dispose).not.toHaveBeenCalled();
    second.release();
    await vi.advanceTimersByTimeAsync(LIVE_GRID_RUNTIME_GRACE_MS);
  });

  it('removes a failed creation so a later acquire can retry', async () => {
    vi.useFakeTimers();
    const registry = new LiveGridRuntimeRegistry();
    await expect(registry.acquire('s1', async () => {
      throw new Error('port unavailable');
    })).rejects.toThrow('port unavailable');
    expect(registry.has('s1')).toBe(false);
    const recovered = runtime();
    const lease = await registry.acquire('s1', async () => recovered);
    expect(lease.runtime).toBe(recovered);
    lease.release();
    await vi.advanceTimersByTimeAsync(LIVE_GRID_RUNTIME_GRACE_MS);
  });

  it('removes a synchronously thrown creation so a later acquire can retry', async () => {
    const registry = new LiveGridRuntimeRegistry();
    await expect(registry.acquire('s1', () => {
      throw new Error('port unavailable');
    })).rejects.toThrow('port unavailable');
    expect(registry.has('s1')).toBe(false);
    const recovered = runtime();
    const lease = await registry.acquire('s1', async () => recovered);
    expect(lease.runtime).toBe(recovered);
  });
});
