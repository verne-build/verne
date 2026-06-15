import { describe, it, expect } from "vitest";
import { encodeFrame, FrameDecoder } from "./daemon-codec";

describe("frame codec", () => {
  it("encodes length-prefixed JSON", () => {
    const buf = encodeFrame({ id: 1, method: "ping", params: null });
    expect(buf.readUInt32BE(0)).toBe(buf.length - 4);
    expect(JSON.parse(buf.subarray(4).toString("utf8"))).toEqual({ id: 1, method: "ping", params: null });
  });

  it("decodes frames split across chunks", () => {
    const dec = new FrameDecoder();
    const full = encodeFrame({ type: "response", id: 1, result: 42 });
    const out: unknown[] = [];
    dec.push(full.subarray(0, 3), (m) => out.push(m));
    dec.push(full.subarray(3), (m) => out.push(m));
    expect(out).toEqual([{ type: "response", id: 1, result: 42 }]);
  });

  it("decodes two frames in one chunk", () => {
    const dec = new FrameDecoder();
    const a = encodeFrame({ id: 1 }); const b = encodeFrame({ id: 2 });
    const out: unknown[] = [];
    dec.push(Buffer.concat([a, b]), (m) => out.push(m));
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
