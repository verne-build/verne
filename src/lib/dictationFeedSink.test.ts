import { describe, expect, it } from "vitest";
import { createFeedSink } from "./dictationFeedSink";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createFeedSink", () => {
  it("send does not block on the underlying feed", () => {
    const d = deferred();
    const sink = createFeedSink(() => d.promise);
    // Must return synchronously even though the feed is still pending.
    sink.send(new Float32Array([1]));
    expect(sink.pendingCount()).toBe(1);
  });

  it("drain waits until every in-flight feed settles before resolving", async () => {
    const d1 = deferred();
    const d2 = deferred();
    const queue = [d1, d2];
    const sink = createFeedSink(() => queue.shift()!.promise);

    sink.send(new Float32Array([1]));
    sink.send(new Float32Array([2]));

    let drained = false;
    const drainPromise = sink.drain().then(() => {
      drained = true;
    });

    // One feed still pending -> drain must NOT have resolved.
    d1.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    d2.resolve();
    await drainPromise;
    expect(drained).toBe(true);
    expect(sink.pendingCount()).toBe(0);
  });

  it("drain resolves immediately when nothing is pending", async () => {
    const sink = createFeedSink(() => Promise.resolve());
    await expect(sink.drain()).resolves.toBeUndefined();
  });

  it("a rejected feed still lets drain resolve", async () => {
    const sink = createFeedSink(() => Promise.reject(new Error("ipc gone")));
    sink.send(new Float32Array([1]));
    await expect(sink.drain()).resolves.toBeUndefined();
    expect(sink.pendingCount()).toBe(0);
  });
});
