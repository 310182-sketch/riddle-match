import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const users = [
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
  "00000000-0000-0000-0000-000000000003",
  "00000000-0000-0000-0000-000000000004",
];

test("migrations enforce room membership, secrets, round state and message permissions", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  // Emulate the minimal Supabase objects the migrations use. This does not
  // emulate Auth, PostgREST, Realtime delivery, or a networked Postgres server.
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    create publication supabase_realtime;
  `);
  for (const filename of ["20261126000000_initial_realtime_game.sql", "20261126010000_room_safety.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8"));
  }
  for (const user of users) await db.query("insert into auth.users(id) values ($1)", [user]);

  async function asUser(user, sql, params = []) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    await db.exec("set role authenticated");
    return db.query(sql, params);
  }
  async function value(user, sql, params = []) {
    const { rows } = await asUser(user, sql, params);
    return rows[0].value;
  }
  async function room(user, id) {
    const { rows } = await asUser(user, "select * from public.match_rooms where id = $1", [id]);
    return rows[0];
  }
  async function admin(sql, params = []) {
    await db.exec("reset role");
    return db.query(sql, params);
  }

  let firstId, firstSetter, firstGuesser, secondId, secondSetter, secondGuesser;
  await t.test("queue creates one room and room data is participant-only", async () => {
    assert.equal((await value(users[0], "select public.join_matchmaking($1) as value", ["甲"])).state, "waiting");
    const match = await value(users[1], "select public.join_matchmaking($1) as value", ["乙"]);
    assert.equal(match.state, "matched");
    firstId = match.room_id;
    const r = await room(users[0], firstId);
    firstSetter = r.setter_id;
    firstGuesser = r.guesser_id;
    assert.equal((await room(users[2], firstId)), undefined);
    await assert.rejects(asUser(users[2], "select public.end_expired_round($1, $2)", [firstId, 1]), /room_access_denied/);
    // The original bug allowed a participant to occupy another room in the opposite column.
    await assert.rejects(admin(`insert into public.match_rooms
      (player_one_id, player_two_id, player_one_nickname, player_two_nickname,
       setter_id, guesser_id, topic_number, topic)
      values ($1, $2, '丙', '甲', $1, $2, 1, '主題')`, [users[2], users[0]]), /player_already_in_open_room/);
  });

  await t.test("only setter can submit valid secrets; guesser cannot read them", async () => {
    const submit = "select public.submit_riddle($1, $2, $3, $4, $5::text[], $6) as value";
    await assert.rejects(value(firstSetter, submit, [firstId, "題目", "！。", "提示", [], 1]), /riddle_fields_invalid/);
    await assert.rejects(value(firstSetter, submit, [firstId, "題目", "雨傘", "提示", ["、"], 1]), /riddle_fields_invalid/);
    await assert.rejects(value(firstGuesser, submit, [firstId, "題目", "雨傘", "提示", [], 1]), /setter_action_not_allowed/);
    assert.equal((await value(firstSetter, submit, [firstId, "題目", "雨 傘", "提示", ["洋傘"], 1])).state, "active");
    assert.equal((await asUser(firstGuesser, "select * from public.room_secrets where room_id = $1", [firstId])).rows.length, 0);
    assert.equal((await asUser(firstSetter, "select * from public.room_secrets where room_id = $1", [firstId])).rows.length, 1);
    await assert.rejects(asUser(firstGuesser, "update public.room_secrets set answer = 'x' where room_id = $1", [firstId]), /permission denied/);
  });

  await t.test("message fields are server controlled and hint retry does not consume another hint", async () => {
    const insert = "insert into public.room_messages (room_id, round_number, sender_id, body) values ($1, $2, $3, $4) returning id, created_at";
    const message = await asUser(firstGuesser, insert, [firstId, 1, firstGuesser, "你好"]);
    assert.equal(message.rows.length, 1);
    await assert.rejects(asUser(firstGuesser, insert, [firstId, 1, firstSetter, "冒名"]), /message_action_not_allowed|row-level security/);
    await assert.rejects(asUser(firstGuesser, "insert into public.room_messages (id, room_id, round_number, sender_id, body) values ($1, $2, 1, $3, 'hello')", ["00000000-0000-0000-0000-000000000099", firstId, firstGuesser]), /permission denied/);
    await assert.rejects(asUser(firstGuesser, "insert into public.room_messages (created_at, room_id, round_number, sender_id, body) values (now() + interval '10 years', $1, 1, $2, 'hello')", [firstId, firstGuesser]), /permission denied/);
    assert.equal(await value(firstGuesser, "select public.request_room_hint($1, $2) as value", [firstId, 1]), "提示");
    assert.equal(await value(firstGuesser, "select public.request_room_hint($1, $2) as value", [firstId, 1]), "提示");
    assert.equal((await value(firstGuesser, "select public.end_expired_round($1, $2) as value", [firstId, 1])).state, "active");
  });

  await t.test("a finished room remains open until leaving, then a retry cannot cancel a new queue", async () => {
    const guess = "select public.submit_guess($1, $2, $3) as value";
    assert.equal((await value(firstGuesser, guess, [firstId, "筷子", 1])).correct, false);
    assert.equal((await value(firstGuesser, guess, [firstId, "洋傘", 1])).correct, true);
    const after = await value(firstGuesser, guess, [firstId, "錯誤答案", 1]);
    assert.equal(after.state, "solved");
    assert.equal(after.correct, null);
    assert.equal((await value(firstGuesser, "select public.join_matchmaking($1) as value", ["甲"])).room_id, firstId);
    assert.equal(await value(users[0], "select public.leave_room($1) as value", [firstId]), true);
    assert.equal((await room(users[1], firstId)).status, "abandoned");
    assert.equal((await value(users[0], "select public.join_matchmaking($1) as value", ["甲"])).state, "waiting");
    assert.equal(await value(users[0], "select public.leave_room($1) as value", [firstId]), true);
    const match = await value(users[2], "select public.join_matchmaking($1) as value", ["丙"]);
    assert.equal(match.state, "matched");
    secondId = match.room_id;
    const r = await room(users[0], secondId);
    secondSetter = r.setter_id;
    secondGuesser = r.guesser_id;
  });

  await t.test("timeout uses wall clock after lock acquisition, not transaction start", async () => {
    // The old five-argument API remains callable after the migration.
    await value(secondSetter, "select public.submit_riddle($1, $2, $3, $4, $5::text[]) as value", [secondId, "題目", "答案", "提示", []]);
    await db.exec("reset role");
    const result = await db.transaction(async (tx) => {
      await tx.query("update public.match_rooms set expires_at = now() + interval '50 milliseconds' where id = $1", [secondId]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, false)", [secondGuesser]);
      await tx.exec("set local role authenticated; select pg_sleep(0.15)");
      return tx.query("select public.submit_guess($1, $2, $3) as value", [secondId, "答案", 1]);
    });
    assert.equal(result.rows[0].value.state, "timed_out");
    assert.equal(result.rows[0].value.correct, false);
    assert.equal(result.rows[0].value.answer, "答案");
    const repeat = await value(secondGuesser, "select public.submit_guess($1, $2, $3) as value", [secondId, "答案", 1]);
    assert.equal(repeat.state, "timed_out");
    assert.equal(repeat.answer, "答案");
    assert.equal((await value(secondSetter, "select public.end_expired_round($1, $2) as value", [secondId, 1])).answer, "答案");
  });

  await t.test("stale round operations are rejected and expired messages are not accepted", async () => {
    const next = await value(secondSetter, "select public.start_next_round($1, $2) as value", [secondId, 1]);
    assert.equal(next.round_number, 2);
    await assert.rejects(value(secondSetter, "select public.start_next_round($1, $2) as value", [secondId, 1]), /round_changed/);
    await assert.rejects(value(secondSetter, "select public.end_expired_round($1, $2) as value", [secondId, 1]), /round_changed/);
    const r = await room(secondSetter, secondId);
    assert.equal((await asUser(r.setter_id, "select * from public.room_secrets where room_id = $1", [secondId])).rows.length, 0);
    await assert.rejects(value(r.setter_id, "select public.submit_riddle($1, $2, $3, $4, $5::text[], $6) as value", [secondId, "舊題目", "舊答案", "舊提示", [], 1]), /round_changed/);
    await value(r.setter_id, "select public.submit_riddle($1, $2, $3, $4, $5::text[], $6) as value", [secondId, "新題目", "新答案", "新提示", [], 2]);
    await assert.rejects(value(r.guesser_id, "select public.submit_guess($1, $2, $3) as value", [secondId, "新答案", 1]), /round_changed/);
    await assert.rejects(value(r.guesser_id, "select public.request_room_hint($1, $2) as value", [secondId, 1]), /round_changed/);
    await admin("update public.match_rooms set expires_at = clock_timestamp() - interval '1 second' where id = $1", [secondId]);
    await assert.rejects(asUser(r.guesser_id, "insert into public.room_messages (room_id, round_number, sender_id, body) values ($1, 2, $2, '超時訊息')", [secondId, r.guesser_id]), /message_action_not_allowed/);
    assert.equal(await value(r.guesser_id, "select public.request_room_hint($1, $2) as value", [secondId, 2]), null);
    assert.equal((await room(r.setter_id, secondId)).status, "timed_out");
    await value(r.setter_id, "select public.leave_room($1) as value", [secondId]);
    assert.equal((await room(r.guesser_id, secondId)).status, "abandoned");
  });
});
