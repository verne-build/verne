import type { ReactNode } from "react";

export function ComposerRepositoryRowLayout(props: {
  branch: ReactNode;
  checkout: ReactNode;
  context: ReactNode;
}) {
  return (
    <>
      <div
        data-composer-repository-controls="left"
        className="flex min-w-0 items-center justify-start gap-1"
      >
        {props.branch}
        {props.checkout}
      </div>
      {props.context ? (
        <div
          data-composer-repository-context="right"
          className="ml-auto flex shrink-0 items-center"
        >
          {props.context}
        </div>
      ) : null}
    </>
  );
}
