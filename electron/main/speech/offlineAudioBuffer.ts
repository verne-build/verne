// Buffers PCM chunks for offline STT models, which decode the whole utterance at
// once on stop. The worker is kept warm and reused across dictation sessions, so
// the buffer MUST clear between sessions — leftover audio from a prior recording
// would decode concatenated with the next, producing a mangled run-on segment.
export class OfflineAudioBuffer {
  private chunks: Float32Array[] = [];

  push(chunk: Float32Array): void {
    this.chunks.push(chunk);
  }

  // Atomically return all buffered samples concatenated and clear the buffer.
  // Clearing up-front (before the caller decodes) means a decode failure can't
  // leak this session's audio into the next take. Returns null when empty.
  takeCombined(): Float32Array | null {
    const chunks = this.chunks;
    this.chunks = [];
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    if (total === 0) return null;
    const combined = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    return combined;
  }

  // Discard buffered audio without decoding it (e.g. on a fresh session start).
  reset(): void {
    this.chunks = [];
  }
}
