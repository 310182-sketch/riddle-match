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
  quota: "00000000-0000-4000-8000-000000000203",
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

async function waitForAdvisoryLock(
  admin: PgClient,
  applicationName: string,
  isRequestFinished: () => boolean,
) {
  let waitingForAdvisoryLock = false;
  const deadline = Date.now() + 10000;
  while (
    !waitingForAdvisoryLock && !isRequestFinished() && Date.now() < deadline
  ) {
    const activity = await admin.query<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      `
      select wait_event_type, wait_event
      from pg_stat_activity
      where application_name = $1
        and state = 'active'
    `,
      [applicationName],
    );
    waitingForAdvisoryLock = activity.rows.some((row: {
      wait_event_type: string | null;
      wait_event: string | null;
    }) => row.wait_event_type === "Lock" && row.wait_event === "advisory");
    if (!waitingForAdvisoryLock && !isRequestFinished()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert(
    waitingForAdvisoryLock,
    `${applicationName} must wait on the transaction advisory lock`,
  );
}

Deno.test("account limits and block writes serialize concurrent requests", async () => {
  const admin = await connect("block-race-admin");
  let blocker: PgClient | null = null;
  let matcher: PgClient | null = null;
  let quotaCreator: PgClient | null = null;
  let quotaWaiter: PgClient | null = null;
  let blockerTransactionOpen = false;
  let matcherTransactionOpen = false;
  let quotaCreatorTransactionOpen = false;
  let quotaWaiterTransactionOpen = false;
  let requestPromise: ReturnType<PgClient["query"]> | null = null;
  let quotaRequestPromise: ReturnType<PgClient["query"]> | null = null;

  try {
    await applyMigrations(admin);
    await admin.query(
      "insert into auth.users (id) values ($1), ($2), ($3)",
      [users.host, users.guest, users.quota],
    );

    for (let room = 0; room < 5; room += 1) {
      await admin.query(
        `
        insert into public.game_rooms (topic_key, status, created_by)
        values ('daily', 'completed', $1)
      `,
        [users.quota],
      );
    }

    quotaCreator = await connect("invite-quota-holder");
    quotaWaiter = await connect("invite-quota-waiter");
    await setAuthenticatedUser(quotaCreator, users.quota);
    quotaCreatorTransactionOpen = true;
    const createdRoom = await quotaCreator.query<{
      response: { status: string; room_id: string };
    }>("select public.create_invite_room($1, $2) as response", [
      "daily",
      "Quota",
    ]);
    assertEquals(
      createdRoom.rows[0].response.status,
      "waiting",
      "the sixth room within the quota is allowed",
    );
    const closedRoom = await quotaCreator.query<{
      response: { status: string };
    }>("select public.leave_room($1::uuid) as response", [
      createdRoom.rows[0].response.room_id,
    ]);
    assertEquals(
      closedRoom.rows[0].response.status,
      "abandoned",
      "the created room is closed before testing the next request",
    );

    await setAuthenticatedUser(quotaWaiter, users.quota);
    quotaWaiterTransactionOpen = true;
    let quotaRequestFinished = false;
    quotaRequestPromise = quotaWaiter.query(
      "select public.create_invite_room($1, $2) as response",
      ["daily", "Quota"],
    ).finally(() => {
      quotaRequestFinished = true;
    });
    let quotaError: unknown = null;
    const quotaRequestSettled = quotaRequestPromise.catch((error: unknown) => {
      quotaError = error;
    });
    await waitForAdvisoryLock(
      admin,
      "invite-quota-waiter",
      () => quotaRequestFinished,
    );

    await quotaCreator.query("commit");
    quotaCreatorTransactionOpen = false;
    await quotaRequestSettled;
    await quotaWaiter.query("rollback");
    quotaWaiterTransactionOpen = false;
    assert(
      quotaError instanceof Error &&
        quotaError.message.includes("Invite room rate limit reached"),
      "a concurrent invite request must not exceed the account room limit",
    );
    const quotaRoomCount = await admin.query<{ count: string }>(
      "select count(*)::text as count from public.game_rooms where created_by = $1",
      [users.quota],
    );
    assertEquals(
      quotaRoomCount.rows[0].count,
      "6",
      "the concurrent request does not create a seventh room",
    );

    await quotaCreator.end();
    await quotaWaiter.end();
    quotaCreator = null;
    quotaWaiter = null;

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
    requestPromise = matcher.query(
      "select public.queue_for_match($1, $2) as response",
      ["travel", "Guest"],
    ).finally(() => {
      matchmakingFinished = true;
    });

    await waitForAdvisoryLock(
      admin,
      "block-race-matcher",
      () => matchmakingFinished,
    );

    await blocker.query("commit");
    blockerTransactionOpen = false;
    const matchmakingResult = await requestPromise;
    await matcher.query("commit");
    matcherTransactionOpen = false;
    assertEquals(
      matchmakingResult.rows[0].response.status,
      "waiting",
      "a blocked player is not matched after the block commits",
    );

    await blocker.end();
    await matcher.end();
    blocker = null;
    matcher = null;
    blocker = await connect("block-race-invite-blocker");
    matcher = await connect("block-race-invite-matcher");
    await admin.query("delete from public.player_blocks");

    const inviteRoomResult = await admin.query<{ id: string }>(
      `
      insert into public.game_rooms (topic_key, status, created_by, invite_code)
      values ('travel', 'waiting', $1, 'ABCDEF123456')
      returning id
    `,
      [users.host],
    );
    const inviteRoomId = inviteRoomResult.rows[0].id;
    await admin.query(
      `insert into public.room_members (room_id, user_id, nickname)
       values ($1, $2, 'Host')`,
      [inviteRoomId, users.host],
    );

    await setAuthenticatedUser(blocker, users.guest);
    blockerTransactionOpen = true;
    const inviteBlockResult = await blocker.query<{
      response: { status: string };
    }>("select public.block_room_opponent($1::uuid) as response", [roomId]);
    assertEquals(
      inviteBlockResult.rows[0].response.status,
      "blocked",
      "invite block RPC",
    );

    await setAuthenticatedUser(matcher, users.guest);
    matcherTransactionOpen = true;
    let inviteJoinFinished = false;
    requestPromise = matcher.query(
      "select public.join_invite_room($1, $2) as response",
      ["ABCDEF123456", "Guest"],
    ).finally(() => {
      inviteJoinFinished = true;
    });

    await waitForAdvisoryLock(
      admin,
      "block-race-invite-matcher",
      () => inviteJoinFinished,
    );
    await blocker.query("commit");
    blockerTransactionOpen = false;

    let inviteJoinError: unknown = null;
    try {
      await requestPromise;
    } catch (error) {
      inviteJoinError = error;
    }
    await matcher.query("rollback");
    matcherTransactionOpen = false;
    assert(
      inviteJoinError instanceof Error &&
        inviteJoinError.message.includes("Room unavailable"),
      "an invite join must be rejected after the block commits",
    );
  } finally {
    if (quotaCreatorTransactionOpen && quotaCreator) {
      await quotaCreator.query("rollback").catch(() => undefined);
    }
    if (quotaWaiterTransactionOpen && quotaWaiter) {
      await quotaWaiter.query("rollback").catch(() => undefined);
    }
    if (blockerTransactionOpen && blocker) {
      await blocker.query("rollback").catch(() => undefined);
    }
    if (quotaRequestPromise) {
      await quotaRequestPromise.catch(() => undefined);
    }
    if (requestPromise) {
      await requestPromise.catch(() => undefined);
    }
    if (matcherTransactionOpen && matcher) {
      await matcher.query("rollback").catch(() => undefined);
    }
    await Promise.all([
      quotaCreator?.end(),
      quotaWaiter?.end(),
      blocker?.end(),
      matcher?.end(),
      admin.end(),
    ]);
  }
});
