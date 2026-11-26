import { Pool } from "pg";
import { attachDatabasePool, waitUntil } from "@neon/functions";
import { createHandler, databaseUrl } from "./api.mjs";

// Neon injects the branch URL; multi-step transactions require a direct connection.
const pool = new Pool({
  connectionString: databaseUrl(process.env),
  max: 2,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 20000,
  statement_timeout: 8000,
  query_timeout: 10000,
});
attachDatabasePool(pool);

export default { fetch: createHandler({ pool, origins: process.env.ALLOWED_ORIGINS, background: waitUntil }) };
