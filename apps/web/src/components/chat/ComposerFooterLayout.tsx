import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export function ComposerFooterLayout(props: {
  permissions: ReactNode;
  modelControls: ReactNode;
  primaryAction: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      data-chat-composer-footer="true"
      data-chat-composer-footer-compact={props.compact ? "true" : "false"}
      className={cn(
        "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
        props.compact ? "gap-1.5" : "gap-2 sm:gap-0",
        props.className,
      )}
    >
      <div
        data-chat-composer-actions="left"
        className="-m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {props.permissions}
      </div>
      <div
        data-chat-composer-actions="right"
        className="flex min-w-0 shrink-0 flex-nowrap items-center justify-end gap-3"
      >
        {props.modelControls}
        {props.primaryAction}
      </div>
    </div>
  );
}
