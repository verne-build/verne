export const PORT_FORWARD_FRAME_HEADER_BYTES = 5;
export const PORT_FORWARD_MAX_FRAME_DATA_BYTES = 1024 * 1024;

export type PortForwardFrame =
  | { readonly type: "open"; readonly streamId: number }
  | { readonly type: "data"; readonly streamId: number; readonly data: Uint8Array }
  | { readonly type: "end"; readonly streamId: number }
  | { readonly type: "close"; readonly streamId: number }
  | { readonly type: "keepalive"; readonly streamId: 0 };

const FRAME_TYPE = {
  open: 1,
  data: 2,
  end: 3,
  close: 4,
  keepalive: 5,
} as const;

export function encodePortForwardFrame(frame: PortForwardFrame): Uint8Array {
  const streamIdIsUint32 =
    Number.isInteger(frame.streamId) && frame.streamId > 0 && frame.streamId <= 0xffff_ffff;
  if (frame.type === "keepalive" ? frame.streamId !== 0 : !streamIdIsUint32) {
    throw new RangeError("Port-forward frame stream identifier is outside the protocol range.");
  }
  const data = frame.type === "data" ? frame.data : new Uint8Array();
  if (data.byteLength > PORT_FORWARD_MAX_FRAME_DATA_BYTES) {
    throw new RangeError("Port-forward frame data exceeds the protocol limit.");
  }
  const encoded = new Uint8Array(PORT_FORWARD_FRAME_HEADER_BYTES + data.byteLength);
  encoded[0] = FRAME_TYPE[frame.type];
  new DataView(encoded.buffer).setUint32(1, frame.streamId, false);
  encoded.set(data, PORT_FORWARD_FRAME_HEADER_BYTES);
  return encoded;
}

export function decodePortForwardFrame(raw: Uint8Array): PortForwardFrame | null {
  if (
    raw.byteLength < PORT_FORWARD_FRAME_HEADER_BYTES ||
    raw.byteLength > PORT_FORWARD_FRAME_HEADER_BYTES + PORT_FORWARD_MAX_FRAME_DATA_BYTES
  ) {
    return null;
  }
  const streamId = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(1, false);
  switch (raw[0]) {
    case FRAME_TYPE.open:
      return streamId === 0 || raw.byteLength !== PORT_FORWARD_FRAME_HEADER_BYTES
        ? null
        : { type: "open", streamId };
    case FRAME_TYPE.data:
      return streamId === 0
        ? null
        : { type: "data", streamId, data: raw.slice(PORT_FORWARD_FRAME_HEADER_BYTES) };
    case FRAME_TYPE.end:
      return streamId === 0 || raw.byteLength !== PORT_FORWARD_FRAME_HEADER_BYTES
        ? null
        : { type: "end", streamId };
    case FRAME_TYPE.close:
      return streamId === 0 || raw.byteLength !== PORT_FORWARD_FRAME_HEADER_BYTES
        ? null
        : { type: "close", streamId };
    case FRAME_TYPE.keepalive:
      return streamId !== 0 || raw.byteLength !== PORT_FORWARD_FRAME_HEADER_BYTES
        ? null
        : { type: "keepalive", streamId: 0 };
    default:
      return null;
  }
}
