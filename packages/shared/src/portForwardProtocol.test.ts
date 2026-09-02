import { describe, expect, it } from "vite-plus/test";

import {
  decodePortForwardFrame,
  encodePortForwardFrame,
  PORT_FORWARD_FRAME_HEADER_BYTES,
  PORT_FORWARD_MAX_FRAME_DATA_BYTES,
  type PortForwardFrame,
} from "./portForwardProtocol.ts";

describe("port-forward tunnel frames", () => {
  it("round-trips stream lifecycle and binary data", () => {
    const frames = [
      { type: "open", streamId: 7 } as const,
      { type: "data", streamId: 7, data: new Uint8Array([0, 1, 255]) } as const,
      { type: "end", streamId: 7 } as const,
      { type: "close", streamId: 7 } as const,
      { type: "keepalive", streamId: 0 } as const,
    ];
    for (const frame of frames) {
      expect(decodePortForwardFrame(encodePortForwardFrame(frame))).toEqual(frame);
    }
  });

  it("rejects truncated, unknown, and zero-id stream frames", () => {
    expect(decodePortForwardFrame(new Uint8Array([1, 0]))).toBeNull();
    expect(decodePortForwardFrame(new Uint8Array([99, 0, 0, 0, 1]))).toBeNull();
    expect(decodePortForwardFrame(new Uint8Array([1, 0, 0, 0, 0]))).toBeNull();
  });

  it("rejects stream identifiers that cannot be represented without truncation", () => {
    for (const streamId of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(() => encodePortForwardFrame({ type: "open", streamId } as PortForwardFrame)).toThrow(
        RangeError,
      );
    }
    expect(() =>
      encodePortForwardFrame({ type: "keepalive", streamId: 1 } as unknown as PortForwardFrame),
    ).toThrow(RangeError);
  });

  it("enforces bounded payloads and exact control frame lengths", () => {
    expect(() =>
      encodePortForwardFrame({
        type: "data",
        streamId: 1,
        data: new Uint8Array(PORT_FORWARD_MAX_FRAME_DATA_BYTES + 1),
      }),
    ).toThrow(RangeError);
    expect(
      decodePortForwardFrame(
        new Uint8Array(PORT_FORWARD_FRAME_HEADER_BYTES + PORT_FORWARD_MAX_FRAME_DATA_BYTES + 1),
      ),
    ).toBeNull();
    expect(decodePortForwardFrame(new Uint8Array([1, 0, 0, 0, 1, 99]))).toBeNull();
    expect(decodePortForwardFrame(new Uint8Array([5, 0, 0, 0, 0, 99]))).toBeNull();
  });

  it("does not serialize ticket-like metadata supplied outside the frame contract", () => {
    const secret = "forward-ticket-secret";
    const encoded = encodePortForwardFrame({
      type: "open",
      streamId: 9,
      ticket: secret,
    } as PortForwardFrame & { readonly ticket: string });

    expect(encoded).toHaveLength(PORT_FORWARD_FRAME_HEADER_BYTES);
    expect(new TextDecoder().decode(encoded)).not.toContain(secret);
    expect(decodePortForwardFrame(encoded)).toEqual({ type: "open", streamId: 9 });
  });
});
