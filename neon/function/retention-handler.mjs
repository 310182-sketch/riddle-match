const MAX_TRIGGER_BYTES = 65536;
const MAX_BATCHES = 10;
const TRIGGER_NAME = "riddle-match-retention";
const INVOCATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const COUNTERS = ["abandoned", "rooms_deleted", "sessions_deleted", "rate_buckets_deleted"];

function response(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function readEnvelope(request) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_TRIGGER_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_TRIGGER_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return null; }
}

// SECURITY BOUNDARY: Neon Functions strips client-supplied X-Neon-* headers
// at its public edge. This handler must not be exposed outside that edge unless
// another authenticated gateway performs the same check. IDs are not secrets.
export function createRetentionHandler({ pool, logger = console }) {
  return async (request) => {
    if (new URL(request.url).pathname !== "/") return response(404, { error: "not_found" });
    if (request.method !== "POST") return response(405, { error: "method_not_allowed" }, { allow: "POST" });
    const invocation = request.headers.get("x-neon-trigger-invocation-id");
    if (!invocation || !INVOCATION_ID.test(invocation)) return response(401, { error: "trigger_required" });

    let body;
    try { body = await readEnvelope(request); } catch { body = null; }
    const scheduled = body?.data?.scheduled_at;
    if (body?.version !== 1 || body.invocation_id !== invocation || body.trigger?.type !== "schedule"
      || body.trigger?.name !== TRIGGER_NAME || typeof scheduled !== "string"
      || !UTC_TIMESTAMP.test(scheduled) || Number.isNaN(Date.parse(scheduled))) {
      logger.error("retention_trigger_invalid", { invocation_id: invocation });
      return response(400, { error: "invalid_trigger" });
    }

    const totals = Object.fromEntries(COUNTERS.map((name) => [name, 0]));
    let completed = 0;
    try {
      if (!pool) throw new Error("database_unavailable");
      // Each invocation is bounded. Repeated delivery is safe: the database
      // function only removes already-expired data and locks active rooms.
      for (; completed < MAX_BATCHES; completed++) {
        const result = await pool.query("select riddle_match.cleanup_expired_data() as data");
        const counts = result.rows[0]?.data;
        for (const name of COUNTERS) {
          if (!Number.isSafeInteger(counts?.[name]) || counts[name] < 0) throw new Error("invalid_cleanup_result");
          totals[name] += counts[name];
        }
      }
      logger.log("retention_cleanup_completed", { invocation_id: invocation, scheduled_at: scheduled, batches: completed, ...totals });
      return response(200, { ok: true, batches: completed });
    } catch (error) {
      // Do not expose or log connection strings, SQL errors, tokens, or data.
      const sqlstate = /^[0-9A-Z]{5}$/.test(error?.code || "") ? error.code : "unexpected";
      logger.error("retention_cleanup_failed", { invocation_id: invocation, scheduled_at: scheduled, completed_batches: completed, code: sqlstate });
      // Neon retries 503 and honors Retry-After. Earlier batches are safe to rerun.
      return response(503, { error: "cleanup_failed" }, { "retry-after": "60" });
    }
  };
}
