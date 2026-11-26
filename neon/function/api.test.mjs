import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHandler, databaseUrl } from "./api.mjs";

const ORIGIN = "https://310182-sketch.github.io";
const USER = "c7c2eb58-14ed-426f-8b39-ad640d939cda";
const ROOM = "5143b572-9278-40f0-84fb-72d649cf2156";

class FakePool {
  sessions = new Map();
  limits = new Map();
  calls = [];
  rpcError = null;
  async query(sql, args = []) { return this.execute(sql, args, {}); }
  async connect() {
    const client = { context: null, release() {} };
    client.query = (sql, args = []) => this.execute(sql, args, client);
    return client;
  }
  async execute(sql, args, client) {
    const statement = sql.trim().replace(/\s+/g, " ").toLowerCase();
    this.calls.push({ sql: statement, args, context: client.context });
    if (["begin", "commit", "rollback"].includes(statement)) return { rows: [] };
    if (statement.startsWith("insert into riddle_match.api_rate_limits")) {
      const count = this.limits.get(args[0]) || 0;
      if (count >= args[1]) return { rows: [] };
      this.limits.set(args[0], count + 1);
      return { rows: [{ hits: count + 1 }] };
    }
    if (statement.startsWith("insert into riddle_match.players")) return { rows: [{ id: USER }] };
    if (statement.startsWith("insert into riddle_match.player_sessions")) {
      const data = { player_id: args[1], expires_at: new Date(Date.now() + 60_000) };
      this.sessions.set(args[0], data);
      return { rows: [{ expires_at: data.expires_at }] };
    }
    if (statement.startsWith("select player_id, expires_at")) {
      const data = this.sessions.get(args[0]);
      return { rows: data && data.expires_at > new Date() ? [data] : [] };
    }
    if (statement.startsWith("select set_config")) {
      client.context = args[0];
      return { rows: [{ set_config: args[0] }] };
    }
    if (statement === "select riddle_match.cleanup_expired_data()") return { rows: [{ cleanup_expired_data: {} }] };
    if (statement.startsWith("select riddle_match.")) {
      if (this.rpcError) throw this.rpcError;
      if (client.context !== USER) throw Object.assign(new Error("forbidden"), { code: "42501" });
      return { rows: [{ data: { ok: true } }] };
    }
    throw new Error(`Unexpected SQL in test: ${statement}`);
  }
}

function request(path, { method = "GET", origin = ORIGIN, token, body, headers = {} } = {}) {
  const values = new Headers(headers);
  if (origin !== null) values.set("Origin", origin);
  if (token) values.set("Authorization", `Bearer ${token}`);
  if (body !== undefined && !values.has("content-type")) values.set("Content-Type", "application/json");
  return new Request(`https://example.test${path}`, { method, headers: values, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function setup() {
  const pool = new FakePool();
  const fetch = createHandler({ pool, cleanupSample: () => false });
  const created = await fetch(request("/session", { method: "POST", body: {} }));
  const session = await created.json();
  return { pool, fetch, created, session };
}

test("multi-step transactions require the direct branch connection", () => {
  assert.equal(databaseUrl({ DATABASE_URL_UNPOOLED: "direct", DATABASE_URL: "pooled" }), "direct");
  assert.throws(() => databaseUrl({ DATABASE_URL: "pooled" }), /DATABASE_URL_UNPOOLED/);
});

test("session tokens are random, only the hash is stored, and GET validates them", async () => {
  const app = await setup();
  assert.equal(app.created.status, 201);
  assert.equal(app.created.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(app.created.headers.get("cache-control"), "no-store");
  assert.match(app.session.token, /^[A-Za-z0-9_-]{43}$/);
  const hash = createHash("sha256").update(app.session.token).digest("hex");
  assert.equal(app.pool.sessions.has(hash), true);
  assert.equal(app.pool.sessions.has(app.session.token), false);
  const restored = await app.fetch(request("/session", { token: app.session.token }));
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).user_id, USER);
  const second = await app.fetch(request("/session", { method: "POST", body: {} }));
  assert.notEqual((await second.json()).token, app.session.token);
});

test("CORS permits only explicitly configured origins and handles preflight", async () => {
  const pool = new FakePool();
  const fetch = createHandler({ pool, origins: `${ORIGIN},http://localhost:4173` });
  const preflight = await fetch(request("/rpc/get_room", { method: "OPTIONS", origin: "http://localhost:4173" }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:4173");
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/i);
  const denied = await fetch(request("/session", { method: "POST", origin: "https://attacker.test", body: {} }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const missingOrigin = await fetch(request("/session", { method: "POST", origin: null, body: {} }));
  assert.equal(missingOrigin.status, 403);
  assert.equal(pool.calls.length, 0);
});

test("request bodies are bounded, typed, and reject unexpected fields", async () => {
  const app = await setup();
  const large = await app.fetch(request("/session", { method: "POST", body: { x: "a".repeat(9000) } }));
  assert.equal(large.status, 413);
  const unknown = await app.fetch(request("/rpc/get_room", { method: "POST", token: app.session.token, body: { p_room_id: ROOM, admin: true } }));
  assert.equal(unknown.status, 400);
  const badType = await app.fetch(new Request("https://example.test/session", {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "text/plain" }, body: "{}",
  }));
  assert.equal(badType.status, 400);
  assert.equal(app.pool.calls.some(({ sql }) => sql.startsWith("select riddle_match.get_room")), false);
});

test("RPC calls are allowlisted, parameterized, and bound to transaction-local player identity", async () => {
  const app = await setup();
  const payload = { p_room_id: ROOM, p_round_number: 2, p_guess: "') ; DROP TABLE x; --" };
  const result = await app.fetch(request("/rpc/submit_guess", { method: "POST", token: app.session.token, body: payload }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { data: { ok: true } });
  const query = app.pool.calls.find(({ sql }) => sql.startsWith("select riddle_match.submit_guess"));
  assert.equal(query.context, USER);
  assert.equal(query.sql.includes("DROP TABLE"), false);
  assert.deepEqual(query.args, [ROOM, payload.p_guess, 2]);
  const unknown = await app.fetch(request("/rpc/drop_table", { method: "POST", token: app.session.token, body: {} }));
  assert.equal(unknown.status, 404);
  const missingRound = await app.fetch(request("/rpc/submit_guess", { method: "POST", token: app.session.token, body: { p_room_id: ROOM, p_guess: "test" } }));
  assert.equal(missingRound.status, 400);
});

test("expired and fabricated sessions fail before any protected RPC", async () => {
  const app = await setup();
  const hash = createHash("sha256").update(app.session.token).digest("hex");
  app.pool.sessions.get(hash).expires_at = new Date(0);
  const expired = await app.fetch(request("/rpc/get_room", { method: "POST", token: app.session.token, body: { p_room_id: ROOM } }));
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, "invalid_session");
  const fake = await app.fetch(request("/session", { token: "A".repeat(43) }));
  assert.equal(fake.status, 401);
  assert.equal(app.pool.calls.some(({ sql }) => sql.startsWith("select riddle_match.get_room")), false);
});

test("a session expiring after the rate check is revalidated inside the RPC transaction", async () => {
  const app = await setup();
  const hash = createHash("sha256").update(app.session.token).digest("hex");
  const original = app.pool.execute.bind(app.pool);
  app.pool.execute = async (sql, args, client) => {
    const result = await original(sql, args, client);
    if (sql.includes("riddle_match.api_rate_limits") && args[0] === `player:${USER}`) {
      app.pool.sessions.get(hash).expires_at = new Date(0);
    }
    return result;
  };
  const result = await app.fetch(request("/rpc/get_room", { method: "POST", token: app.session.token, body: { p_room_id: ROOM } }));
  assert.equal(result.status, 401);
  assert.equal(app.pool.calls.some(({ sql }) => sql.startsWith("select riddle_match.get_room")), false);
  assert.ok(app.pool.calls.some(({ sql }) => sql === "rollback"));
});

test("rate budgets are enforced and database errors never expose internals", async () => {
  const app = await setup();
  app.pool.limits.set(`player:${USER}`, 150);
  const limited = await app.fetch(request("/session", { token: app.session.token }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  app.pool.limits.set(`player:${USER}`, 0);
  app.pool.rpcError = Object.assign(new Error("postgres://secret@example"), { code: "08006" });
  const failure = await app.fetch(request("/rpc/get_room", { method: "POST", token: app.session.token, body: { p_room_id: ROOM } }));
  assert.equal(failure.status, 500);
  assert.doesNotMatch(await failure.text(), /postgres|secret|example/);
  assert.ok(app.pool.calls.some(({ sql }) => sql === "rollback"));
  assert.equal(app.pool.limits.get(`player:${USER}`), 1);
  app.pool.limits.set("session-create", 30);
  const createLimited = await app.fetch(request("/session", { method: "POST", body: {} }));
  assert.equal(createLimited.status, 429);
});

test("stale-round, forbidden-room, and chat-rate errors use safe response codes", async () => {
  const app = await setup();
  const call = () => app.fetch(request("/rpc/get_room", { method: "POST", token: app.session.token, body: { p_room_id: ROOM } }));
  app.pool.rpcError = Object.assign(new Error("round_changed"), { code: "P0001" });
  let res = await call();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "round_changed");
  app.pool.rpcError = Object.assign(new Error("private details"), { code: "42501" });
  res = await call();
  assert.equal(res.status, 403);
  assert.doesNotMatch(await res.text(), /private details/);
  app.pool.rpcError = Object.assign(new Error("message_rate_limited"), { code: "P0001" });
  res = await call();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "1");
});

test("sampled cleanup runs in background after a successful session is persisted", async () => {
  const pool = new FakePool();
  const jobs = [];
  const fetch = createHandler({ pool, cleanupSample: () => true, background: (job) => jobs.push(job) });
  const res = await fetch(request("/session", { method: "POST", body: {} }));
  assert.equal(res.status, 201);
  await Promise.all(jobs);
  assert.equal(jobs.length, 1);
  assert.ok(pool.calls.some(({ sql }) => sql === "select riddle_match.cleanup_expired_data()"));
});
