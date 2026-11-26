import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { databaseUrl } from "./api.mjs";
import { pooledDatabaseUrl, verifiedDatabaseUrl } from "./database-url.mjs";

// These are synthetic URLs; no real credentials are read, persisted, or logged.
const direct = "postgresql://sample%40owner:p%40ss%3Aword@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const pooled = "postgresql://sample%40owner:p%40ss%3Aword@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

test("API and retention select their respective Neon URLs with verify-full", () => {
  const env = { DATABASE_URL_UNPOOLED: direct, DATABASE_URL: pooled };
  for (const [input, output] of [[direct, databaseUrl(env)], [pooled, pooledDatabaseUrl(env)]]) {
    const before = new URL(input), after = new URL(output);
    assert.equal(after.protocol, before.protocol);
    assert.equal(after.hostname, before.hostname);
    assert.equal(after.port, before.port);
    assert.equal(after.pathname, before.pathname);
    assert.equal(after.username, before.username);
    assert.equal(after.password, before.password);
    assert.equal(after.searchParams.get("channel_binding"), "require");
    assert.deepEqual(after.searchParams.getAll("sslmode"), ["verify-full"]);

    // Verify the installed pg driver actually enables certificate and hostname
    // checking; constructing a client does not connect to the database.
    const options = new pg.Client({ connectionString: output }).connectionParameters;
    assert.ok(options.ssl);
    assert.notEqual(options.ssl.rejectUnauthorized, false);
    assert.equal(options.ssl.checkServerIdentity, undefined);
  }
});

test("the mode remains verify-full with missing, duplicate or compatibility options", () => {
  const base = "postgres://sample:fake@ep-example.us-east-2.aws.neon.tech/neondb";
  for (const query of ["", "?sslmode=disable&sslmode=require", "?uselibpqcompat=true&sslmode=require"]) {
    const result = verifiedDatabaseUrl(base + query);
    const url = new URL(result);
    assert.deepEqual(url.searchParams.getAll("sslmode"), ["verify-full"]);
    if (query.includes("uselibpqcompat")) assert.equal(url.searchParams.get("uselibpqcompat"), "true");
    const ssl = new pg.Client({ connectionString: result }).connectionParameters.ssl;
    assert.ok(ssl);
    assert.notEqual(ssl.rejectUnauthorized, false);
    assert.equal(ssl.checkServerIdentity, undefined);
  }
});

test("missing or malformed configuration fails without disclosing its content", () => {
  assert.throws(() => databaseUrl({ DATABASE_URL: pooled }), /DATABASE_URL_UNPOOLED is required/);
  assert.equal(pooledDatabaseUrl({}), undefined);
  const input = "not-a-url-with-fake-secret";
  assert.throws(() => verifiedDatabaseUrl(input), (error) => {
    assert.equal(error.message, "Invalid database URL");
    assert.doesNotMatch(error.message, /fake-secret/);
    return true;
  });
  assert.throws(() => verifiedDatabaseUrl("https://user:fake@example.test/db"), /Invalid database URL/);
});
