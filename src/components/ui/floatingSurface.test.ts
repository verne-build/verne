import { describe, expect, it } from "vitest";
import { floatingSurfaceVariants } from "./floatingSurface";

describe("floatingSurfaceVariants", () => {
  it("renders glass as one stable bordered surface", () => {
    const classes = floatingSurfaceVariants().split(" ");

    expect(classes).toContain("border");
    expect(classes).toContain("border-border/60");
    expect(classes).toContain("floating-surface-glass");
    expect(classes).toContain("backdrop-blur-[16px]");
    expect(classes).toContain(
      "bg-[color-mix(in_oklab,var(--color-background)_88%,white_12%)]/80",
    );
    expect(classes.some((className) => className.startsWith("before:"))).toBe(false);
  });

  it("keeps the solid surface available as an override", () => {
    const classes = floatingSurfaceVariants({ variant: "solid" });
    const tokens = classes.split(" ");

    expect(classes).toContain("bg-popover");
    expect(classes).not.toContain("backdrop-blur");
    expect(tokens).toContain("floating-surface-solid");
  });
});
