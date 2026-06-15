import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export { default as TabBar } from "./TabBar.vue";
export { default as TabBarTrigger } from "./TabBarTrigger.vue";

export const tabBarTriggerVariants = cva(
  "flex shrink-0 items-center px-2.5 text-xs relative",
  {
    variants: {
      variant: {
        default: "border-b-2 border-r border-r-tab-border! h-11.5 mb-px",
        sidebar: "border-b-2 border-r border-r-tab-border! h-11.5 mb-px",
        grouped: "h-6 border-r border-border last:border-r-0",
        pill: "h-7 px-2 rounded-sm",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export const tabBarTriggerActiveVariants: Record<string, string> = {
  default: "border-primary text-foreground",
  sidebar: "border-primary text-foreground",
  grouped: "bg-border/40 text-foreground",
  pill: "bg-tab-active-bg text-secondary-foreground",
};

export const tabBarTriggerInactiveVariants: Record<string, string> = {
  default: "border-transparent text-muted-foreground hover:text-foreground",
  sidebar: "border-transparent text-muted-foreground hover:text-foreground",
  grouped: "text-foreground/50 hover:text-foreground",
  pill: "text-muted-foreground hover:bg-tab-active-bg hover:text-secondary-foreground",
};

export type TabBarTriggerVariants = VariantProps<typeof tabBarTriggerVariants>;
