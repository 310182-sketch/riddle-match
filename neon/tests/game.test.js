import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ids = [1, 2, 3, 4].map((id) => `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`);
const tokens = ["a", "b", "c", "d"].map((letter) => letter.repeat(64));

test("Neon private schema enforces room operations and isolation", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  // Existing schemas and their contents must survive untouched.
  await db.exec(`create schema auth; create table public.sentinel (value text); insert into public.sentinel values ('untouched');
    create table auth.sentinel (value text); insert into auth.sentinel values ('untouched');
    create role untrusted_client;`);
  await db.exec(await readFile(new URL("../migrations/20261126000000_riddle_match.sql", import.meta.url), "utf8"));
  for (let i = 0; i < ids.length; i++) {
    await db.query("insert into riddle_match.players (id) values ($1)", [ids[i]]);
    await db.query("insert into riddle_match.player_sessions (player_id, token_hash, expires_at) values ($1, $2, clock_timestamp() + interval '1 day')", [ids[i], tokens[i]]);
  }
  async function admin(sql, params = []) { return db.query(sql, params); }
  async function asSession(tokenHash, sql, params = []) {
    return db.transaction(async (tx) => {
      const { rows } = await tx.query("select player_id from riddle_match.player_sessions where token_hash = $1 and expires_at > clock_timestamp()", [tokenHash]);
      if (!rows.length) throw new Error("session_invalid");
      await tx.query("select set_config('riddle_match.player_id', $1, true)", [rows[0].player_id]);
      return tx.query(sql, params);
    });
  }
  async function value(index, sql, params = []) {
    const { rows } = await asSession(tokens[index], sql, params);
    return rows[0].value;
  }
  async function getRoom(index, roomId) { return value(index, "select riddle_match.get_room($1) as value", [roomId]); }
  const idx = (id) => ids.indexOf(id);
  let roomId, setter, guesser;

  await t.test("migration is isolated and no untrusted SQL role can spoof a player", async () => {
    assert.equal((await admin("select * from public.sentinel")).rows[0].value, "untouched");
    assert.equal((await admin("select * from auth.sentinel")).rows[0].value, "untouched");
    assert.equal((await admin("select count(*)::int as n from information_schema.tables where table_schema = 'auth'")).rows[0].n, 1);
    await db.exec("set role untrusted_client");
    await db.query("select set_config('riddle_match.player_id', $1, false)", [ids[0]]);
    await assert.rejects(db.query("select riddle_match.join_matchmaking('冒名')"), /permission denied for schema riddle_match/);
    await db.exec("reset role");
    await db.query("select set_config('riddle_match.player_id', '', false)");
    await assert.rejects(db.query("select riddle_match.join_matchmaking('未登入')"), /authentication_required/);
    await assert.rejects(asSession("0".repeat(64), "select 1"), /session_invalid/);
  });

  await t.test("matching checks membership and never exposes the secret to a guesser", async () => {
    assert.equal((await value(0, "select riddle_match.join_matchmaking($1) as value", ["甲"])).state, "waiting");
    const matched = await value(1, "select riddle_match.join_matchmaking($1) as value", ["乙"]);
    roomId = matched.room_id;
    const r = await getRoom(0, roomId);
    setter = idx(r.setter_id); guesser = idx(r.guesser_id);
    assert.ok(setter >= 0 && guesser >= 0);
    await assert.rejects(getRoom(2, roomId), /room_access_denied/);
    await assert.rejects(value(2, "select riddle_match.get_room_messages($1,$2) as value", [roomId, 1]), /room_access_denied/);
    await assert.rejects(value(2, "select riddle_match.send_room_message($1,$2,$3) as value", [roomId, 1, "冒名"]), /room_access_denied/);
    const submit = "select riddle_match.submit_riddle($1,$2,$3,$4,$5::text[],$6) as value";
    await assert.rejects(value(setter, submit, [roomId, "題目", "！。", "提示", [], 1]), /riddle_fields_invalid/);
    await assert.rejects(value(guesser, submit, [roomId, "題目", "雨傘", "提示", [], 1]), /setter_action_not_allowed/);
    await value(setter, submit, [roomId, "題目", "雨 傘", "提示", ["洋傘"], 1]);
    const visible = await getRoom(guesser, roomId);
    assert.equal(visible.riddle, "題目");
    for (const key of ["answer", "hint", "accepted_answers"]) assert.equal(Object.hasOwn(visible, key), false);
    const beforeDeadline = await value(guesser, "select riddle_match.end_expired_round($1,$2) as value", [roomId, 1]);
    assert.equal(beforeDeadline.state, "active");
    assert.equal(Object.hasOwn(beforeDeadline, "answer"), false);
    await assert.rejects(admin(`insert into riddle_match.match_rooms
      (player_one_id, player_two_id, player_one_nickname, player_two_nickname, setter_id, guesser_id, topic_number, topic)
      values ($1,$2,'丙','甲',$1,$2,1,'主題')`, [ids[2], ids[0]]), /player_already_in_open_room/);
  });

  await t.test("messages are scoped, bounded, server authored and rate limited", async () => {
    const send = "select riddle_match.send_room_message($1,$2,$3) as value";
    const message = await value(guesser, send, [roomId, 1, "你好"]);
    assert.equal(message.sender_id, ids[guesser]);
    assert.equal(message.body, "你好");
    await assert.rejects(value(guesser, send, [roomId, 1, "第二則太快"]), /message_rate_limited/);
    const messages = await value(setter, "select riddle_match.get_room_messages($1,$2) as value", [roomId, 1]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, message.id);
    await assert.rejects(value(guesser, send, [roomId, 2, "舊回合"]), /message_action_not_allowed/);
    assert.equal(await value(guesser, "select riddle_match.request_room_hint($1,$2) as value", [roomId, 1]), "提示");
    assert.equal(await value(guesser, "select riddle_match.request_room_hint($1,$2) as value", [roomId, 1]), "提示");
    // Set up a full room quickly as the trusted owner, then test the normal RPC.
    await db.exec("alter table riddle_match.room_messages disable trigger guard_room_message");
    await admin("insert into riddle_match.room_messages(room_id,round_number,sender_id,body) select $1,1,$2,'訊息' from generate_series(1,499)", [roomId, ids[guesser]]);
    await db.exec("alter table riddle_match.room_messages enable trigger guard_room_message");
    await assert.rejects(value(setter, send, [roomId, 1, "第 501 則"]), /message_limit_reached/);
    assert.equal((await value(setter, "select riddle_match.get_room_messages($1,$2) as value", [roomId, 1])).length, 500);
  });

  await t.test("solved rooms remain exclusive; stale operations and repeated departure are safe", async () => {
    const guess = "select riddle_match.submit_guess($1,$2,$3) as value";
    assert.equal((await value(guesser, guess, [roomId, "錯誤", 1])).correct, false);
    assert.equal((await value(guesser, guess, [roomId, "洋傘", 1])).correct, true);
    const repeated = await value(guesser, guess, [roomId, "錯誤", 1]);
    assert.equal(repeated.state, "solved");
    assert.equal(repeated.correct, null);
    assert.equal((await value(guesser, "select riddle_match.join_matchmaking($1) as value", ["甲"])).room_id, roomId);
    assert.equal((await value(setter, "select riddle_match.start_next_round($1,$2) as value", [roomId, 1])).round_number, 2);
    await assert.rejects(value(setter, "select riddle_match.start_next_round($1,$2) as value", [roomId, 1]), /round_changed/);
    const r = await getRoom(setter, roomId);
    await assert.rejects(value(idx(r.setter_id), "select riddle_match.submit_riddle($1,$2,$3,$4,$5::text[],$6) as value", [roomId, "舊", "舊", "舊", [], 1]), /round_changed/);
    await assert.rejects(value(idx(r.guesser_id), "select riddle_match.submit_guess($1,$2,$3) as value", [roomId, "舊", 1]), /round_changed/);
    await assert.rejects(value(idx(r.guesser_id), "select riddle_match.request_room_hint($1,$2) as value", [roomId, 1]), /round_changed/);
    // The former guesser is now the setter, but their delayed requests must
    // still be identified as stale after membership is verified.
    await assert.rejects(value(guesser, "select riddle_match.submit_guess($1,$2,$3) as value", [roomId, "舊", 1]), /round_changed/);
    await assert.rejects(value(guesser, "select riddle_match.request_room_hint($1,$2) as value", [roomId, 1]), /round_changed/);
    await assert.rejects(value(setter, "select riddle_match.submit_riddle($1,$2,$3,$4,$5::text[],$6) as value", [roomId, "舊", "舊", "舊", [], 1]), /round_changed/);
    await assert.rejects(value(setter, "select riddle_match.end_expired_round($1,$2) as value", [roomId, 1]), /round_changed/);
    await value(setter, "select riddle_match.leave_room($1) as value", [roomId]);
    assert.equal((await getRoom(guesser, roomId)).status, "abandoned");
    assert.equal((await value(setter, "select riddle_match.join_matchmaking($1) as value", ["甲"])).state, "waiting");
    await value(setter, "select riddle_match.leave_room($1) as value", [roomId]);
    assert.equal((await value(2, "select riddle_match.join_matchmaking($1) as value", ["丙"])).state, "matched");
  });

  await t.test("wall-clock expiration wins over a delayed correct guess", async () => {
    const matched = await value(2, "select riddle_match.join_matchmaking($1) as value", ["丙"]);
    const r = await getRoom(2, matched.room_id);
    const s = idx(r.setter_id), g = idx(r.guesser_id);
    await value(s, "select riddle_match.submit_riddle($1,$2,$3,$4,$5::text[],$6) as value", [r.id, "題", "答案", "提示", [], 1]);
    const result = await db.transaction(async (tx) => {
      await tx.query("update riddle_match.match_rooms set expires_at = now() + interval '50 milliseconds' where id = $1", [r.id]);
      await tx.query("select set_config('riddle_match.player_id', $1, true)", [ids[g]]);
      await tx.exec("select pg_sleep(0.15)");
      return tx.query("select riddle_match.submit_guess($1,$2,$3) as value", [r.id, "答案", 1]);
    });
    assert.equal(result.rows[0].value.state, "timed_out");
    assert.equal(result.rows[0].value.answer, "答案");
    assert.equal((await value(s, "select riddle_match.end_expired_round($1,$2) as value", [r.id, 1])).answer, "答案");
    await assert.rejects(value(g, "select riddle_match.send_room_message($1,$2,$3) as value", [r.id, 1, "時間到"]), /message_action_not_allowed/);
    await value(s, "select riddle_match.leave_room($1) as value", [r.id]);
  });

  await t.test("stale waiting players and disconnected room peers are handled lazily", async () => {
    assert.equal((await value(0, "select riddle_match.join_matchmaking($1) as value", ["甲"])).state, "waiting");
    await admin("update riddle_match.matchmaking_queue set last_seen_at = clock_timestamp() - interval '31 seconds' where user_id = $1", [ids[0]]);
    assert.equal((await value(1, "select riddle_match.join_matchmaking($1) as value", ["乙"])).state, "waiting");
    const matched = await value(3, "select riddle_match.join_matchmaking($1) as value", ["丁"]);
    assert.equal(matched.state, "matched");
    await admin("update riddle_match.room_presence set last_seen_at = clock_timestamp() - interval '31 seconds' where room_id = $1 and player_id = $2", [matched.room_id, ids[3]]);
    assert.equal((await getRoom(1, matched.room_id)).status, "abandoned");
    assert.equal((await getRoom(3, matched.room_id)).status, "abandoned");
  });

  await t.test("expired session is rejected and transaction-local identity does not leak", async () => {
    await admin("update riddle_match.player_sessions set expires_at = clock_timestamp() - interval '1 second' where token_hash = $1", [tokens[3]]);
    await assert.rejects(asSession(tokens[3], "select riddle_match.join_matchmaking('丁')"), /session_invalid/);
    assert.equal((await admin("select nullif(current_setting('riddle_match.player_id', true), '') as actor")).rows[0].actor, null);
  });

  await t.test("actions check peer presence even without a preceding room poll", async () => {
    assert.equal((await value(0, "select riddle_match.join_matchmaking($1) as value", ["甲"])).state, "waiting");
    const matched = await value(1, "select riddle_match.join_matchmaking($1) as value", ["乙"]);
    const r = await getRoom(0, matched.room_id);
    const s = idx(r.setter_id), g = idx(r.guesser_id);
    await value(s, "select riddle_match.submit_riddle($1,$2,$3,$4,$5::text[],$6) as value", [r.id, "題", "答案", "提示", [], 1]);
    await admin("update riddle_match.room_presence set last_seen_at = clock_timestamp() - interval '31 seconds' where room_id = $1 and player_id = $2", [r.id, ids[s]]);
    const result = await value(g, "select riddle_match.submit_guess($1,$2,$3) as value", [r.id, "答案", 1]);
    assert.equal(result.state, "abandoned");
    assert.equal((await getRoom(g, r.id)).status, "abandoned");
  });

  await t.test("opportunistic cleanup respects active rooms and removes expired private data", async () => {
    assert.equal((await value(0, "select riddle_match.join_matchmaking($1) as value", ["甲"])).state, "waiting");
    const active = await value(1, "select riddle_match.join_matchmaking($1) as value", ["乙"]);
    await admin("update riddle_match.match_rooms set ended_at = clock_timestamp() - interval '8 days' where id = $1", [roomId]);
    await admin("insert into riddle_match.api_rate_limits(bucket,window_started_at,hits) values ('old',clock_timestamp() - interval '2 days',1)");
    let cleanup = (await admin("select riddle_match.cleanup_expired_data() as value")).rows[0].value;
    assert.equal(cleanup.rooms_deleted, 1);
    assert.ok(cleanup.sessions_deleted >= 1);
    assert.equal(cleanup.rate_buckets_deleted, 1);
    assert.equal((await admin("select count(*)::int as n from riddle_match.room_secrets where room_id = $1", [roomId])).rows[0].n, 0);
    assert.equal((await admin("select count(*)::int as n from riddle_match.room_messages where room_id = $1", [roomId])).rows[0].n, 0);
    assert.notEqual((await getRoom(0, active.room_id)).status, "abandoned");
    await admin("update riddle_match.room_presence set last_seen_at = clock_timestamp() - interval '31 seconds' where room_id = $1", [active.room_id]);
    cleanup = (await admin("select riddle_match.cleanup_expired_data() as value")).rows[0].value;
    assert.equal(cleanup.abandoned, 1);
    assert.equal((await getRoom(0, active.room_id)).status, "abandoned");
  });
});

test("migration refuses to overwrite an existing namespace", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create schema riddle_match; create table riddle_match.sentinel(value text); insert into riddle_match.sentinel values ('original')");
  const migration = await readFile(new URL("../migrations/20261126000000_riddle_match.sql", import.meta.url), "utf8");
  await assert.rejects(db.exec(migration), /schema \"riddle_match\" already exists/);
  assert.equal((await db.query("select value from riddle_match.sentinel")).rows[0].value, "original");
  assert.equal((await db.query("select count(*)::int as n from information_schema.tables where table_schema = 'riddle_match'")).rows[0].n, 1);
});
