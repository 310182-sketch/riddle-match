import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../site/neon-client.js", import.meta.url), "utf8");
const expiry = "2027-01-01T00:00:00Z";

function browser({ storage = new Map(), fetch, url = "https://functions.example" } = {}) {
  const events = [];
  const window = {
    RIDDLE_MATCH_NEON_CONFIG: { functionUrl: url },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    dispatchEvent: (event) => events.push(event.type),
  };
  vm.runInNewContext(source, { window, URL, fetch, AbortController, Event, setTimeout, clearTimeout });
  return { client: window.RiddleMatchNeon, events, storage };
}
const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("匿名 session 保存在分頁中；刷新時驗證並重用，token 不進 URL", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === "POST" && String(url).endsWith("/session")) return json(201, { token: "secret-token", user_id: "player-1", expires_at: expiry });
    if (options.method === "GET") return json(200, { user_id: "player-1", expires_at: expiry });
    return json(200, { data: { state: "waiting" } });
  };
  const first = browser({ fetch });
  assert.equal((await first.client.initialize()).user.id, "player-1");
  first.client.saveContext({ nickname: "小藍", roomId: "room-1" });
  const result = await first.client.rpc("join_matchmaking", { p_nickname: "小藍" });
  assert.equal(result.data.state, "waiting");
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[1].options.body, '{"p_nickname":"小藍"}');
  assert.ok(calls.every((call) => !call.url.includes("secret-token")));
  const reloaded = browser({ storage: first.storage, fetch });
  assert.equal((await reloaded.client.initialize()).user.id, "player-1");
  assert.equal(reloaded.client.getContext().roomId, "room-1");
  assert.equal(calls.filter((call) => call.options.method === "POST" && call.url.endsWith("/session")).length, 1);
});

test("過期 session 清除舊房間並取得新身分；RPC 401 只廣播一次", async () => {
  const storage = new Map([
    ["riddle-match-neon-session-v1", JSON.stringify({ token: "old", user_id: "old-player", expires_at: expiry })],
    ["riddle-match-neon-context-v1", JSON.stringify({ nickname: "小藍", roomId: "old-room" })],
  ]);
  const fetch = async (url, options) => {
    if (String(url).endsWith("/session") && options.method === "GET") return json(401, { error: { code: "invalid_session" } });
    if (String(url).endsWith("/session")) return json(201, { token: "new", user_id: "new-player", expires_at: expiry });
    return json(401, { error: { code: "invalid_session", message: "private diagnostic" } });
  };
  const page = browser({ storage, fetch });
  const result = await page.client.initialize();
  assert.equal(result.user.id, "new-player");
  assert.equal(result.wasReset, true);
  assert.equal(page.client.getContext().roomId, undefined);
  const firstError = await page.client.rpc("get_room", { p_room_id: "old-room" });
  await page.client.rpc("get_room", { p_room_id: "old-room" });
  assert.equal(firstError.error.code, "invalid_session");
  assert.equal(firstError.error.message, "invalid_session");
  assert.deepEqual(page.events, ["riddle-neon-session-expired"]);
});

test("拒絕不安全的 Function URL，允許本機 HTTP 測試", () => {
  const fetch = async () => json(200, {});
  for (const url of ["http://example.com", "https://user:password@example.com", "https://example.com/?token=secret", "https://example.com/#x"]) {
    assert.throws(() => browser({ url, fetch }), /Neon function URL/);
  }
  assert.ok(browser({ url: "http://localhost:3000", fetch }).client);
});

test("舊 session 的延遲 401 不會使新 session 再度失效", async () => {
  let resolveOld;
  let created = 0;
  const fetch = async (url, options) => {
    if (String(url).endsWith("/session") && options.method === "POST") {
      created += 1;
      return json(201, { token: `token-${created}`, user_id: `player-${created}`, expires_at: expiry });
    }
    return new Promise((resolve) => { resolveOld = resolve; });
  };
  const page = browser({ fetch });
  await page.client.initialize();
  const oldRequest = page.client.rpc("get_room", { p_room_id: "room-1" });
  await page.client.createSession();
  resolveOld(json(401, { error: { code: "invalid_session" } }));
  assert.equal((await oldRequest).error.code, "invalid_session");
  assert.deepEqual(page.events, []);
});
