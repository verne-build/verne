import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openThreadPorts } from "./openThreadPorts";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";

const THREAD_REF = scopeThreadRef("environment-a" as never, ThreadId.make("thread-ports"));

describe("openThreadPorts", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
    });
  });

  it("navigates to the thread and opens the Ports drawer tab", () => {
    const navigateToThread = vi.fn();

    openThreadPorts(THREAD_REF, navigateToThread);

    expect(navigateToThread).toHaveBeenCalledWith(THREAD_REF);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ),
    ).toMatchObject({
      terminalOpen: true,
      bottomDrawerTab: "ports",
    });
  });

  it("does not create a terminal just to show Ports", () => {
    const navigateToThread = vi.fn();

    openThreadPorts(THREAD_REF, navigateToThread);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ),
    ).toMatchObject({
      terminalIds: [],
      activeTerminalId: "",
      activeTerminalGroupId: "",
    });
  });
});
