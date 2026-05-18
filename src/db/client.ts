import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

export type ClearanceDatabase = PostgresJsDatabase<typeof schema>;

export type DatabaseClient = {
  close(): Promise<void>;
  db: ClearanceDatabase;
};

export type DatabaseClientOptions = {
  maxConnections?: number;
  prepareStatements?: boolean;
  url: string;
};

export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const sqlClient = postgres(options.url, {
    max: options.maxConnections ?? 5,
    prepare: options.prepareStatements ?? false,
  });

  return {
    close: () => closeSqlClient(sqlClient),
    db: drizzle(sqlClient, { schema }),
  };
}

async function closeSqlClient(sqlClient: Sql): Promise<void> {
  await sqlClient.end({ timeout: 5 });
}
