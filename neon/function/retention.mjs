import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { createRetentionHandler } from "./retention-handler.mjs";

// Neon injects DATABASE_URL for the current branch. Each cleanup batch is a
// single SQL statement, so the pooled URL is appropriate here.
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 20000,
  statement_timeout: 15000,
  query_timeout: 17000,
}) : undefined;
if (pool) attachDatabasePool(pool);

export default { fetch: createRetentionHandler({ pool }) };
