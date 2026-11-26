import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ids = Array.from({ length: 5 }, (_, i) => `10000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`);
const hashes = ["a", "b", "c", "d", "e"].map((s) => s.repeat(64));

test("upgraded anonymous-player blocking protects both sides of matchmaking", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const migration = async (name) => db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  await migration("20261126000000_riddle_match.sql");
  for (let i = 0; i < ids.length; i++) {
    await db.query("insert into riddle_match.players (id) values ($1)", [ids[i]]);
    await db.query("insert into riddle_match.player_sessions (token_hash,player_id,expires_at) values ($1,$2,clock_timestamp()+interval '1 day')", [hashes[i], ids[i]]);
  }
  async function asPlayer(index, sql, params = []) {
    return db.transaction(async (tx) => {
      const session = await tx.query("select player_id from riddle_match.player_sessions where token_hash=$1 and expires_at > clock_timestamp()", [hashes[index]]);
      if (!session.rows.length) throw new Error("session_invalid");
      await tx.query("select set_config('riddle_match.player_id',$1,true)", [session.rows[0].player_id]);
      return tx.query(sql, params);
    });
  }
  async function value(index, sql, params = []) { return (await asPlayer(index, sql, params)).rows[0].value; }
  async function join(index) { return value(index, "select riddle_match.join_matchmaking($1) as value", [`玩家${index}`]); }
  async function block(index, id) { return value(index, "select riddle_match.block_opponent($1) as value", [id]); }
  async function getRoom(index, id) { return value(index, "select riddle_match.get_room($1) as value", [id]); }
  async function leave(index, id) { return value(index, "select riddle_match.leave_room($1) as value", [id]); }
  async function cancel(index) { return value(index, "select riddle_match.cancel_matchmaking() as value"); }
  let firstRoom;

  await t.test("upgrade preserves existing rooms and only participants can block", async () => {
    assert.equal((await join(0)).state, "waiting");
    firstRoom = (await join(1)).room_id;
    await migration("20261126010000_player_blocks.sql");
    assert.equal((await getRoom(0, firstRoom)).id, firstRoom);
    await assert.rejects(block(2, firstRoom), /room_access_denied/);
    assert.equal((await db.query("select count(*)::int as n from riddle_match.player_blocks")).rows[0].n, 0);
    await assert.rejects(db.query("select riddle_match.block_opponent($1)", [firstRoom]), /authentication_required/);
  });

  await t.test("blocking ends the room, is idempotent, and excludes both directions", async () => {
    assert.equal((await block(0, firstRoom)).state, "blocked");
    assert.equal((await getRoom(1, firstRoom)).status, "abandoned");
    assert.equal((await block(0, firstRoom)).state, "blocked");
    assert.equal((await db.query("select count(*)::int as n from riddle_match.player_blocks")).rows[0].n, 1);
    // Both queue orders must fail to match the blocked pair.
    assert.equal((await join(1)).state, "waiting");
    assert.equal((await join(0)).state, "waiting");
    await cancel(0); await cancel(1);
    assert.equal((await join(0)).state, "waiting");
    assert.equal((await join(1)).state, "waiting");
    await assert.rejects(db.query(`insert into riddle_match.match_rooms
      (player_one_id,player_two_id,player_one_nickname,player_two_nickname,setter_id,guesser_id,topic_number,topic)
      values ($1,$2,'甲','乙',$1,$2,1,'主題')`, [ids[1], ids[0]]), /players_blocked/);
  });

  await t.test("repeat block does not cancel a later queue or an unrelated room", async () => {
    assert.equal((await block(0, firstRoom)).state, "blocked");
    const other = await join(2);
    assert.equal(other.state, "matched");
    const r = await getRoom(0, other.room_id);
    assert.ok([r.player_one_id, r.player_two_id].includes(ids[2]));
    assert.equal((await block(0, firstRoom)).state, "blocked");
    assert.equal((await getRoom(0, other.room_id)).status, "waiting_setter");
    assert.equal((await join(1)).state, "waiting");
    await leave(0, other.room_id);
    assert.equal((await join(0)).state, "waiting");
    await cancel(0); await cancel(1);
  });

  await t.test("late block closes a rematch of the same pair and cleanup removes old blocks", async () => {
    assert.equal((await join(3)).state, "waiting");
    const oldRoom = (await join(4)).room_id;
    await leave(3, oldRoom);
    assert.equal((await join(3)).state, "waiting");
    const newRoom = (await join(4)).room_id;
    assert.notEqual(newRoom, oldRoom);
    assert.equal((await block(3, oldRoom)).state, "blocked");
    assert.equal((await getRoom(4, newRoom)).status, "abandoned");
    await db.query("update riddle_match.match_rooms set ended_at = clock_timestamp() - interval '8 days' where id in ($1,$2)", [oldRoom, newRoom]);
    await db.query("update riddle_match.player_sessions set expires_at = clock_timestamp() - interval '1 day' where player_id in ($1,$2)", [ids[3], ids[4]]);
    await db.query("update riddle_match.players set created_at = clock_timestamp() - interval '8 days' where id in ($1,$2)", [ids[3], ids[4]]);
    await db.query("select riddle_match.cleanup_expired_data()");
    assert.equal((await db.query("select count(*)::int as n from riddle_match.player_blocks where blocker_id=$1 or blocked_id=$1", [ids[3]])).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int as n from riddle_match.players where id in ($1,$2)", [ids[3], ids[4]])).rows[0].n, 0);
  });
});
