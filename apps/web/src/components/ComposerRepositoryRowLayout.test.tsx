import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerRepositoryRowLayout } from "./ComposerRepositoryRowLayout";

describe("ComposerRepositoryRowLayout", () => {
  it("keeps branch and checkout together on the left and context on the right", () => {
    const markup = renderToStaticMarkup(
      <ComposerRepositoryRowLayout
        branch={<span>branch</span>}
        checkout={<span>checkout</span>}
        context={<span>context</span>}
      />,
    );

    expect(markup.indexOf("branch")).toBeLessThan(markup.indexOf("checkout"));
    expect(markup.indexOf("checkout")).toBeLessThan(markup.indexOf("context"));
    expect(markup).toContain('data-composer-repository-controls="left"');
    expect(markup).toContain('data-composer-repository-context="right"');
  });
});
