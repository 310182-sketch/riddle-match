import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createHandler } from "./api.mjs";

test("real Postgres schema and HTTP API isolate sessions and complete a two-player round", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const dir = new URL("../migrations/", import.meta.url);
  const migrations = (await readdir(dir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  assert.ok(migrations.includes("20261126010000_player_blocks.sql"));
  for (const name of migrations) await db.exec(await readFile(new URL(name, dir), "utf8"));
  const pool = {
    query: (sql, args) => db.query(sql, args),
    connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }),
  };
  const fetch = createHandler({ pool, cleanupSample: () => false });
  const request = async (path, token, body) => {
    const headers = { Origin: "https://310182-sketch.github.io", "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(new Request(`https://example.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  const create = async () => {
    const result = await request("/session", null, {});
    assert.equal(result.status, 201);
    return result.body;
  };
  const playerA = await create();
  const playerB = await create();
  const outsider = await create();
  const rpc = (player, name, body) => request(`/rpc/${name}`, player.token, body);

  let result = await rpc(playerA, "join_matchmaking", { p_nickname: "甲" });
  assert.equal(result.body.data.state, "waiting");
  result = await rpc(playerB, "join_matchmaking", { p_nickname: "乙" });
  assert.equal(result.body.data.state, "matched");
  const roomId = result.body.data.room_id;
  result = await rpc(playerA, "get_room", { p_room_id: roomId });
  assert.equal(result.status, 200);
  const room = result.body.data;
  const setter = room.setter_id === playerA.user_id ? playerA : playerB;
  const guesser = setter === playerA ? playerB : playerA;
  const roomArg = { p_room_id: roomId };
  const roundArg = { ...roomArg, p_round_number: 1 };

  const unauthorized = await rpc(outsider, "get_room", roomArg);
  assert.equal(unauthorized.status, 403);
  assert.equal(unauthorized.body.error.code, "forbidden");
  result = await rpc(setter, "submit_riddle", {
    ...roundArg, p_riddle: "下雨時帶的東西", p_answer: "雨傘", p_hint: "可以遮雨", p_accepted_answers: [],
  });
  assert.equal(result.status, 200);
  result = await rpc(guesser, "get_room", roomArg);
  assert.equal(result.body.data.riddle, "下雨時帶的東西");
  assert.equal(Object.hasOwn(result.body.data, "answer"), false);
  assert.equal(Object.hasOwn(result.body.data, "hint"), false);
  result = await rpc(guesser, "end_expired_round", roundArg);
  assert.equal(result.body.data.state, "active");
  assert.equal(Object.hasOwn(result.body.data, "answer"), false);

  result = await rpc(guesser, "send_room_message", { ...roundArg, p_body: "它可以折疊嗎？" });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.sender_id, guesser.user_id);
  result = await rpc(setter, "get_room_messages", roundArg);
  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].body, "它可以折疊嗎？");
  assert.equal((await rpc(outsider, "get_room_messages", roundArg)).status, 403);
  result = await rpc(guesser, "submit_guess", { ...roundArg, p_guess: "雨傘" });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.correct, true);
  result = await rpc(guesser, "start_next_round", roundArg);
  assert.equal(result.status, 200);
  result = await rpc(guesser, "submit_guess", { ...roundArg, p_guess: "雨傘" });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "round_changed");
  result = await rpc(guesser, "get_room", roomArg);
  assert.equal(result.body.data.round_number, 2);
  assert.notEqual(result.body.data.setter_id, setter.user_id);

  // A different session cannot block players in a room it never joined.
  result = await rpc(outsider, "block_opponent", roomArg);
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "forbidden");
  result = await rpc(setter, "block_opponent", roomArg);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.state, "blocked");
  result = await rpc(setter, "block_opponent", roomArg);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.state, "blocked");
  result = await rpc(guesser, "get_room", roomArg);
  assert.equal(result.body.data.status, "abandoned");
  assert.equal((await rpc(playerA, "join_matchmaking", { p_nickname: "甲" })).body.data.state, "waiting");
  assert.equal((await rpc(playerB, "join_matchmaking", { p_nickname: "乙" })).body.data.state, "waiting");

  // A participant can also block after the other player has already left.
  result = await rpc(outsider, "join_matchmaking", { p_nickname: "丙" });
  assert.equal(result.body.data.state, "matched");
  const laterRoom = result.body.data.room_id;
  const laterRoomArg = { p_room_id: laterRoom };
  result = await rpc(outsider, "get_room", laterRoomArg);
  const otherId = [result.body.data.player_one_id, result.body.data.player_two_id].find((id) => id !== outsider.user_id);
  const otherPlayer = otherId === playerA.user_id ? playerA : playerB;
  assert.equal((await rpc(outsider, "leave_room", laterRoomArg)).status, 200);
  result = await rpc(otherPlayer, "block_opponent", laterRoomArg);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.state, "blocked");
});
