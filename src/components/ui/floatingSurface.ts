import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export const floatingSurfaceVariants = cva("text-popover-foreground", {
  variants: {
    variant: {
      glass:
        "floating-surface-glass border border-border/60 bg-[color-mix(in_oklab,var(--color-background)_88%,white_12%)]/80 backdrop-blur-[16px] shadow-[0_12px_32px_rgba(0,0,0,0.45),inset_1px_0_0_rgba(255,255,255,0.08),inset_0_1px_0_rgba(255,255,255,0.06)]",
      solid: "floating-surface-solid border bg-popover",
    },
  },
  defaultVariants: {
    variant: "glass",
  },
});

export type FloatingSurfaceVariants = VariantProps<typeof floatingSurfaceVariants>;
export type FloatingSurfaceVariant = NonNullable<FloatingSurfaceVariants["variant"]>;
