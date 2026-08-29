import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerFooterLayout } from "./ComposerFooterLayout";

describe("ComposerFooterLayout", () => {
  it("keeps permissions left and groups model controls immediately before send", () => {
    const markup = renderToStaticMarkup(
      <ComposerFooterLayout
        permissions={<span>permissions</span>}
        modelControls={<span>model and reasoning</span>}
        primaryAction={<span>send</span>}
      />,
    );

    expect(markup.indexOf("permissions")).toBeLessThan(markup.indexOf("model and reasoning"));
    expect(markup.indexOf("model and reasoning")).toBeLessThan(markup.indexOf("send"));
    expect(markup).toContain('data-chat-composer-actions="left"');
    expect(markup).toContain('data-chat-composer-actions="right"');
    expect(markup).toContain("gap-3");
  });
});
