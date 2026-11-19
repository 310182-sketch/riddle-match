import pg from "npm:pg@8.13.3";

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL concurrency test",
  );
}
const databaseHost = new URL(databaseUrl).hostname;
if (!new Set(["localhost", "127.0.0.1", "::1"]).has(databaseHost)) {
  throw new Error(
    "The PostgreSQL concurrency test only runs against a loopback database",
  );
}

const users = {
  host: "00000000-0000-4000-8000-000000000201",
  guest: "00000000-0000-4000-8000-000000000202",
};

async function connect(applicationName: string) {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

async function applyMigrations(admin: PgClient) {
  await admin.query(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid()
      returns uuid
      language sql
      stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);

  const filenames: string[] = [];
  for await (
    const entry of Deno.readDir(new URL("../migrations/", import.meta.url))
  ) {
    if (entry.isFile && entry.name.endsWith(".sql")) filenames.push(entry.name);
  }
  filenames.sort();
  assert(filenames.length > 0, "at least one SQL migration must exist");

  for (const filename of filenames) {
    const path = new URL(`../migrations/${filename}`, import.meta.url);
    await admin.query(await Deno.readTextFile(path));
  }
}

async function setAuthenticatedUser(client: PgClient, userId: string) {
  await client.query("begin");
  await client.query("set local role authenticated");
  await client.query(
    "select set_config('request.jwt.claim.sub', $1, true)",
    [userId],
  );
}

Deno.test("a concurrent matchmaking RPC waits for an in-flight block write", async () => {
  const admin = await connect("block-race-admin");
  let blocker: PgClient | null = null;
  let matcher: PgClient | null = null;
  let blockerTransactionOpen = false;
  let matcherTransactionOpen = false;
  let matchmakingPromise: ReturnType<PgClient["query"]> | null = null;

  try {
    await applyMigrations(admin);
    await admin.query("insert into auth.users (id) values ($1), ($2)", [
      users.host,
      users.guest,
    ]);

    const roomResult = await admin.query<{ id: string }>(
      `
      insert into public.game_rooms (topic_key, status, created_by)
      values ('travel', 'completed', $1)
      returning id
    `,
      [users.host],
    );
    const roomId = roomResult.rows[0].id;
    await admin.query(
      `
      insert into public.room_members (room_id, user_id, nickname)
      values ($1, $2, 'Host'), ($1, $3, 'Guest')
    `,
      [roomId, users.host, users.guest],
    );
    await admin.query(
      `
      insert into public.matchmaking_queue (user_id, topic_choice, nickname)
      values ($1, 'travel', 'Host')
    `,
      [users.host],
    );

    blocker = await connect("block-race-blocker");
    matcher = await connect("block-race-matcher");

    await setAuthenticatedUser(blocker, users.guest);
    blockerTransactionOpen = true;
    const blockResult = await blocker.query<{ response: { status: string } }>(
      "select public.block_room_opponent($1::uuid) as response",
      [roomId],
    );
    assertEquals(blockResult.rows[0].response.status, "blocked", "block RPC");

    await setAuthenticatedUser(matcher, users.guest);
    matcherTransactionOpen = true;
    let matchmakingFinished = false;
    matchmakingPromise = matcher.query(
      "select public.queue_for_match($1, $2) as response",
      ["travel", "Guest"],
    ).finally(() => {
      matchmakingFinished = true;
    });

    let waitingForAdvisoryLock = false;
    const deadline = Date.now() + 10000;
    while (
      !waitingForAdvisoryLock && !matchmakingFinished && Date.now() < deadline
    ) {
      const activity = await admin.query<{
        wait_event_type: string | null;
        wait_event: string | null;
      }>(`
        select wait_event_type, wait_event
        from pg_stat_activity
        where application_name = 'block-race-matcher'
          and state = 'active'
      `);
      waitingForAdvisoryLock = activity.rows.some((row: {
        wait_event_type: string | null;
        wait_event: string | null;
      }) => row.wait_event_type === "Lock" && row.wait_event === "advisory");
      if (!waitingForAdvisoryLock && !matchmakingFinished) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert(
      waitingForAdvisoryLock,
      "matchmaking RPC must wait on the block transaction's advisory lock",
    );

    await blocker.query("commit");
    blockerTransactionOpen = false;
    const matchmakingResult = await matchmakingPromise;
    await matcher.query("commit");
    matcherTransactionOpen = false;
    assertEquals(
      matchmakingResult.rows[0].response.status,
      "waiting",
      "a blocked player is not matched after the block commits",
    );
  } finally {
    if (blockerTransactionOpen && blocker) {
      await blocker.query("rollback").catch(() => undefined);
    }
    if (matchmakingPromise) {
      await matchmakingPromise.catch(() => undefined);
    }
    if (matcherTransactionOpen && matcher) {
      await matcher.query("rollback").catch(() => undefined);
    }
    await Promise.all([
      blocker?.end(),
      matcher?.end(),
      admin.end(),
    ]);
  }
});
