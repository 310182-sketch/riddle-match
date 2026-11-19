import { PGlite } from "npm:@electric-sql/pglite@0.3.14";

const migrationFiles = [
  "20261119000100_realtime_commonality_game.sql",
  "20261120000100_invite_rooms_and_player_history.sql",
  "20261120000200_safety_and_abuse_controls.sql",
  "20261120000300_close_rooms_on_account_deletion.sql",
  "20261120000400_anonymize_safety_reports_on_account_deletion.sql",
];

const users = {
  host: "00000000-0000-4000-8000-000000000101",
  guest: "00000000-0000-4000-8000-000000000102",
  outsider: "00000000-0000-4000-8000-000000000103",
};

type JsonObject = Record<string, unknown>;

async function createDatabase() {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
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

  for (const filename of migrationFiles) {
    const path = new URL(`../migrations/${filename}`, import.meta.url);
    await db.exec(await Deno.readTextFile(path));
  }

  return db;
}

async function withUser<T>(
  db: PGlite,
  userId: string,
  callback: () => Promise<T>,
): Promise<T> {
  await db.exec("reset role");
  await db.query(
    "select set_config('request.jwt.claim.sub', $1, false)",
    [userId],
  );
  await db.exec("set role authenticated");
  try {
    return await callback();
  } finally {
    await db.exec("reset role");
  }
}

async function rpc(
  db: PGlite,
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<JsonObject> {
  return await withUser(db, userId, async () => {
    const result = await db.query<{ response: JsonObject }>(sql, params);
    return result.rows[0].response;
  });
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(
  action: () => Promise<unknown>,
  messagePart: string,
) {
  try {
    await action();
  } catch (error) {
    if (String(error).includes(messagePart)) return;
    throw new Error(
      `Expected error containing "${messagePart}", got: ${error}`,
    );
  }
  throw new Error(`Expected error containing "${messagePart}"`);
}

async function insertUsers(db: PGlite, ids = Object.values(users)) {
  for (const id of ids) {
    await db.query("insert into auth.users (id) values ($1)", [id]);
  }
}

async function createPlayingRoom(db: PGlite) {
  const created = await rpc(
    db,
    users.host,
    "select public.create_invite_room($1, $2) as response",
    ["travel", "Host"],
  );
  assertEquals(created.status, "waiting", "invite room status");
  const joined = await rpc(
    db,
    users.guest,
    "select public.join_invite_room($1, $2) as response",
    [created.invite_code, "Guest"],
  );
  assertEquals(joined.status, "joined", "join room status");
  assertEquals(joined.room_id, created.room_id, "joined room id");
  return {
    roomId: String(created.room_id),
    inviteCode: String(created.invite_code),
  };
}

Deno.test("Supabase migrations apply in order and protect private tables", async () => {
  const db = await createDatabase();
  try {
    const result = await db.query<{
      rooms: string | null;
      history: string | null;
      reports: string | null;
      room_rls: boolean;
      history_rls: boolean;
      report_rls: boolean;
      answer_read: boolean;
      report_read: boolean;
      history_read: boolean;
      history_rpc: string | null;
      delete_trigger: string | null;
    }>(`
      select
        to_regclass('public.game_rooms')::text as rooms,
        to_regclass('public.player_match_history')::text as history,
        to_regclass('public.player_safety_reports')::text as reports,
        (select relrowsecurity from pg_class where oid = 'public.game_rooms'::regclass) as room_rls,
        (select relrowsecurity from pg_class where oid = 'public.player_match_history'::regclass) as history_rls,
        (select relrowsecurity from pg_class where oid = 'public.player_safety_reports'::regclass) as report_rls,
        has_table_privilege('authenticated', 'public.game_answers', 'select') as answer_read,
        has_table_privilege('authenticated', 'public.player_safety_reports', 'select') as report_read,
        has_table_privilege('authenticated', 'public.player_match_history', 'select') as history_read,
        to_regprocedure('public.get_my_match_history(integer,timestamp with time zone,uuid)')::text as history_rpc,
        (select tgname from pg_trigger where tgname = 'auth_users_close_rooms_before_delete') as delete_trigger
    `);
    const row = result.rows[0];
    assertEquals(row.rooms, "game_rooms", "game room table");
    assertEquals(row.history, "player_match_history", "history table");
    assertEquals(row.reports, "player_safety_reports", "safety report table");
    assertEquals(row.room_rls, true, "room row level security");
    assertEquals(row.history_rls, true, "history row level security");
    assertEquals(row.report_rls, true, "report row level security");
    assertEquals(row.answer_read, false, "direct answer table access");
    assertEquals(row.report_read, false, "direct report table access");
    assertEquals(row.history_read, false, "direct history table access");
    assert(row.history_rpc, "history RPC is installed");
    assertEquals(
      row.delete_trigger,
      "auth_users_close_rooms_before_delete",
      "account deletion cleanup trigger",
    );
  } finally {
    await db.close();
  }
});

Deno.test("two players reveal answers together and receive private history", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    const { roomId } = await createPlayingRoom(db);

    for (let question = 1; question <= 5; question += 1) {
      const hostChoice = question % 2;
      const guestChoice = question === 3 ? 1 - hostChoice : hostChoice;
      const firstAnswer = await rpc(
        db,
        users.host,
        "select public.submit_answer($1::uuid, $2::smallint) as response",
        [roomId, hostChoice],
      );
      assertEquals(
        firstAnswer.reveal,
        false,
        "answer is hidden until both reply",
      );
      assertEquals(
        firstAnswer.your_choice,
        null,
        "private answer stays hidden",
      );
      assertEquals(
        firstAnswer.partner_choice,
        null,
        "partner answer stays hidden",
      );

      await assertRejects(
        () =>
          withUser(db, users.host, async () => {
            await db.query("select choice from public.game_answers");
          }),
        "permission denied",
      );

      const secondAnswer = await rpc(
        db,
        users.guest,
        "select public.submit_answer($1::uuid, $2::smallint) as response",
        [roomId, guestChoice],
      );
      assertEquals(
        secondAnswer.reveal,
        true,
        "answer reveals after both reply",
      );
      assertEquals(
        secondAnswer.your_choice,
        guestChoice,
        "guest sees own answer",
      );
      assertEquals(
        secondAnswer.partner_choice,
        hostChoice,
        "guest sees partner answer",
      );

      const hostReady = await rpc(
        db,
        users.host,
        "select public.continue_room($1::uuid) as response",
        [roomId],
      );
      assertEquals(
        hostReady.status,
        "waiting_for_partner",
        "first player waits",
      );
      const guestReady = await rpc(
        db,
        users.guest,
        "select public.continue_room($1::uuid) as response",
        [roomId],
      );
      assertEquals(
        guestReady.status,
        question === 5 ? "completed" : "advanced",
        "both players advance together",
      );
    }

    const results = await rpc(
      db,
      users.host,
      "select public.get_room_results($1::uuid) as response",
      [roomId],
    );
    assertEquals(results.match_count, 4, "shared answer count");
    assertEquals(
      (results.common_choices as unknown[]).length,
      4,
      "shared answers in results",
    );

    const history = await rpc(
      db,
      users.host,
      "select public.get_my_match_history() as response",
    );
    const items = history.items as JsonObject[];
    assertEquals(items.length, 1, "host history count");
    assertEquals(items[0].common_answer_count, 4, "saved history score");
    assertEquals(items[0].opponent_nickname, "Guest", "saved opponent name");

    const guestHistory = await rpc(
      db,
      users.guest,
      "select public.get_my_match_history() as response",
    );
    assertEquals(
      (guestHistory.items as JsonObject[]).length,
      1,
      "guest only receives own history",
    );

    await assertRejects(
      () =>
        rpc(
          db,
          users.outsider,
          "select public.get_room_state($1::uuid) as response",
          [roomId],
        ),
      "Room not found",
    );
  } finally {
    await db.close();
  }
});

Deno.test("reports are private, deduplicated, and unavailable outside the room", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    const { roomId } = await createPlayingRoom(db);

    const first = await rpc(
      db,
      users.host,
      "select public.submit_player_report($1::uuid, $2, $3) as response",
      [roomId, "other", "Repeated unwanted contact"],
    );
    const duplicate = await rpc(
      db,
      users.host,
      "select public.submit_player_report($1::uuid, $2, $3) as response",
      [roomId, "other", "Second report"],
    );
    assertEquals(first.status, "submitted", "first report status");
    assertEquals(
      duplicate.status,
      "already_submitted",
      "duplicate report status",
    );

    await assertRejects(
      () =>
        rpc(
          db,
          users.outsider,
          "select public.submit_player_report($1::uuid, $2, $3) as response",
          [roomId, "other", "Not a room member"],
        ),
      "Room not found",
    );
    await assertRejects(
      () =>
        withUser(db, users.host, async () => {
          await db.query("select * from public.player_safety_reports");
        }),
      "permission denied",
    );

    const blocked = await rpc(
      db,
      users.host,
      "select public.block_room_opponent($1::uuid) as response",
      [roomId],
    );
    assertEquals(blocked.status, "blocked", "block status");
    const blockedPlayers = await rpc(
      db,
      users.host,
      "select public.get_my_blocked_players() as response",
    );
    const players = blockedPlayers.players as JsonObject[];
    assertEquals(players.length, 1, "block list count");
    assertEquals(players[0].user_id, users.guest, "block list identity");

    await rpc(
      db,
      users.host,
      "select public.leave_room($1::uuid) as response",
      [roomId],
    );
    const guestRoom = await rpc(
      db,
      users.guest,
      "select public.create_invite_room($1, $2) as response",
      ["music", "Guest"],
    );
    await assertRejects(
      () =>
        rpc(
          db,
          users.host,
          "select public.join_invite_room($1, $2) as response",
          [guestRoom.invite_code, "Host"],
        ),
      "Room unavailable",
    );
    const roomMembers = await db.query<{ member_count: number }>(
      "select count(*)::integer as member_count from public.room_members where room_id = $1",
      [guestRoom.room_id],
    );
    assertEquals(
      roomMembers.rows[0].member_count,
      1,
      "blocked player not added",
    );
  } finally {
    await db.close();
  }
});

Deno.test("account deletion closes rooms and removes report identity", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    const { roomId, inviteCode } = await createPlayingRoom(db);
    await rpc(
      db,
      users.host,
      "select public.submit_player_report($1::uuid, $2, $3) as response",
      [roomId, "other", "Keep the report but remove account links"],
    );
    await rpc(
      db,
      users.guest,
      "select public.submit_player_report($1::uuid, $2, $3) as response",
      [roomId, "other", "Deleted account was the reported player"],
    );

    await db.query("delete from auth.users where id = $1", [users.host]);

    const room = await db.query<{ status: string; invite_code: string | null }>(
      "select status, invite_code from public.game_rooms where id = $1",
      [roomId],
    );
    assertEquals(room.rows[0].status, "abandoned", "room closed on deletion");
    assertEquals(room.rows[0].invite_code, null, "invite code cleared");
    assert(
      /^[0-9A-F]{12}$/.test(inviteCode),
      "the test began with a valid invite code",
    );

    const report = await db.query<{
      reporter_user_id: string | null;
      reported_user_id: string | null;
      details: string;
    }>(
      "select reporter_user_id, reported_user_id, details from public.player_safety_reports where room_id = $1 order by details",
      [roomId],
    );
    assertEquals(report.rows.length, 2, "reports retained until their expiry");
    for (const row of report.rows) {
      assertEquals(row.reporter_user_id, null, "reporter identity removed");
      assertEquals(row.reported_user_id, null, "reported identity removed");
    }
    assertEquals(
      report.rows[0].details,
      "Deleted account was the reported player",
      "report details retained when account was reported",
    );
    assertEquals(
      report.rows[1].details,
      "Keep the report but remove account links",
      "report details retained when account was reporter",
    );
  } finally {
    await db.close();
  }
});
