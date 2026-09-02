import {
  DesktopPortForwardEnsureInputSchema,
  DesktopPortForwardEnsureResultSchema,
  DesktopPortForwardReleaseInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPortForwarding from "../../preview/PortForwarding.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const ensurePortForward = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_PORT_FORWARD_CHANNEL,
  payload: DesktopPortForwardEnsureInputSchema,
  result: DesktopPortForwardEnsureResultSchema,
  handler: Effect.fn("desktop.ipc.portForward.ensure")(function* (input, event) {
    if (event === undefined) return yield* Effect.die("Missing Electron IPC invoke event.");
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    return yield* forwarding.ensure(input, event.sender);
  }),
});

export const releasePortForward = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RELEASE_PORT_FORWARD_CHANNEL,
  payload: DesktopPortForwardReleaseInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForward.release")(function* (input, event) {
    if (event === undefined) return yield* Effect.die("Missing Electron IPC invoke event.");
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    yield* forwarding.release(input, event.sender);
  }),
});
