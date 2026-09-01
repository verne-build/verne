import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { VerneBuildIdentity } from "@t3tools/shared/releaseIdentity";

import { cli } from "../bin.ts";

const runCli = Command.runWith(cli, { version: "0.0.0" });
const TestLayer = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

it.effect("reports Verne core and exact upstream identity as JSON", () =>
  Effect.gen(function* () {
    yield* runCli(["version", "--json"]);

    const logs = (yield* TestConsole.logLines).filter(
      (line): line is string => typeof line === "string",
    );
    assert.lengthOf(logs, 1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(VerneBuildIdentity))(
      logs[0]!,
    );
    assert.deepEqual(report, {
      product: "Verne",
      version: "0.2.0",
      revision: "unknown",
      upstream: {
        schemaVersion: 1,
        product: "T3 Code",
        repository: "pingdotgg/t3code",
        version: "0.0.37",
        revision: "b883fc066ea5c9bebbe1c3e9b4bc2471aab3685f",
      },
    });
  }).pipe(Effect.provide(TestLayer)),
);
