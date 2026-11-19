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
  blocked: "00000000-0000-4000-8000-000000000104",
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

async function insertHistoryMatch(
  db: PGlite,
  userId: string,
  opponentId: string,
  nickname: string,
  ageDays: number,
  commonAnswers: number,
) {
  const result = await db.query<{ id: string }>(
    `
    insert into public.player_match_history (
      room_id, user_id, opponent_user_id, opponent_nickname,
      topic_key, completed_at, question_count, common_answer_count
    ) values (
      gen_random_uuid(), $1, $2, $3, 'travel',
      clock_timestamp() - ($4::integer * interval '1 day'), 5, $5
    ) returning id
  `,
    [userId, opponentId, nickname, ageDays, commonAnswers],
  );
  return result.rows[0].id;
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
      security_definer_count: number;
      security_definer_without_fixed_search_path: number;
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
        (
          select count(*)::integer
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private')
            and p.prosecdef
        ) as security_definer_count,
        (
          select count(*)::integer
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private')
            and p.prosecdef
            and not ('search_path=""' = any(coalesce(p.proconfig, array[]::text[])))
        ) as security_definer_without_fixed_search_path,
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
    assert(
      row.security_definer_count > 0,
      "security-definer functions are installed",
    );
    assertEquals(
      row.security_definer_without_fixed_search_path,
      0,
      "all application security-definer functions pin an empty search path",
    );
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

Deno.test("random matchmaking respects topics, block lists, and cancellation", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    await db.query(
      "insert into public.player_blocks (blocker_user_id, blocked_user_id, blocked_nickname) values ($1, $2, $3)",
      [users.guest, users.blocked, "Blocked"],
    );

    const hostTicket = await rpc(
      db,
      users.host,
      "select public.queue_for_match($1, $2) as response",
      ["travel", "Host"],
    );
    const guestTicket = await rpc(
      db,
      users.guest,
      "select public.queue_for_match($1, $2) as response",
      ["music", "Guest"],
    );
    assertEquals(hostTicket.status, "waiting", "first player waits");
    assertEquals(
      guestTicket.status,
      "waiting",
      "different selected topics do not match",
    );

    const randomMatch = await rpc(
      db,
      users.outsider,
      "select public.queue_for_match($1, $2) as response",
      ["random", "Random"],
    );
    assertEquals(randomMatch.status, "matched", "random player is matched");
    assertEquals(randomMatch.topic_key, "travel", "selected topic is retained");
    assertEquals(
      randomMatch.opponent_nickname,
      "Host",
      "oldest compatible player is selected",
    );

    const hostStatus = await rpc(
      db,
      users.host,
      "select public.get_match_status($1::uuid) as response",
      [hostTicket.ticket_id],
    );
    assertEquals(hostStatus.status, "matched", "host ticket is matched");
    assertEquals(hostStatus.room_id, randomMatch.room_id, "shared room id");

    const blockedQueue = await rpc(
      db,
      users.blocked,
      "select public.queue_for_match($1, $2) as response",
      ["music", "Blocked"],
    );
    assertEquals(
      blockedQueue.status,
      "waiting",
      "mutually blocked players do not match",
    );
    const guestStatus = await rpc(
      db,
      users.guest,
      "select public.get_match_status($1::uuid) as response",
      [guestTicket.ticket_id],
    );
    assertEquals(
      guestStatus.status,
      "waiting",
      "blocked candidate keeps waiting",
    );

    const cancelled = await rpc(
      db,
      users.blocked,
      "select public.cancel_matchmaking($1::uuid) as response",
      [blockedQueue.ticket_id],
    );
    assertEquals(cancelled.status, "cancelled", "waiting ticket is cancelled");
  } finally {
    await db.close();
  }
});

Deno.test("history cursor and commonality ranking enforce their time and match limits", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    await insertHistoryMatch(db, users.host, users.guest, "Guest oldest", 3, 5);
    await insertHistoryMatch(db, users.host, users.guest, "Guest middle", 2, 0);

    const beforeThreshold = await rpc(
      db,
      users.host,
      "select public.get_my_commonality_ranking() as response",
    );
    assertEquals(
      (beforeThreshold.players as unknown[]).length,
      0,
      "two matches do not meet the ranking threshold",
    );

    await insertHistoryMatch(db, users.host, users.guest, "Guest newest", 1, 4);
    await insertHistoryMatch(
      db,
      users.host,
      users.outsider,
      "Other recent 1",
      4,
      5,
    );
    await insertHistoryMatch(
      db,
      users.host,
      users.outsider,
      "Other recent 2",
      5,
      5,
    );
    await insertHistoryMatch(db, users.host, users.guest, "Expired", 100, 5);

    const ranking = await rpc(
      db,
      users.host,
      "select public.get_my_commonality_ranking() as response",
    );
    const rankedPlayers = ranking.players as JsonObject[];
    assertEquals(
      rankedPlayers.length,
      1,
      "only the three-match opponent ranks",
    );
    assertEquals(
      rankedPlayers[0].opponent_nickname,
      "Guest newest",
      "ranking uses the latest opponent nickname",
    );
    assertEquals(rankedPlayers[0].match_count, 3, "ranking match count");
    assertEquals(
      rankedPlayers[0].common_answer_count,
      9,
      "ranking shared answers",
    );
    assertEquals(rankedPlayers[0].question_count, 15, "ranking answer total");
    assertEquals(
      Number(rankedPlayers[0].commonality_ratio),
      0.6,
      "ranking commonality ratio",
    );

    const firstPage = await rpc(
      db,
      users.host,
      "select public.get_my_match_history($1::integer, $2::timestamptz, $3::uuid) as response",
      [2, null, null],
    );
    const firstItems = firstPage.items as JsonObject[];
    assertEquals(firstItems.length, 2, "first history page size");
    assertEquals(
      firstItems[0].opponent_nickname,
      "Guest newest",
      "history is newest first",
    );

    const secondPage = await rpc(
      db,
      users.host,
      "select public.get_my_match_history($1::integer, $2::timestamptz, $3::uuid) as response",
      [2, firstItems[1].completed_at, firstItems[1].id],
    );
    const secondItems = secondPage.items as JsonObject[];
    assertEquals(secondItems.length, 2, "second history page size");
    assert(
      !firstItems.some((item) => item.id === secondItems[0].id),
      "history cursor does not repeat the boundary row",
    );

    const allRecent = await rpc(
      db,
      users.host,
      "select public.get_my_match_history($1::integer, $2::timestamptz, $3::uuid) as response",
      [50, null, null],
    );
    const recentItems = allRecent.items as JsonObject[];
    assertEquals(
      recentItems.length,
      5,
      "history excludes records older than 90 days",
    );
    assert(
      recentItems.every((item) => item.opponent_nickname !== "Expired"),
      "expired history is not returned",
    );
  } finally {
    await db.close();
  }
});

Deno.test("history RPCs only expose and delete the authenticated player's records", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    const hostHistoryId = await insertHistoryMatch(
      db,
      users.host,
      users.guest,
      "Guest",
      1,
      4,
    );
    const guestHistoryId = await insertHistoryMatch(
      db,
      users.guest,
      users.host,
      "Host",
      1,
      4,
    );

    const hostHistory = await rpc(
      db,
      users.host,
      "select public.get_my_match_history() as response",
    );
    const hostItems = hostHistory.items as JsonObject[];
    assertEquals(hostItems.length, 1, "host receives only one personal record");
    assertEquals(
      hostItems[0].id,
      hostHistoryId,
      "host receives own history row",
    );

    const unauthorizedDelete = await withUser(
      db,
      users.host,
      async () => {
        const result = await db.query<{ response: boolean }>(
          "select public.delete_my_match_history($1::uuid) as response",
          [guestHistoryId],
        );
        return result.rows[0].response;
      },
    );
    assertEquals(
      unauthorizedDelete,
      false,
      "host cannot delete the guest's history row",
    );

    const stillPresent = await rpc(
      db,
      users.guest,
      "select public.get_my_match_history() as response",
    );
    const guestItems = stillPresent.items as JsonObject[];
    assertEquals(
      guestItems.length,
      1,
      "guest's history remains after rejected delete",
    );
    assertEquals(guestItems[0].id, guestHistoryId, "guest retains own row");

    const ownDelete = await withUser(db, users.host, async () => {
      const result = await db.query<{ response: boolean }>(
        "select public.delete_my_match_history($1::uuid) as response",
        [hostHistoryId],
      );
      return result.rows[0].response;
    });
    assertEquals(ownDelete, true, "host can delete own history row");

    const repeatedDelete = await withUser(db, users.host, async () => {
      const result = await db.query<{ response: boolean }>(
        "select public.delete_my_match_history($1::uuid) as response",
        [hostHistoryId],
      );
      return result.rows[0].response;
    });
    assertEquals(
      repeatedDelete,
      false,
      "deleting the same row twice is harmless",
    );

    await assertRejects(
      () =>
        withUser(db, "", async () => {
          await db.query("select public.get_my_match_history() as response");
        }),
      "Authentication required",
    );
  } finally {
    await db.close();
  }
});

Deno.test("retention jobs purge expired data and keep unexpired records", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    const oldHistoryId = await insertHistoryMatch(
      db,
      users.host,
      users.guest,
      "Old history",
      91,
      3,
    );
    const recentHistoryId = await insertHistoryMatch(
      db,
      users.host,
      users.guest,
      "Recent history",
      2,
      4,
    );
    const rawRoom = await db.query<{ id: string }>(
      `
      insert into public.game_rooms (
        topic_key, status, created_by, closed_at, delete_after
      ) values (
        'travel', 'completed', $1, clock_timestamp(),
        clock_timestamp() - interval '25 hours'
      ) returning id
    `,
      [users.host],
    );
    const rawQueue = await db.query<{ id: string }>(
      `
      insert into public.matchmaking_queue (
        user_id, topic_choice, nickname, status, room_id, delete_after
      ) values (
        $1, 'travel', 'Guest', 'cancelled', $2,
        clock_timestamp() - interval '25 hours'
      ) returning id
    `,
      [users.guest, rawRoom.rows[0].id],
    );
    const timedOutQueue = await db.query<{ id: string }>(
      `
      insert into public.matchmaking_queue (
        user_id, topic_choice, nickname, status, expires_at, delete_after
      ) values (
        $1, 'daily', 'Blocked', 'waiting',
        clock_timestamp() - interval '31 seconds',
        clock_timestamp() - interval '25 hours'
      ) returning id
    `,
      [users.blocked],
    );
    await db.query(`
      insert into public.player_safety_reports (
        room_id, category, details, created_at
      ) values
        (gen_random_uuid(), 'other', 'Expired report', clock_timestamp() - interval '181 days'),
        (gen_random_uuid(), 'other', 'Recent report', clock_timestamp() - interval '1 day')
    `);

    await db.query("select private.purge_expired_game_data()");
    const timedOut = await db.query<{ status: string; delete_after: Date }>(
      "select status, delete_after from public.matchmaking_queue where id = $1",
      [timedOutQueue.rows[0].id],
    );
    assertEquals(timedOut.rows[0].status, "timed_out", "expired ticket status");
    const queueCount = await db.query<{ count: number }>(
      "select count(*)::integer as count from public.matchmaking_queue where id = $1",
      [rawQueue.rows[0].id],
    );
    assertEquals(queueCount.rows[0].count, 0, "raw queue data is purged");
    const roomCount = await db.query<{ count: number }>(
      "select count(*)::integer as count from public.game_rooms where id = $1",
      [rawRoom.rows[0].id],
    );
    assertEquals(roomCount.rows[0].count, 0, "raw room data is purged");
    const oldHistoryCount = await db.query<{ count: number }>(
      "select count(*)::integer as count from public.player_match_history where id = $1",
      [oldHistoryId],
    );
    const recentHistoryCount = await db.query<{ count: number }>(
      "select count(*)::integer as count from public.player_match_history where id = $1",
      [recentHistoryId],
    );
    assertEquals(oldHistoryCount.rows[0].count, 0, "90-day history is purged");
    assertEquals(
      recentHistoryCount.rows[0].count,
      1,
      "recent history is retained",
    );

    await db.query("select private.purge_expired_moderation_reports()");
    const reports = await db.query<{ details: string }>(
      "select details from public.player_safety_reports order by details",
    );
    assertEquals(reports.rows.length, 1, "expired moderation report is purged");
    assertEquals(
      reports.rows[0].details,
      "Recent report",
      "recent report is retained",
    );
  } finally {
    await db.close();
  }
});

Deno.test("matchmaking and invite room rate limits enforce their thresholds", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    for (let ticket = 0; ticket < 12; ticket += 1) {
      await db.query(
        `
        insert into public.matchmaking_queue (
          user_id, topic_choice, nickname, status
        ) values ($1, 'travel', 'Host', 'cancelled')
      `,
        [users.host],
      );
    }
    await assertRejects(
      () =>
        db.query(
          `
        insert into public.matchmaking_queue (
          user_id, topic_choice, nickname, status
        ) values ($1, 'travel', 'Host', 'cancelled')
      `,
          [users.host],
        ),
      "Matchmaking rate limit reached",
    );

    for (let room = 0; room < 6; room += 1) {
      await db.query(
        "insert into public.game_rooms (topic_key, status, created_by) values ('daily', 'waiting', $1)",
        [users.guest],
      );
    }
    await assertRejects(
      () =>
        db.query(
          "insert into public.game_rooms (topic_key, status, created_by) values ('daily', 'waiting', $1)",
          [users.guest],
        ),
      "Invite room rate limit reached",
    );
  } finally {
    await db.close();
  }
});

Deno.test("account deletion closes rooms and clears private history identities", async () => {
  const db = await createDatabase();
  try {
    await insertUsers(db);
    const { roomId, inviteCode } = await createPlayingRoom(db);
    const hostHistoryId = await insertHistoryMatch(
      db,
      users.host,
      users.guest,
      "Guest snapshot",
      1,
      4,
    );
    const guestHistoryId = await insertHistoryMatch(
      db,
      users.guest,
      users.host,
      "Host snapshot",
      1,
      4,
    );
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

    const deletedPlayerHistory = await db.query<{ count: number }>(
      "select count(*)::integer as count from public.player_match_history where id = $1",
      [hostHistoryId],
    );
    assertEquals(
      deletedPlayerHistory.rows[0].count,
      0,
      "deleted player's own history is removed",
    );
    const retainedOpponentHistory = await db.query<{
      opponent_user_id: string | null;
      opponent_nickname: string;
    }>(
      "select opponent_user_id, opponent_nickname from public.player_match_history where id = $1",
      [guestHistoryId],
    );
    assertEquals(
      retainedOpponentHistory.rows[0].opponent_user_id,
      null,
      "remaining player's history no longer links the deleted account",
    );
    assertEquals(
      retainedOpponentHistory.rows[0].opponent_nickname,
      "已刪除玩家",
      "remaining player's history uses the deletion label",
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
