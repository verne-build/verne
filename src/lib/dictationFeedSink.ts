// Wraps the per-chunk audio feed so the dictation stop path can wait for every
// already-captured chunk to reach the worker before sending `stop`. Offline STT
// models (e.g. Parakeet) only decode when stopped, so a chunk lost to the
// stop-vs-feed race truncates the utterance — fatal for short (1-3 word) ones.
export type FeedSink = {
  send: (chunk: Float32Array) => void;
  drain: () => Promise<void>;
  pendingCount: () => number;
};

export function createFeedSink(feed: (chunk: Float32Array) => Promise<unknown> | unknown): FeedSink {
  const pending = new Set<Promise<unknown>>();

  return {
    send(chunk) {
      // Settle (not reject) so a dropped IPC chunk can't wedge drain().
      const p = Promise.resolve(feed(chunk))
        .catch(() => undefined)
        .finally(() => {
          pending.delete(p);
        });
      pending.add(p);
    },
    async drain() {
      // Loop: a feed's .finally could in principle enqueue more before settling.
      while (pending.size) {
        await Promise.allSettled([...pending]);
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}
