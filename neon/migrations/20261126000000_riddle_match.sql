-- Private data layer for a trusted Neon-hosted API. No client has SQL access.
-- Apply only to the target branch after reviewing the contract in neon/README.md.
-- Fail if this namespace already exists; never overwrite another deployment.
create schema riddle_match;
revoke all on schema riddle_match from public;

create table if not exists riddle_match.players (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists riddle_match.player_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  player_id uuid not null references riddle_match.players (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists player_sessions_player_id_idx on riddle_match.player_sessions (player_id);
create index if not exists player_sessions_expires_at_idx on riddle_match.player_sessions (expires_at);

create table if not exists riddle_match.api_rate_limits (
  bucket text primary key check (char_length(bucket) between 1 and 128),
  window_started_at timestamptz not null,
  hits integer not null check (hits > 0)
);
create index if not exists api_rate_limits_window_idx on riddle_match.api_rate_limits (window_started_at);

-- This is trusted transaction context, NOT authentication. The API must verify
-- the bearer token's hash and expiry, then set it within the same transaction.
create or replace function riddle_match.current_player_id()
returns uuid language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('riddle_match.player_id', true), '')::uuid;
$$;

create table if not exists riddle_match.matchmaking_queue (
  user_id uuid primary key references riddle_match.players (id) on delete cascade,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 24),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default clock_timestamp()
);

create index if not exists matchmaking_queue_created_at_idx
  on riddle_match.matchmaking_queue (created_at, user_id);

create table if not exists riddle_match.match_rooms (
  id uuid primary key default gen_random_uuid(),
  player_one_id uuid not null references riddle_match.players (id) on delete cascade,
  player_two_id uuid not null references riddle_match.players (id) on delete cascade,
  player_one_nickname text not null check (char_length(btrim(player_one_nickname)) between 1 and 24),
  player_two_nickname text not null check (char_length(btrim(player_two_nickname)) between 1 and 24),
  setter_id uuid not null references riddle_match.players (id) on delete cascade,
  guesser_id uuid not null references riddle_match.players (id) on delete cascade,
  round_number integer not null default 1 check (round_number > 0),
  topic_number smallint not null check (topic_number between 1 and 12),
  topic text not null,
  riddle text,
  status text not null default 'waiting_setter'
    check (status in ('waiting_setter', 'active', 'solved', 'timed_out', 'abandoned')),
  hint_used boolean not null default false,
  expires_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint match_rooms_distinct_players check (player_one_id <> player_two_id),
  constraint match_rooms_roles_are_players check (
    (setter_id = player_one_id and guesser_id = player_two_id)
    or (setter_id = player_two_id and guesser_id = player_one_id)
  ),
  constraint match_rooms_active_has_deadline check (status <> 'active' or expires_at is not null)
);

create unique index if not exists match_rooms_one_open_room_per_player_one_idx
  on riddle_match.match_rooms (player_one_id)
  where status in ('waiting_setter', 'active');

create unique index if not exists match_rooms_one_open_room_per_player_two_idx
  on riddle_match.match_rooms (player_two_id)
  where status in ('waiting_setter', 'active');

create index if not exists match_rooms_player_one_status_idx
  on riddle_match.match_rooms (player_one_id, status, created_at desc);

create index if not exists match_rooms_player_two_status_idx
  on riddle_match.match_rooms (player_two_id, status, created_at desc);

create table if not exists riddle_match.room_presence (
  room_id uuid not null references riddle_match.match_rooms (id) on delete cascade,
  player_id uuid not null references riddle_match.players (id) on delete cascade,
  last_seen_at timestamptz not null default clock_timestamp(),
  primary key (room_id, player_id)
);

create table if not exists riddle_match.room_secrets (
  room_id uuid not null references riddle_match.match_rooms (id) on delete cascade,
  round_number integer not null check (round_number > 0),
  answer text not null check (char_length(btrim(answer)) between 1 and 80),
  hint text not null check (char_length(btrim(hint)) between 1 and 180),
  accepted_answers text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (room_id, round_number),
  check (cardinality(accepted_answers) <= 10)
);

create table if not exists riddle_match.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references riddle_match.match_rooms (id) on delete cascade,
  round_number integer not null check (round_number > 0),
  sender_id uuid not null references riddle_match.players (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 180),
  created_at timestamptz not null default now()
);

create index if not exists room_messages_room_round_created_idx
  on riddle_match.room_messages (room_id, round_number, created_at, id);


create or replace function riddle_match.normalize_riddle_answer(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select lower(regexp_replace(coalesce(p_value, ''), '[[:space:]，。！？、,.!?]', '', 'g'));
$$;

create or replace function riddle_match.guard_open_room_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
begin
  if new.status = 'abandoned' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'abandoned'
      and old.player_one_id = new.player_one_id
      and old.player_two_id = new.player_two_id then
      return new;
    end if;
  end if;
  perform pg_advisory_xact_lock(2109761245, 52644002);
  if exists (
    select 1 from riddle_match.match_rooms as room
    where room.id <> new.id and room.status <> 'abandoned'
      and (new.player_one_id in (room.player_one_id, room.player_two_id)
        or new.player_two_id in (room.player_one_id, room.player_two_id))
  ) then
    raise exception 'player_already_in_open_room' using errcode = '23505';
  end if;
  return new;
end;
$$;


alter table riddle_match.players enable row level security;
alter table riddle_match.player_sessions enable row level security;
alter table riddle_match.api_rate_limits enable row level security;
alter table riddle_match.matchmaking_queue enable row level security;
alter table riddle_match.match_rooms enable row level security;
alter table riddle_match.room_presence enable row level security;
alter table riddle_match.room_secrets enable row level security;
alter table riddle_match.room_messages enable row level security;

-- No client policies or grants: only the trusted API database role can access
-- this private schema. Ownership may bypass RLS; API routes must use the guarded
-- functions and never accept a player ID or arbitrary SQL from the browser.

drop trigger if exists guard_open_room_membership on riddle_match.match_rooms;
create trigger guard_open_room_membership
  before insert or update of status, player_one_id, player_two_id on riddle_match.match_rooms
  for each row execute function riddle_match.guard_open_room_membership();

-- Serialize insertion against game transitions, enforce membership, and bound
-- messages even when the API connects as the schema owner (which bypasses RLS).
create or replace function riddle_match.guard_room_message()
returns trigger language plpgsql security definer
set search_path = pg_catalog, riddle_match as $$
declare
  v_room riddle_match.match_rooms%rowtype;
  v_player uuid := riddle_match.current_player_id();
begin
  select * into v_room from riddle_match.match_rooms where id = new.room_id for update;
  if v_player is null or not found or new.sender_id <> v_player
    or v_player not in (v_room.player_one_id, v_room.player_two_id)
    or new.round_number <> v_room.round_number
    or v_room.status not in ('waiting_setter', 'active')
    or (v_room.status = 'active' and v_room.expires_at <= clock_timestamp()) then
    raise exception 'message_action_not_allowed' using errcode = '42501';
  end if;
  if (select count(*) from riddle_match.room_messages
      where room_id = new.room_id and round_number = new.round_number) >= 500 then
    raise exception 'message_limit_reached' using errcode = '54000';
  end if;
  if exists (select 1 from riddle_match.room_messages
    where room_id = new.room_id and round_number = new.round_number
      and sender_id = v_player and created_at > clock_timestamp() - interval '500 milliseconds') then
    raise exception 'message_rate_limited' using errcode = '54000';
  end if;
  new.id := gen_random_uuid();
  new.created_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists guard_room_message on riddle_match.room_messages;
create trigger guard_room_message before insert on riddle_match.room_messages
  for each row execute function riddle_match.guard_room_message();

-- Every valid room poll refreshes only its own heartbeat. A participant can
-- observe an absent peer after 30 seconds. No background job is assumed.
create or replace function riddle_match.touch_room(p_room_id uuid)
returns riddle_match.match_rooms language plpgsql security definer
set search_path = pg_catalog, riddle_match as $$
declare
  v_player uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
  v_peer uuid;
  v_now timestamptz;
begin
  if v_player is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  select * into v_room from riddle_match.match_rooms
    where id = p_room_id and v_player in (player_one_id, player_two_id) for update;
  if not found then raise exception 'room_access_denied' using errcode = '42501'; end if;
  v_now := clock_timestamp();
  if v_room.status <> 'abandoned' then
    update riddle_match.room_presence set last_seen_at = v_now
      where room_id = v_room.id and player_id = v_player;
    v_peer := case when v_player = v_room.player_one_id then v_room.player_two_id else v_room.player_one_id end;
    if not exists (select 1 from riddle_match.room_presence
      where room_id = v_room.id and player_id = v_peer and last_seen_at > v_now - interval '30 seconds') then
      update riddle_match.match_rooms set status = 'abandoned', ended_at = v_now, updated_at = v_now
        where id = v_room.id returning * into v_room;
    end if;
  end if;
  return v_room;
end;
$$;


create or replace function riddle_match.join_matchmaking(p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
declare
  v_user_id uuid := riddle_match.current_player_id();
  v_nickname text := btrim(coalesce(p_nickname, ''));
  v_existing riddle_match.match_rooms%rowtype;
  v_peer riddle_match.matchmaking_queue%rowtype;
  v_room riddle_match.match_rooms%rowtype;
  v_topics text[] := array[
    '日常小物', '城市角落', '餐桌風景', '午後時光', '自然觀察', '居家日常',
    '旅行途中', '天氣心情', '書桌一角', '夜晚抬頭', '小小植物', '聲音記憶'
  ];
  v_topic_number smallint;
  v_setter_id uuid;
  v_guesser_id uuid;
  v_setter_nickname text;
  v_guesser_nickname text;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if char_length(v_nickname) not between 1 and 24 then
    raise exception 'nickname_length_invalid' using errcode = '22023';
  end if;

  -- Serialize queue joins so two callers cannot claim the same waiting player.
  perform pg_advisory_xact_lock(2109761245, 52644002);

  select * into v_existing
  from riddle_match.match_rooms as room
  where room.status in ('waiting_setter', 'active', 'solved', 'timed_out')
    and v_user_id in (room.player_one_id, room.player_two_id)
  order by room.created_at desc
  limit 1
  for update;

  if found then
    select * into v_existing from riddle_match.touch_room(v_existing.id);
    if v_existing.status <> 'abandoned' then
      return jsonb_build_object(
      'state', 'matched',
      'room_id', v_existing.id,
      'role', case when v_existing.setter_id = v_user_id then 'setter' else 'guesser' end,
      'status', v_existing.status,
      'round_number', v_existing.round_number,
      'topic_number', v_existing.topic_number,
      'topic', v_existing.topic,
      'opponent_nickname', case
        when v_existing.player_one_id = v_user_id then v_existing.player_two_nickname
        else v_existing.player_one_nickname
      end
      );
    end if;
  end if;

  delete from riddle_match.matchmaking_queue
  where last_seen_at <= clock_timestamp() - interval '30 seconds';

  select * into v_peer
  from riddle_match.matchmaking_queue as queued
  where queued.user_id <> v_user_id
    and not exists (
      select 1 from riddle_match.match_rooms as open_room
      where open_room.status in ('waiting_setter', 'active', 'solved', 'timed_out')
        and queued.user_id in (open_room.player_one_id, open_room.player_two_id)
    )
  order by queued.created_at, queued.user_id
  limit 1
  for update skip locked;

  if not found then
    insert into riddle_match.matchmaking_queue (user_id, nickname)
    values (v_user_id, v_nickname)
    on conflict (user_id) do update set nickname = excluded.nickname, last_seen_at = clock_timestamp();

    return jsonb_build_object('state', 'waiting');
  end if;

  delete from riddle_match.matchmaking_queue
  where user_id in (v_peer.user_id, v_user_id);

  v_topic_number := (floor(random() * array_length(v_topics, 1)) + 1)::smallint;
  if random() < 0.5 then
    v_setter_id := v_peer.user_id;
    v_guesser_id := v_user_id;
    v_setter_nickname := v_peer.nickname;
    v_guesser_nickname := v_nickname;
  else
    v_setter_id := v_user_id;
    v_guesser_id := v_peer.user_id;
    v_setter_nickname := v_nickname;
    v_guesser_nickname := v_peer.nickname;
  end if;

  insert into riddle_match.match_rooms (
    player_one_id, player_two_id, player_one_nickname, player_two_nickname,
    setter_id, guesser_id, topic_number, topic
  ) values (
    v_peer.user_id, v_user_id, v_peer.nickname, v_nickname,
    v_setter_id, v_guesser_id, v_topic_number, v_topics[v_topic_number]
  ) returning * into v_room;

  insert into riddle_match.room_presence (room_id, player_id)
    values (v_room.id, v_room.player_one_id), (v_room.id, v_room.player_two_id);

  return jsonb_build_object(
    'state', 'matched',
    'room_id', v_room.id,
    'role', case when v_room.setter_id = v_user_id then 'setter' else 'guesser' end,
    'status', v_room.status,
    'round_number', v_room.round_number,
    'topic_number', v_room.topic_number,
    'topic', v_room.topic,
    'opponent_nickname', case
      when v_room.player_one_id = v_user_id then v_room.player_two_nickname
      else v_room.player_one_nickname
    end
  );
end;
$$;

create or replace function riddle_match.cancel_matchmaking()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
declare
  v_user_id uuid := riddle_match.current_player_id();
  v_deleted integer;
  v_room riddle_match.match_rooms%rowtype;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(2109761245, 52644002);
  delete from riddle_match.matchmaking_queue where user_id = v_user_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    select * into v_room
    from riddle_match.match_rooms as room
    where room.status in ('waiting_setter', 'active', 'solved', 'timed_out')
      and v_user_id in (room.player_one_id, room.player_two_id)
    order by room.created_at desc
    limit 1
    for update;
    if found then
      update riddle_match.match_rooms
      set status = 'abandoned', ended_at = now(), updated_at = now()
      where id = v_room.id;
      get diagnostics v_deleted = row_count;
    end if;
  end if;
  return v_deleted > 0;
end;
$$;

create or replace function riddle_match.leave_room(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
declare
  v_user_id uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  -- Always acquire the queue lock before the room lock.
  perform pg_advisory_xact_lock(2109761245, 52644002);

  select * into v_room
  from riddle_match.match_rooms as room
  where room.id = p_room_id
    and riddle_match.current_player_id() in (room.player_one_id, room.player_two_id)
  for update;

  if not found then
    return false;
  end if;

  if v_room.status <> 'abandoned' then
    update riddle_match.match_rooms
    set status = 'abandoned', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_room.id;
    delete from riddle_match.matchmaking_queue
    where user_id in (v_room.player_one_id, v_room.player_two_id);
  end if;
  return true;
end;
$$;

create or replace function riddle_match.submit_riddle(
  p_room_id uuid,
  p_riddle text,
  p_answer text,
  p_hint text,
  p_accepted_answers text[] default '{}',
  p_round_number integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
declare
  v_user_id uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_riddle, ''))) not between 1 and 180
    or char_length(btrim(coalesce(p_answer, ''))) not between 1 and 80
    or char_length(btrim(coalesce(p_hint, ''))) not between 1 and 180
    or riddle_match.normalize_riddle_answer(p_answer) = ''
    or coalesce(cardinality(p_accepted_answers), 0) > 10
    or exists (select 1 from unnest(coalesce(p_accepted_answers, '{}')) as a(value)
               where a.value is null or char_length(btrim(a.value)) not between 1 and 80
                 or riddle_match.normalize_riddle_answer(a.value) = '') then
    raise exception 'riddle_fields_invalid' using errcode = '22023';
  end if;

  -- Refresh the caller and check the peer even if clients skip polling.
  perform riddle_match.touch_room(p_room_id);

  select * into v_room
  from riddle_match.match_rooms as room
  where room.id = p_room_id
  for update;

  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;
  if not found or v_room.setter_id <> v_user_id or v_room.status <> 'waiting_setter' then
    raise exception 'setter_action_not_allowed' using errcode = '42501';
  end if;

  insert into riddle_match.room_secrets (room_id, round_number, answer, hint, accepted_answers)
  values (
    v_room.id,
    v_room.round_number,
    btrim(p_answer),
    btrim(p_hint),
    coalesce(p_accepted_answers, '{}')
  );

  update riddle_match.match_rooms
  set riddle = btrim(p_riddle),
      status = 'active',
      expires_at = clock_timestamp() + interval '5 minutes',
      hint_used = false,
      updated_at = clock_timestamp()
  where id = v_room.id
  returning expires_at into v_room.expires_at;

  return jsonb_build_object('state', 'active', 'expires_at', v_room.expires_at);
end;
$$;

create or replace function riddle_match.submit_guess(p_room_id uuid, p_guess text, p_round_number integer default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
declare
  v_user_id uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
  v_answer text;
  v_accepted_answers text[];
  v_correct boolean := false;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_guess, ''))) not between 1 and 100 then
    raise exception 'guess_length_invalid' using errcode = '22023';
  end if;
  if riddle_match.normalize_riddle_answer(p_guess) = '' then
    raise exception 'guess_has_no_answer_text' using errcode = '22023';
  end if;

  -- Refresh the caller and check the peer even if clients skip polling.
  perform riddle_match.touch_room(p_room_id);

  select * into v_room
  from riddle_match.match_rooms as room
  where room.id = p_room_id
  for update;

  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;
  if not found or v_room.guesser_id <> v_user_id then
    raise exception 'guesser_action_not_allowed' using errcode = '42501';
  end if;
  if v_room.status <> 'active' then
    if v_room.status = 'timed_out' then
      select secret.answer into v_answer from riddle_match.room_secrets as secret
      where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
    end if;
    return jsonb_build_object('state', v_room.status, 'correct', null, 'answer', v_answer);
  end if;

  if v_room.expires_at <= clock_timestamp() then
    update riddle_match.match_rooms
    set status = 'timed_out', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_room.id;
    select secret.answer into v_answer
    from riddle_match.room_secrets as secret
    where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
    return jsonb_build_object('state', 'timed_out', 'correct', false, 'answer', v_answer);
  end if;

  select secret.answer, secret.accepted_answers
  into v_answer, v_accepted_answers
  from riddle_match.room_secrets as secret
  where secret.room_id = v_room.id and secret.round_number = v_room.round_number;

  if not found then
    raise exception 'answer_not_available' using errcode = '55000';
  end if;

  v_correct := riddle_match.normalize_riddle_answer(p_guess)
    = riddle_match.normalize_riddle_answer(v_answer)
    or exists (
      select 1
      from unnest(v_accepted_answers) as accepted(answer)
      where riddle_match.normalize_riddle_answer(accepted.answer)
        = riddle_match.normalize_riddle_answer(p_guess)
    );

  if v_correct then
    update riddle_match.match_rooms
    set status = 'solved', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_room.id;
  end if;

  return jsonb_build_object(
    'state', case when v_correct then 'solved' else 'active' end,
    'correct', v_correct
  );
end;
$$;

create or replace function riddle_match.request_room_hint(p_room_id uuid, p_round_number integer default null)
returns text
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
declare
  v_user_id uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
  v_hint text;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  -- Refresh the caller and check the peer even if clients skip polling.
  perform riddle_match.touch_room(p_room_id);

  select * into v_room
  from riddle_match.match_rooms as room
  where room.id = p_room_id
  for update;

  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;
  if not found or v_room.guesser_id <> v_user_id or v_room.status <> 'active' then
    raise exception 'hint_action_not_allowed' using errcode = '42501';
  end if;
  if v_room.expires_at <= clock_timestamp() then
    update riddle_match.match_rooms
    set status = 'timed_out', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_room.id;
    return null;
  end if;
  select secret.hint into v_hint
  from riddle_match.room_secrets as secret
  where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
  if not found then
    raise exception 'hint_not_available' using errcode = '55000';
  end if;

  update riddle_match.match_rooms
  set hint_used = true, updated_at = clock_timestamp()
  where id = v_room.id;

  return v_hint;
end;
$$;

create or replace function riddle_match.end_expired_round(p_room_id uuid, p_round_number integer default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
declare
  v_user_id uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
  v_answer text;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  -- Refresh the caller and check the peer even if clients skip polling.
  perform riddle_match.touch_room(p_room_id);

  select * into v_room
  from riddle_match.match_rooms as room
  where room.id = p_room_id
    and riddle_match.current_player_id() in (room.player_one_id, room.player_two_id)
  for update;

  if not found then
    raise exception 'room_access_denied' using errcode = '42501';
  end if;

  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;

  if v_room.status = 'active' and v_room.expires_at <= clock_timestamp() then
    update riddle_match.match_rooms
    set status = 'timed_out', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_room.id;
    v_room.status := 'timed_out';
  elsif v_room.status = 'active' then
    return jsonb_build_object('state', 'active', 'expires_at', v_room.expires_at);
  end if;

  if v_room.status = 'timed_out' then
    select secret.answer into v_answer
    from riddle_match.room_secrets as secret
    where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
  end if;

  return jsonb_build_object('state', v_room.status, 'answer', v_answer);
end;
$$;

create or replace function riddle_match.start_next_round(p_room_id uuid, p_round_number integer default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, riddle_match
as $$
declare
  v_user_id uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
  v_topics text[] := array[
    '日常小物', '城市角落', '餐桌風景', '午後時光', '自然觀察', '居家日常',
    '旅行途中', '天氣心情', '書桌一角', '夜晚抬頭', '小小植物', '聲音記憶'
  ];
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  -- Refresh the caller and check the peer even if clients skip polling.
  perform riddle_match.touch_room(p_room_id);

  select * into v_room
  from riddle_match.match_rooms as room
  where room.id = p_room_id
    and riddle_match.current_player_id() in (room.player_one_id, room.player_two_id)
  for update;

  if not found then
    raise exception 'room_access_denied' using errcode = '42501';
  end if;
  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;
  if v_room.status not in ('solved', 'timed_out') then
    raise exception 'round_not_finished' using errcode = '55000';
  end if;

  v_room.topic_number := (v_room.topic_number % 12) + 1;
  v_room.round_number := v_room.round_number + 1;
  v_room.topic := v_topics[v_room.topic_number];
  v_room.status := 'waiting_setter';
  v_room.riddle := null;
  v_room.hint_used := false;
  v_room.expires_at := null;
  v_room.ended_at := null;

  update riddle_match.match_rooms
  set setter_id = v_room.guesser_id,
      guesser_id = v_room.setter_id,
      round_number = v_room.round_number,
      topic_number = v_room.topic_number,
      topic = v_room.topic,
      riddle = null,
      status = 'waiting_setter',
      hint_used = false,
      expires_at = null,
      ended_at = null,
      updated_at = clock_timestamp()
  where id = v_room.id;

  return jsonb_build_object(
    'state', 'waiting_setter',
    'round_number', v_room.round_number,
    'topic_number', v_room.topic_number,
    'topic', v_room.topic,
    'role', case when v_room.guesser_id = v_user_id then 'setter' else 'guesser' end
  );
end;
$$;

-- Read and write only through these membership-checked routines. JSON room
-- results never include a secret. Historic messages remain visible to the pair.
create or replace function riddle_match.get_room(p_room_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, riddle_match as $$
declare
  v_player uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
begin
  if v_player is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  select * into v_room from riddle_match.touch_room(p_room_id);
  return to_jsonb(v_room);
end;
$$;

create or replace function riddle_match.get_room_messages(p_room_id uuid, p_round_number integer)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, riddle_match as $$
declare
  v_player uuid := riddle_match.current_player_id();
  v_messages jsonb;
begin
  if v_player is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if not exists (select 1 from riddle_match.match_rooms
      where id = p_room_id and v_player in (player_one_id, player_two_id)) then
    raise exception 'room_access_denied' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(message) order by message.created_at, message.id), '[]'::jsonb)
  into v_messages from riddle_match.room_messages as message
  where message.room_id = p_room_id and message.round_number = p_round_number;
  return v_messages;
end;
$$;

create or replace function riddle_match.send_room_message(p_room_id uuid, p_round_number integer, p_body text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, riddle_match as $$
declare
  v_player uuid := riddle_match.current_player_id();
  v_message riddle_match.room_messages%rowtype;
begin
  if v_player is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 180 then
    raise exception 'message_length_invalid' using errcode = '22023';
  end if;
  perform riddle_match.touch_room(p_room_id);
  insert into riddle_match.room_messages (room_id, round_number, sender_id, body)
    values (p_room_id, p_round_number, v_player, btrim(p_body)) returning * into v_message;
  return to_jsonb(v_message);
end;
$$;

-- Call opportunistically from the trusted API. No external schemas or unrelated
-- branch data are touched. SKIP LOCKED avoids disrupting active transactions.
create or replace function riddle_match.cleanup_expired_data()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, riddle_match as $$
declare
  v_room_id uuid;
  v_now timestamptz := clock_timestamp();
  v_abandoned integer := 0;
  v_rooms integer := 0;
  v_sessions integer := 0;
  v_rates integer := 0;
begin
  for v_room_id in
    select room.id from riddle_match.match_rooms as room
    where room.status <> 'abandoned'
      and not exists (select 1 from riddle_match.room_presence as presence
        where presence.room_id = room.id and presence.last_seen_at > v_now - interval '30 seconds')
    order by room.updated_at
    limit 100 for update skip locked
  loop
    -- Recheck under the room lock, after any simultaneous heartbeat commits.
    if not exists (select 1 from riddle_match.room_presence as presence
      where presence.room_id = v_room_id and presence.last_seen_at > clock_timestamp() - interval '30 seconds') then
      update riddle_match.match_rooms set status = 'abandoned', ended_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = v_room_id;
      v_abandoned := v_abandoned + 1;
    end if;
  end loop;
  delete from riddle_match.matchmaking_queue where user_id in (
    select user_id from riddle_match.matchmaking_queue
      where last_seen_at <= v_now - interval '30 seconds' limit 500 for update skip locked
  );
  delete from riddle_match.match_rooms where id in (
    select id from riddle_match.match_rooms where status = 'abandoned'
      and ended_at < v_now - interval '7 days' limit 100 for update skip locked
  );
  get diagnostics v_rooms = row_count;
  delete from riddle_match.player_sessions where token_hash in (
    select token_hash from riddle_match.player_sessions
      where expires_at < v_now limit 500 for update skip locked
  );
  get diagnostics v_sessions = row_count;
  delete from riddle_match.api_rate_limits where bucket in (
    select bucket from riddle_match.api_rate_limits
      where window_started_at < v_now - interval '1 day' limit 500 for update skip locked
  );
  get diagnostics v_rates = row_count;
  delete from riddle_match.players where id in (
    select player.id from riddle_match.players as player
    where player.created_at < v_now - interval '7 days'
      and not exists (select 1 from riddle_match.player_sessions s where s.player_id = player.id)
      and not exists (select 1 from riddle_match.matchmaking_queue q where q.user_id = player.id)
      and not exists (select 1 from riddle_match.match_rooms r where player.id in (r.player_one_id, r.player_two_id))
    limit 500 for update skip locked
  );
  return jsonb_build_object('abandoned', v_abandoned, 'rooms_deleted', v_rooms,
                            'sessions_deleted', v_sessions, 'rate_buckets_deleted', v_rates);
end;
$$;

-- Never let an unauthenticated SQL role expose this schema accidentally.
revoke all on all tables in schema riddle_match from public;
revoke all on all functions in schema riddle_match from public;
