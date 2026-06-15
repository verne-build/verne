import { describe, it, expect } from "vitest";
import { encodeLspFrame, LspFrameDecoder } from "./lsp-cmds";

describe("LSP stdio framing", () => {
  it("encodes a Content-Length frame", () => {
    expect(encodeLspFrame('{"a":1}')).toBe('Content-Length: 7\r\n\r\n{"a":1}');
  });

  it("decodes frames across chunk boundaries", () => {
    const dec = new LspFrameDecoder();
    const out: string[] = [];
    dec.push(Buffer.from("Content-Length: 7\r\n\r"), m => out.push(m));
    dec.push(Buffer.from('\n{"a":'), m => out.push(m));
    dec.push(Buffer.from('1}Content-Length: 3\r\n\r\nabc'), m => out.push(m));
    expect(out).toEqual(['{"a":1}', "abc"]);
  });
});
