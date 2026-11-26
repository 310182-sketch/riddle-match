import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import { createHandler } from "./api.mjs";

test("browser client interoperates with API and database for two separate players", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile(new URL("../migrations/20261126000000_riddle_match.sql", import.meta.url), "utf8"));
  const pool = {
    query: (sql, args) => db.query(sql, args),
    connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }),
  };
  const api = createHandler({ pool, cleanupSample: () => false });
  const source = await readFile(new URL("../../site/neon-client.js", import.meta.url), "utf8");
  function browser(storage = new Map()) {
    const window = {
      RIDDLE_MATCH_NEON_CONFIG: { functionUrl: "https://function.example.test/" },
      sessionStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
      dispatchEvent() {},
    };
    const fetch = (url, options) => {
      const headers = new Headers(options.headers);
      headers.set("Origin", "https://310182-sketch.github.io");
      return api(new Request(url, { ...options, headers }));
    };
    vm.runInNewContext(source, { window, URL, AbortController, Event, fetch, setTimeout, clearTimeout });
    return { client: window.RiddleMatchNeon, storage };
  }
  const a = browser();
  const b = browser();
  const outsider = browser();
  const identityA = await a.client.initialize();
  const identityB = await b.client.initialize();
  await outsider.client.initialize();
  assert.notEqual(identityA.user.id, identityB.user.id);
  const restoredA = browser(a.storage);
  assert.equal((await restoredA.client.initialize()).user.id, identityA.user.id);
  let result = await a.client.rpc("join_matchmaking", { p_nickname: "甲" });
  assert.equal(result.data.state, "waiting");
  result = await b.client.rpc("join_matchmaking", { p_nickname: "乙" });
  const roomId = result.data.room_id;
  result = await a.client.rpc("get_room", { p_room_id: roomId });
  const setter = result.data.setter_id === identityA.user.id ? a.client : b.client;
  const guesser = setter === a.client ? b.client : a.client;
  result = await outsider.client.rpc("get_room", { p_room_id: roomId });
  assert.equal(result.error.code, "forbidden");
  result = await setter.rpc("submit_riddle", {
    p_room_id: roomId, p_round_number: 1, p_riddle: "下雨時用", p_answer: "雨傘", p_hint: "遮雨", p_accepted_answers: [],
  });
  assert.equal(result.error, null);
  result = await guesser.rpc("get_room", { p_room_id: roomId });
  assert.equal(result.data.riddle, "下雨時用");
  assert.equal(Object.hasOwn(result.data, "answer"), false);
  result = await guesser.rpc("submit_guess", { p_room_id: roomId, p_round_number: 1, p_guess: "雨傘" });
  assert.equal(result.data.correct, true);
  result = await guesser.rpc("start_next_round", { p_room_id: roomId, p_round_number: 1 });
  assert.equal(result.error, null);
});
