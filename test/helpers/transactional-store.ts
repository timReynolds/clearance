import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { onTestFinished } from "vitest";

import { DrizzleClearanceStore } from "../../src/db/store.js";
import * as schema from "../../src/db/schema.js";

export async function createTransactionalStore() {
  const database = new PGlite();
  onTestFinished(() => database.close());
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/20260518185844_create_clearance_schema.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // PGlite runs PostgreSQL but does not bundle pgcrypto. Its native UUID function is equivalent.
  await database.exec(
    migration
      .replace(/^create extension[^;]+;/, "")
      .replaceAll("extensions.gen_random_uuid()", "gen_random_uuid()"),
  );
  return { database, store: new DrizzleClearanceStore(drizzle(database, { schema })) };
}
