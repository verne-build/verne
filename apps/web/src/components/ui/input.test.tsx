import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Input } from "./input";
import { Textarea } from "./textarea";

describe("unstyled form controls", () => {
  it("marks an unstyled input so contextual themes preserve its host surface", () => {
    const unstyled = renderToStaticMarkup(<Input unstyled aria-label="Search" />);
    const styled = renderToStaticMarkup(<Input aria-label="Name" />);

    expect(unstyled).toContain('data-unstyled="true"');
    expect(styled).not.toContain("data-unstyled");
  });

  it("marks an unstyled textarea so contextual themes preserve its host surface", () => {
    const unstyled = renderToStaticMarkup(<Textarea unstyled aria-label="Comment" />);
    const styled = renderToStaticMarkup(<Textarea aria-label="Description" />);

    expect(unstyled).toContain('data-unstyled="true"');
    expect(styled).not.toContain("data-unstyled");
  });
});
