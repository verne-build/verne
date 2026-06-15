import { describe, expect, it } from "vitest";
import { OfflineAudioBuffer } from "./offlineAudioBuffer";

describe("OfflineAudioBuffer", () => {
  it("concatenates pushed chunks in order", () => {
    const buf = new OfflineAudioBuffer();
    buf.push(new Float32Array([1, 2]));
    buf.push(new Float32Array([3]));
    expect(Array.from(buf.takeCombined()!)).toEqual([1, 2, 3]);
  });

  it("clears on take, so a second take returns null (no bleed into next session)", () => {
    const buf = new OfflineAudioBuffer();
    buf.push(new Float32Array([1, 2]));
    buf.takeCombined();
    expect(buf.takeCombined()).toBeNull();
  });

  it("returns null when empty", () => {
    expect(new OfflineAudioBuffer().takeCombined()).toBeNull();
  });

  it("reset drops buffered audio without decoding it", () => {
    const buf = new OfflineAudioBuffer();
    buf.push(new Float32Array([1, 2]));
    buf.reset();
    expect(buf.takeCombined()).toBeNull();
  });
});
