import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createRetentionHandler } from "./retention-handler.mjs";

const emptyCounts = { abandoned: 0, rooms_deleted: 0, sessions_deleted: 0, rate_buckets_deleted: 0 };
const envelope = {
  version: 1, invocation_id: "test-123", trigger: { type: "schedule", id: "trigger-test", name: "riddle-match-retention" },
  data: { scheduled_at: "2026-11-26T18:00:00Z" }, previous_attempts: [], previous_attempts_omitted: 0,
};
function triggerRequest(body = envelope, headers = { "x-neon-trigger-invocation-id": "test-123" }) {
  return new Request("https://test.invalid/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function logs() {
  const events = [];
  return { events, logger: { log: (...args) => events.push(args), error: (...args) => events.push(args) } };
}

test("only a matching Neon schedule invocation reaches the database", async () => {
  let queries = 0;
  const handler = createRetentionHandler({ pool: { query: async () => { queries++; return { rows: [{ data: emptyCounts }] }; } }, logger: logs().logger });
  assert.equal((await handler(triggerRequest(envelope, {}))).status, 401);
  assert.equal((await handler(triggerRequest({ ...envelope, invocation_id: "other" }))).status, 400);
  assert.equal((await handler(triggerRequest({ ...envelope, trigger: { ...envelope.trigger, type: "storage_object_created" } }))).status, 400);
  assert.equal((await handler(triggerRequest({ ...envelope, trigger: { ...envelope.trigger, name: "wrong-trigger" } }))).status, 400);
  assert.equal((await handler(triggerRequest({ ...envelope, data: { scheduled_at: "bad" } }))).status, 400);
  assert.equal((await handler(triggerRequest({ ...envelope, padding: "x".repeat(66000) }))).status, 400);
  assert.equal((await handler(new Request("https://test.invalid/", { method: "GET" }))).status, 405);
  assert.equal((await handler(new Request("https://test.invalid/other", { method: "POST" }))).status, 404);
  assert.equal(queries, 0);
});

test("bounded cleanup logs success and repeats are safe", async () => {
  const history = logs();
  const statements = [];
  const handler = createRetentionHandler({ pool: { query: async (sql) => { statements.push(sql); return { rows: [{ data: { ...emptyCounts, rooms_deleted: 2 } }] }; } }, logger: history.logger });
  const first = await handler(triggerRequest());
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, batches: 10 });
  assert.equal((await handler(triggerRequest())).status, 200);
  assert.equal(statements.length, 20);
  assert.ok(statements.every((sql) => sql === "select riddle_match.cleanup_expired_data() as data"));
  assert.equal(history.events[0][0], "retention_cleanup_completed");
  assert.equal(history.events[0][1].rooms_deleted, 20);
  assert.equal(history.events[0][1].invocation_id, "test-123");
});

test("database failure emits safe correlation details and asks Neon to retry", async () => {
  const history = logs();
  let queries = 0;
  const pool = { query: async () => {
    queries++;
    if (queries === 4) { const e = new Error("password=super-secret sql details"); e.code = "08006"; throw e; }
    return { rows: [{ data: emptyCounts }] };
  } };
  const handler = createRetentionHandler({ pool, logger: history.logger });
  const result = await handler(triggerRequest());
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("retry-after"), "60");
  assert.deepEqual(await result.json(), { error: "cleanup_failed" });
  assert.equal(queries, 4);
  assert.equal(history.events[0][0], "retention_cleanup_failed");
  assert.equal(history.events[0][1].completed_batches, 3);
  assert.equal(history.events[0][1].code, "08006");
  assert.doesNotMatch(JSON.stringify(history.events), /super-secret|sql details/);
  assert.equal((await handler(triggerRequest())).status, 200);
});

test("missing database and malformed cleanup result fail closed", async () => {
  const noPool = createRetentionHandler({ pool: undefined, logger: logs().logger });
  assert.equal((await noPool(triggerRequest())).status, 503);
  const malformed = createRetentionHandler({ pool: { query: async () => ({ rows: [{ data: {} }] }) }, logger: logs().logger });
  assert.equal((await malformed(triggerRequest())).status, 503);
});

test("scheduled cleanup uses actual private schema and preserves current data", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create table public.sentinel(value text); insert into public.sentinel values ('untouched')");
  for (const file of ["20261126000000_riddle_match.sql", "20261126010000_player_blocks.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const old1 = "10000000-0000-0000-0000-000000000001", old2 = "10000000-0000-0000-0000-000000000002";
  const active = "10000000-0000-0000-0000-000000000003";
  await db.query("insert into riddle_match.players(id,created_at) values ($1,now()-interval '8 days'),($2,now()-interval '8 days'),($3,now()-interval '8 days')", [old1, old2, active]);
  await db.query("insert into riddle_match.player_sessions(token_hash,player_id,expires_at) values ($1,$2,now()-interval '1 day'),($3,$4,now()+interval '1 day')", ["a".repeat(64), old1, "b".repeat(64), active]);
  const oldRoom = (await db.query(`insert into riddle_match.match_rooms
    (player_one_id,player_two_id,player_one_nickname,player_two_nickname,setter_id,guesser_id,topic_number,topic,status,ended_at)
    values ($1,$2,'甲','乙',$1,$2,1,'主題','abandoned',now()-interval '8 days') returning id`, [old1, old2])).rows[0].id;
  await db.query("insert into riddle_match.room_secrets(room_id,round_number,answer,hint) values ($1,1,'答案','提示')", [oldRoom]);
  await db.query("insert into riddle_match.player_blocks(blocker_id,blocked_id) values ($1,$2)", [old1,old2]);
  await db.query("insert into riddle_match.api_rate_limits(bucket,window_started_at,hits) values ('old',now()-interval '2 days',1),('fresh',now(),1)");
  const handler = createRetentionHandler({ pool: { query: (sql) => db.query(sql) }, logger: logs().logger });
  assert.equal((await handler(triggerRequest())).status, 200);
  assert.equal((await handler(triggerRequest())).status, 200);
  assert.equal((await db.query("select count(*)::int as n from riddle_match.match_rooms where id=$1", [oldRoom])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from riddle_match.room_secrets where room_id=$1", [oldRoom])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from riddle_match.player_blocks where blocker_id=$1", [old1])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from riddle_match.players where id=$1", [active])).rows[0].n, 1);
  assert.equal((await db.query("select count(*)::int as n from riddle_match.player_sessions where player_id=$1", [active])).rows[0].n, 1);
  assert.equal((await db.query("select count(*)::int as n from riddle_match.api_rate_limits where bucket='fresh'")).rows[0].n, 1);
  assert.equal((await db.query("select value from public.sentinel")).rows[0].value, "untouched");
});
