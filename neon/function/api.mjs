import { createHash, randomBytes, randomInt } from "node:crypto";
import { verifiedDatabaseUrl } from "./database-url.mjs";

const DEFAULT_ORIGIN = "https://310182-sketch.github.io";
const MAX_BODY_BYTES = 8192;
const BODY_TIMEOUT_MS = 5000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function databaseUrl(env) {
  if (!env.DATABASE_URL_UNPOOLED) throw new Error("DATABASE_URL_UNPOOLED is required");
  return verifiedDatabaseUrl(env.DATABASE_URL_UNPOOLED);
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new ApiError(status, code, message); }
function invalid() { fail(400, "invalid_request", "請確認送出的資料。"); }
function text(value, max) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  const result = value.trim();
  if (!result || Array.from(result).length > max) invalid();
  return result;
}
function uuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid();
  return value;
}
function round(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid();
  return value;
}
function exactKeys(body, required, optional = []) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
  if (required.some((key) => !Object.hasOwn(body, key))) invalid();
  if (Object.keys(body).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}

// SQL text is fixed here; clients can only select from this list and provide values.
const rpc = {
  join_matchmaking: {
    sql: "select riddle_match.join_matchmaking($1::text) as data",
    args: (b) => { exactKeys(b, ["p_nickname"]); return [text(b.p_nickname, 24)]; },
  },
  cancel_matchmaking: {
    sql: "select riddle_match.cancel_matchmaking() as data",
    args: (b) => { exactKeys(b, []); return []; },
  },
  get_room: {
    sql: "select riddle_match.get_room($1::uuid) as data",
    args: (b) => { exactKeys(b, ["p_room_id"]); return [uuid(b.p_room_id)]; },
  },
  get_room_messages: {
    sql: "select riddle_match.get_room_messages($1::uuid,$2::integer) as data",
    args: (b) => { exactKeys(b, ["p_room_id", "p_round_number"]); return [uuid(b.p_room_id), round(b.p_round_number)]; },
  },
  send_room_message: {
    sql: "select riddle_match.send_room_message($1::uuid,$2::integer,$3::text) as data",
    args: (b) => { exactKeys(b, ["p_room_id", "p_round_number", "p_body"]); return [uuid(b.p_room_id), round(b.p_round_number), text(b.p_body, 180)]; },
  },
  submit_riddle: {
    sql: "select riddle_match.submit_riddle($1::uuid,$2::text,$3::text,$4::text,$5::text[],$6::integer) as data",
    args: (b) => {
      exactKeys(b, ["p_room_id", "p_riddle", "p_answer", "p_hint", "p_round_number"], ["p_accepted_answers"]);
      const aliases = b.p_accepted_answers ?? [];
      if (!Array.isArray(aliases) || aliases.length > 10) invalid();
      return [uuid(b.p_room_id), text(b.p_riddle, 180), text(b.p_answer, 80), text(b.p_hint, 180), aliases.map((a) => text(a, 80)), round(b.p_round_number)];
    },
  },
  submit_guess: {
    sql: "select riddle_match.submit_guess($1::uuid,$2::text,$3::integer) as data",
    args: (b) => { exactKeys(b, ["p_room_id", "p_guess", "p_round_number"]); return [uuid(b.p_room_id), text(b.p_guess, 100), round(b.p_round_number)]; },
  },
  request_room_hint: {
    sql: "select riddle_match.request_room_hint($1::uuid,$2::integer) as data",
    args: (b) => { exactKeys(b, ["p_room_id", "p_round_number"]); return [uuid(b.p_room_id), round(b.p_round_number)]; },
  },
  end_expired_round: {
    sql: "select riddle_match.end_expired_round($1::uuid,$2::integer) as data",
    args: (b) => { exactKeys(b, ["p_room_id", "p_round_number"]); return [uuid(b.p_room_id), round(b.p_round_number)]; },
  },
  start_next_round: {
    sql: "select riddle_match.start_next_round($1::uuid,$2::integer) as data",
    args: (b) => { exactKeys(b, ["p_room_id", "p_round_number"]); return [uuid(b.p_room_id), round(b.p_round_number)]; },
  },
  leave_room: {
    sql: "select riddle_match.leave_room($1::uuid) as data",
    args: (b) => { exactKeys(b, ["p_room_id"]); return [uuid(b.p_room_id)]; },
  },
  block_opponent: {
    sql: "select riddle_match.block_opponent($1::uuid) as data",
    args: (b) => { exactKeys(b, ["p_room_id"]); return [uuid(b.p_room_id)]; },
  },
};

async function jsonBody(request, timeoutMs) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") || "")) invalid();
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail(413, "body_too_large", "內容太長。");
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  let onAbort;
  let interruption;
  const interrupted = new Promise((_, reject) => {
    const cancel = () => {
      interruption = new ApiError(408, "body_timeout", "讀取內容逾時，請重新送出。");
      reject(interruption);
      try { reader.cancel().catch(() => {}); } catch { /* Stream is already closed. */ }
    };
    onAbort = cancel;
    timer = setTimeout(cancel, timeoutMs);
    if (request.signal.aborted) cancel();
    else request.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (interruption) throw interruption;
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        fail(413, "body_too_large", "內容太長。");
      }
      chunks.push(value);
    }
  } catch (error) {
    throw interruption || error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { invalid(); }
}

function response(status, body, origin, extra = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: "Origin",
    ...extra,
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

function tokenHash(request) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") || "");
  if (!match || !TOKEN_PATTERN.test(match[1])) fail(401, "invalid_session", "連線已過期，請重新配對。");
  return createHash("sha256").update(match[1]).digest("hex");
}

async function readSession(queryable, hash) {
  const result = await queryable.query(
    "select player_id, expires_at from riddle_match.player_sessions where token_hash = $1 and expires_at > clock_timestamp()",
    [hash],
  );
  if (!result.rows.length) fail(401, "invalid_session", "連線已過期，請重新配對。");
  return result.rows[0];
}

async function limit(queryable, bucket, maximum) {
  const result = await queryable.query(`
    insert into riddle_match.api_rate_limits as limits (bucket, window_started_at, hits)
    values ($1, clock_timestamp(), 1)
    on conflict (bucket) do update
    set window_started_at = case when limits.window_started_at <= clock_timestamp() - interval '1 minute'
          then clock_timestamp() else limits.window_started_at end,
        hits = case when limits.window_started_at <= clock_timestamp() - interval '1 minute'
          then 1 else limits.hits + 1 end
    where limits.window_started_at <= clock_timestamp() - interval '1 minute' or limits.hits < $2
    returning hits`, [bucket, maximum]);
  if (!result.rows.length) fail(429, "rate_limited", "請稍候再試。");
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const data = await fn(client);
    await client.query("commit");
    return data;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* preserve the original error */ }
    throw error;
  } finally { client.release(); }
}

function mapError(error) {
  if (error instanceof ApiError) return error;
  if (error?.message === "round_changed") return new ApiError(409, "round_changed", "回合已更新，請重新同步。");
  if (error?.message === "hint_already_used") return new ApiError(409, "hint_already_used", "這一輪的提示已使用。");
  if (error?.message === "message_rate_limited") return new ApiError(429, "message_rate_limited", "訊息傳送太快，請稍候再試。");
  if (error?.message === "message_limit_reached") return new ApiError(409, "message_limit_reached", "本輪訊息數已達上限。");
  if (error?.code === "42501") return new ApiError(403, "forbidden", "無法執行這個操作。");
  if (error?.code === "22023" || error?.code === "23514") return new ApiError(400, "invalid_request", "請確認送出的資料。");
  if (error?.code === "55000" || error?.code === "23505" || error?.code === "P0001") return new ApiError(409, "state_conflict", "狀態已改變，請重新同步。");
  // Never include SQL, connection details, tokens, or raw database errors in responses or logs.
  console.error("Neon API request failed", /^[A-Z0-9]{5}$/.test(error?.code || "") ? error.code : "unexpected");
  return new ApiError(500, "internal_error", "服務暫時無法使用，請稍後再試。");
}

export function createHandler({ pool, origins = DEFAULT_ORIGIN, background = () => {}, cleanupSample = () => randomInt(32) === 0, bodyTimeoutMs = BODY_TIMEOUT_MS }) {
  const allowed = new Set(origins.split(",").map((origin) => origin.trim()).filter(Boolean));
  return async (request) => {
    const requestedOrigin = request.headers.get("origin");
    const origin = requestedOrigin && allowed.has(requestedOrigin) ? requestedOrigin : null;
    try {
      if (!origin) fail(403, "forbidden_origin", "此來源無法使用服務。");
      if (request.method === "OPTIONS") {
        if (!origin) fail(403, "forbidden_origin", "此來源無法使用服務。");
        return new Response(null, { status: 204, headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-max-age": "600", vary: "Origin",
        } });
      }
      const pathname = new URL(request.url).pathname;
      if (pathname === "/session" && request.method === "POST") {
        exactKeys(await jsonBody(request, bodyTimeoutMs), []);
        // This shared creation budget limits abuse even without trusting spoofable IP headers.
        await limit(pool, "session-create", 30);
        const token = randomBytes(32).toString("base64url");
        const hash = createHash("sha256").update(token).digest("hex");
        const session = await transaction(pool, async (client) => {
          const player = await client.query("insert into riddle_match.players default values returning id");
          const result = await client.query(
            "insert into riddle_match.player_sessions (token_hash, player_id, expires_at) values ($1, $2, clock_timestamp() + interval '24 hours') returning expires_at",
            [hash, player.rows[0].id],
          );
          return { user_id: player.rows[0].id, expires_at: result.rows[0].expires_at };
        });
        if (cleanupSample()) {
          // Neon waitUntil tracks this promise after the response is sent. Cleanup is
          // opportunistic; failures cannot invalidate an already-created session.
          try {
            background(pool.query("select riddle_match.cleanup_expired_data()")
              .catch(() => console.error("Neon API cleanup failed")));
          } catch { console.error("Neon API cleanup scheduling failed"); }
        }
        return response(201, { token, ...session }, origin);
      }
      const hash = tokenHash(request);
      const session = await readSession(pool, hash);
      // Invalid tokens and a single over-limit player must not exhaust the shared
      // budget of active players. The initial lookup still needs trusted edge limits.
      await limit(pool, `player:${session.player_id}`, 150);
      await limit(pool, "api-requests", 3000);
      if (pathname === "/session" && request.method === "GET") {
        return response(200, { user_id: session.player_id, expires_at: session.expires_at }, origin);
      }
      const match = /^\/rpc\/([a-z_]+)$/.exec(pathname);
      const method = match && Object.hasOwn(rpc, match[1]) ? rpc[match[1]] : null;
      if (!method || request.method !== "POST") fail(404, "not_found", "找不到這個操作。");
      const args = method.args(await jsonBody(request, bodyTimeoutMs));
      const data = await transaction(pool, async (client) => {
        const current = await readSession(client, hash);
        await client.query("select set_config('riddle_match.player_id', $1, true)", [current.player_id]);
        const result = await client.query(method.sql, args);
        return result.rows[0]?.data ?? null;
      });
      return response(200, { data }, origin);
    } catch (error) {
      const mapped = mapError(error);
      return response(mapped.status, { error: { code: mapped.code, message: mapped.message } }, origin,
        mapped.status === 429 ? { "retry-after": mapped.code === "message_rate_limited" ? "1" : "60" } : {});
    }
  };
}
