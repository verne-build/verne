// @effect-diagnostics nodeBuiltinImport:off - migration fixtures exercise real SQLite files.
import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { importLegacyT3State } from "./stateMigration.ts";

const withHomes = async <A>(
  run: (homes: { readonly legacyHome: string; readonly verneHome: string }) => Promise<A>,
) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "verne-state-import-"));
  try {
    return await run({
      legacyHome: NodePath.join(root, ".t3"),
      verneHome: NodePath.join(root, ".verne"),
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const seedLegacyDatabase = (databasePath: string) => {
  NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE imported_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  database.exec("INSERT INTO imported_threads VALUES ('thread-1', 'Imported thread')");
  return database;
};

describe("importLegacyT3State", () => {
  it("imports compatible state into an absent Verne home", async () => {
    await withHomes(async ({ legacyHome, verneHome }) => {
      const legacyState = NodePath.join(legacyHome, "userdata");
      const sourceDatabase = seedLegacyDatabase(NodePath.join(legacyState, "state.sqlite"));
      NodeFS.writeFileSync(NodePath.join(legacyState, "settings.json"), '{"theme":"dark"}');
      NodeFS.writeFileSync(NodePath.join(legacyState, "keybindings.json"), '{"save":"cmd+s"}');
      NodeFS.mkdirSync(NodePath.join(legacyState, "secrets"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(legacyState, "secrets", "provider.bin"), "secret");
      NodeFS.mkdirSync(NodePath.join(legacyState, "attachments"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(legacyState, "attachments", "context.txt"), "context");
      NodeFS.mkdirSync(NodePath.join(legacyState, "logs"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(legacyState, "logs", "server.log"), "legacy log");
      NodeFS.writeFileSync(NodePath.join(legacyState, "anonymous-id"), "legacy-installation");
      NodeFS.writeFileSync(NodePath.join(legacyState, "environment-id"), "legacy-environment");
      NodeFS.writeFileSync(NodePath.join(legacyState, "server-runtime.json"), "{}");

      const result = await importLegacyT3State({ legacyHome, verneHome });
      sourceDatabase.close();

      assert.equal(result, "imported");
      const importedDatabase = new DatabaseSync(
        NodePath.join(verneHome, "userdata", "state.sqlite"),
        { readOnly: true },
      );
      assert.deepEqual(importedDatabase.prepare("SELECT id, title FROM imported_threads").all(), [
        { id: "thread-1", title: "Imported thread" },
      ]);
      importedDatabase.close();
      assert.equal(
        NodeFS.readFileSync(NodePath.join(verneHome, "userdata", "settings.json"), "utf8"),
        '{"theme":"dark"}',
      );
      assert.equal(
        NodeFS.readFileSync(
          NodePath.join(verneHome, "userdata", "secrets", "provider.bin"),
          "utf8",
        ),
        "secret",
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(verneHome, "userdata", "logs")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(verneHome, "userdata", "anonymous-id")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(verneHome, "userdata", "environment-id")));
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(verneHome, "userdata", "server-runtime.json")),
      );
      assert.deepInclude(
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(verneHome, "migration", "t3-import.json"), "utf8"),
        ),
        { source: legacyHome, destination: verneHome },
      );
    });
  });

  it("does not merge into an initialized Verne home", async () => {
    await withHomes(async ({ legacyHome, verneHome }) => {
      const sourceDatabase = seedLegacyDatabase(
        NodePath.join(legacyHome, "userdata", "state.sqlite"),
      );
      NodeFS.mkdirSync(NodePath.join(verneHome, "userdata"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(verneHome, "userdata", "settings.json"), "verne");

      const result = await importLegacyT3State({ legacyHome, verneHome });
      sourceDatabase.close();

      assert.equal(result, "destination-initialized");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(verneHome, "userdata", "settings.json"), "utf8"),
        "verne",
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(verneHome, "migration")));
    });
  });

  it("is a no-op when the legacy state has no supported data", async () => {
    await withHomes(async ({ legacyHome, verneHome }) => {
      NodeFS.mkdirSync(NodePath.join(legacyHome, "userdata", "logs"), { recursive: true });

      assert.equal(await importLegacyT3State({ legacyHome, verneHome }), "source-empty");
      assert.isFalse(NodeFS.existsSync(verneHome));
    });
  });

  it("leaves both homes intact when SQLite validation fails", async () => {
    await withHomes(async ({ legacyHome, verneHome }) => {
      const legacyDatabase = NodePath.join(legacyHome, "userdata", "state.sqlite");
      NodeFS.mkdirSync(NodePath.dirname(legacyDatabase), { recursive: true });
      NodeFS.writeFileSync(legacyDatabase, "not sqlite");

      await expect(importLegacyT3State({ legacyHome, verneHome })).rejects.toBeDefined();

      assert.equal(NodeFS.readFileSync(legacyDatabase, "utf8"), "not sqlite");
      assert.isFalse(NodeFS.existsSync(verneHome));
    });
  });
});
