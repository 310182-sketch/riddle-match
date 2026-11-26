import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

// Only opt in with an explicitly supplied, disposable PostgreSQL database.
// A pre-existing riddle_match schema causes the migration to fail before any
// test changes, and is never removed by this test.
const databaseUrl = process.env.RIDDLE_MATCH_TEST_DATABASE_URL;

test("PostgreSQL concurrent matchmaking, room membership and round transitions", {
  skip: !databaseUrl ? "set RIDDLE_MATCH_TEST_DATABASE_URL to an isolated PostgreSQL database" : false,
  timeout: 30000,
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000 });
  const clients = [];
  let installed = false;
  async function open() { const client = await pool.connect(); clients.push(client); return client; }
  async function actor(client, id) {
    await client.query("begin");
    await client.query("select set_config('riddle_match.player_id', $1, true)", [id]);
  }
  const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`);

  try {
    const admin = await open(), a = await open(), b = await open(), c = await open();
    const migration = await readFile(new URL("../migrations/20261126000000_riddle_match.sql", import.meta.url), "utf8");
    await admin.query("begin");
    try {
      await admin.query(migration);
      await admin.query("commit");
      installed = true;
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
    for (const id of ids) await admin.query("insert into riddle_match.players(id) values ($1)", [id]);

    // Two simultaneous joiners cannot claim the same waiting player.
    await actor(a, ids[0]);
    await a.query("select riddle_match.join_matchmaking('A')");
    await a.query("commit");
    await actor(b, ids[1]); await actor(c, ids[2]);
    const joined = await Promise.all([
      b.query("select riddle_match.join_matchmaking('B') as value").then(async (r) => { await b.query("commit"); return r.rows[0].value; }),
      c.query("select riddle_match.join_matchmaking('C') as value").then(async (r) => { await c.query("commit"); return r.rows[0].value; }),
    ]);
    assert.deepEqual(joined.map((v) => v.state).sort(), ["matched", "waiting"]);
    const room = joined.find((v) => v.state === "matched").room_id;
    const players = (await admin.query("select setter_id, guesser_id from riddle_match.match_rooms where id = $1", [room])).rows[0];
    await actor(a, players.setter_id);
    await a.query("select riddle_match.submit_riddle($1,'題目','答案','提示',array[]::text[],1)", [room]);
    await a.query("commit");

    // A guess begins before expiration, but cannot acquire the row lock until
    // after it. The decision must use the wall clock after acquiring the lock.
    await admin.query("begin");
    await admin.query("update riddle_match.match_rooms set expires_at = clock_timestamp() + interval '200 milliseconds' where id = $1", [room]);
    await actor(b, players.guesser_id);
    const pendingGuess = b.query("select riddle_match.submit_guess($1,'答案',1) as value", [room]);
    await delay(500);
    await admin.query("commit");
    const result = (await pendingGuess).rows[0].value;
    await b.query("commit");
    assert.equal(result.state, "timed_out");
    assert.equal(result.correct, false);
    assert.equal(result.answer, "答案");

    // This also exercises the trigger when the second INSERT starts while the
    // first transaction still owns the advisory lock, in opposite player slots.
    await a.query("begin"); await b.query("begin");
    const insert = `insert into riddle_match.match_rooms
      (player_one_id, player_two_id, player_one_nickname, player_two_nickname, setter_id, guesser_id, topic_number, topic)
      values ($1, $2, '甲', '乙', $1, $2, 1, '主題')`;
    await a.query(insert, [ids[3], ids[4]]);
    const pendingInsert = b.query(insert, [ids[5], ids[3]]).then(() => null, (error) => error);
    await delay(100); await a.query("commit");
    const collision = await pendingInsert;
    assert.ok(collision, "the second open room must not be created");
    assert.match(collision.message, /player_already_in_open_room/);
    await b.query("rollback");

    // Exactly one participant can advance the same finished round.
    await actor(a, players.setter_id); await actor(b, players.guesser_id);
    const advanced = await Promise.all([
      a.query("select riddle_match.start_next_round($1,1) as value", [room]).then(async (r) => { await a.query("commit"); return r.rows[0].value; }, async (e) => { await a.query("rollback"); return e; }),
      b.query("select riddle_match.start_next_round($1,1) as value", [room]).then(async (r) => { await b.query("commit"); return r.rows[0].value; }, async (e) => { await b.query("rollback"); return e; }),
    ]);
    assert.equal(advanced.filter((v) => v.round_number === 2).length, 1);
    assert.equal(advanced.filter((v) => v.message === "round_changed").length, 1);
  } finally {
    // The schema is dropped only if this test created it successfully.
    await Promise.allSettled(clients.map((client) => client.query("rollback")));
    if (installed && clients.length) await clients[0].query("drop schema riddle_match cascade");
    clients.forEach((client) => client.release());
    await pool.end();
  }
});
