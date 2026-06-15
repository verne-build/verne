import { invoke } from "@/platform";
import { createFeedSink } from "@/lib/dictationFeedSink";

// Captures mic audio and streams Float32 PCM chunks (as a Buffer-safe byte view)
// to the main process. Chunks are buffered while the STT model warms up so the
// first words aren't dropped.
export type AudioCapture = {
  // Stop capture and resolve only once every captured chunk has reached the
  // worker. Keeps capturing for a short grace window first so the trailing
  // ScriptProcessor block (~85ms) isn't lost — critical for offline models that
  // only decode on stop, where a clipped tail drops short utterances entirely.
  flush: () => Promise<void>;
  stop: () => Promise<void>;
};

const MAX_BUFFERED_SAMPLES = 16000 * 30; // ~30s safety cap
// One ScriptProcessor block at 4096 samples is ~85ms at 48kHz; 200ms gives the
// final block time to fire and its feed IPC time to reach the worker.
const STOP_GRACE_MS = 200;

export async function startAudioCapture(
  sessionId: string,
  isReady: () => boolean,
): Promise<AudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Raw capture, like native dictation tools (Handy). Chromium's audio
      // processing (echo cancellation / noise suppression / auto gain) adds
      // device-open latency and an AGC ramp that attenuates the first words,
      // and tends to hurt on-device STT accuracy. Feed the model raw audio.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const sampleRate = ctx.sampleRate;

  let buffered: Float32Array[] = [];
  let bufferedCount = 0;

  const sink = createFeedSink((samples: Float32Array) => {
    // Copy the bytes into a standalone Uint8Array so they survive the
    // contextBridge + structured-clone hop intact (a Float32Array view gets
    // zeroed crossing the boundary).
    const u8 = new Uint8Array(
      samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
    );
    return invoke("speech:feedAudio", { buffer: u8, sampleRate, sessionId });
  });
  const send = (samples: Float32Array): void => sink.send(samples);

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const chunk = new Float32Array(input); // input buffer is reused; copy it
    if (!isReady()) {
      if (bufferedCount < MAX_BUFFERED_SAMPLES) {
        buffered.push(chunk);
        bufferedCount += chunk.length;
      }
      return;
    }
    if (buffered.length) {
      for (const b of buffered) send(b);
      buffered = [];
      bufferedCount = 0;
    }
    send(chunk);
  };

  source.connect(processor);
  processor.connect(ctx.destination);

  // Why: a context created outside a user-gesture chain can start suspended,
  // delaying the first audio block and clipping leading audio. Force it running.
  if (ctx.state === "suspended") await ctx.resume();

  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  };

  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  return {
    async flush() {
      if (tornDown) return;
      // Let the trailing audio block fire + its feed IPC dispatch, then stop
      // capturing and wait for every in-flight chunk to reach the worker.
      await wait(STOP_GRACE_MS);
      await teardown();
      await sink.drain();
    },
    stop: teardown,
  };
}
