// @effect-diagnostics nodeBuiltinImport:off - this boundary performs an atomic filesystem import.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const BUN_SQLITE_MODULE: string = "bun:sqlite";

const LEGACY_STATE_ENTRIES = [
  "settings.json",
  "keybindings.json",
  "desktop-settings.json",
  "client-settings.json",
  "saved-environments.json",
  "connection-catalog.json",
  "secrets",
  "attachments",
] as const;

export type LegacyT3ImportResult = "imported" | "destination-initialized" | "source-empty";

export interface LegacyT3ImportOptions {
  readonly legacyHome: string;
  readonly verneHome: string;
}

const pathExists = async (path: string) => {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
};

const directoryIsInitialized = async (path: string) => {
  try {
    return (await NodeFSP.readdir(path)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const sqliteString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const backupSqlite = async (source: string, destination: string) => {
  if (process.versions.bun !== undefined) {
    const { Database } = await import(BUN_SQLITE_MODULE);
    const database = new Database(source, { readonly: true });
    try {
      database.exec(`VACUUM INTO ${sqliteString(destination)}`);
    } finally {
      database.close();
    }
    return;
  }

  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, destination);
  } finally {
    database.close();
  }
};

const validateSqlite = async (databasePath: string) => {
  if (process.versions.bun !== undefined) {
    const { Database } = await import(BUN_SQLITE_MODULE);
    const database = new Database(databasePath, { readonly: true });
    try {
      const result = database.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
      if (!result || !Object.values(result).includes("ok")) {
        throw new Error("Imported T3 Code database failed SQLite validation.");
      }
    } finally {
      database.close();
    }
    return;
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
    if (!Object.values(result).includes("ok")) {
      throw new Error("Imported T3 Code database failed SQLite validation.");
    }
  } finally {
    database.close();
  }
};

/**
 * Copies compatible T3 Code server state into an uninitialized Verne home.
 * The source remains untouched, installation is atomic, and runtime/telemetry
 * identity files are deliberately not inherited.
 */
export async function importLegacyT3State({
  legacyHome,
  verneHome,
}: LegacyT3ImportOptions): Promise<LegacyT3ImportResult> {
  if (await directoryIsInitialized(verneHome)) return "destination-initialized";

  const legacyState = NodePath.join(legacyHome, "userdata");
  const legacyDatabase = NodePath.join(legacyState, "state.sqlite");
  const copyableEntries = await Promise.all(
    LEGACY_STATE_ENTRIES.map(async (entry) => ({
      entry,
      exists: await pathExists(NodePath.join(legacyState, entry)),
    })),
  );
  const hasDatabase = await pathExists(legacyDatabase);
  if (!hasDatabase && copyableEntries.every(({ exists }) => !exists)) return "source-empty";

  const parent = NodePath.dirname(verneHome);
  await NodeFSP.mkdir(parent, { recursive: true });
  const stagingHome = await NodeFSP.mkdtemp(
    NodePath.join(parent, `.${NodePath.basename(verneHome)}.importing-`),
  );

  try {
    const stagingState = NodePath.join(stagingHome, "userdata");
    await NodeFSP.mkdir(stagingState, { recursive: true });

    for (const { entry, exists } of copyableEntries) {
      if (!exists) continue;
      await NodeFSP.cp(NodePath.join(legacyState, entry), NodePath.join(stagingState, entry), {
        recursive: true,
        errorOnExist: true,
      });
    }

    if (hasDatabase) {
      const importedDatabase = NodePath.join(stagingState, "state.sqlite");
      await backupSqlite(legacyDatabase, importedDatabase);
      await validateSqlite(importedDatabase);
    }

    const receiptDirectory = NodePath.join(stagingHome, "migration");
    await NodeFSP.mkdir(receiptDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(receiptDirectory, "t3-import.json"),
      `${JSON.stringify({
        version: 1,
        source: legacyHome,
        destination: verneHome,
      })}\n`,
      { flag: "wx" },
    );

    if (await directoryIsInitialized(verneHome)) return "destination-initialized";
    await NodeFSP.rmdir(verneHome).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await NodeFSP.rename(stagingHome, verneHome);
    return "imported";
  } finally {
    await NodeFSP.rm(stagingHome, { recursive: true, force: true });
  }
}
