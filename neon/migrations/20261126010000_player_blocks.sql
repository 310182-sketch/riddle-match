-- Session-scoped blocking. This additive migration touches only riddle_match.
create table riddle_match.player_blocks (
  blocker_id uuid not null references riddle_match.players (id) on delete cascade,
  blocked_id uuid not null references riddle_match.players (id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index player_blocks_blocked_idx on riddle_match.player_blocks (blocked_id, blocker_id);
alter table riddle_match.player_blocks enable row level security;
revoke all on table riddle_match.player_blocks from public;

-- Keep the same queue lock as joins, leaves, and open-room membership checks.
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
    select 1 from riddle_match.player_blocks as blocked
    where (blocked.blocker_id = new.player_one_id and blocked.blocked_id = new.player_two_id)
       or (blocked.blocker_id = new.player_two_id and blocked.blocked_id = new.player_one_id)
  ) then
    raise exception 'players_blocked' using errcode = '23505';
  end if;
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
      select 1 from riddle_match.player_blocks as blocked
      where (blocked.blocker_id = v_user_id and blocked.blocked_id = queued.user_id)
         or (blocked.blocker_id = queued.user_id and blocked.blocked_id = v_user_id)
    )
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

create or replace function riddle_match.block_opponent(p_room_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, riddle_match as $$
declare
  v_player uuid := riddle_match.current_player_id();
  v_room riddle_match.match_rooms%rowtype;
  v_peer uuid;
  v_closed integer;
begin
  if v_player is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(2109761245, 52644002);
  select * into v_room from riddle_match.match_rooms
    where id = p_room_id and v_player in (player_one_id, player_two_id) for update;
  if not found then raise exception 'room_access_denied' using errcode = '42501'; end if;
  v_peer := case when v_player = v_room.player_one_id then v_room.player_two_id else v_room.player_one_id end;
  insert into riddle_match.player_blocks (blocker_id, blocked_id)
    values (v_player, v_peer) on conflict do nothing;

  -- A delayed block can arrive just after the same pair matched again. Close
  -- every open room for this pair, while leaving any unrelated rooms intact.
  update riddle_match.match_rooms set status = 'abandoned', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where status <> 'abandoned'
      and ((player_one_id = v_player and player_two_id = v_peer)
        or (player_one_id = v_peer and player_two_id = v_player));
  get diagnostics v_closed = row_count;
  if v_closed > 0 then
    delete from riddle_match.matchmaking_queue where user_id in (v_player, v_peer);
  end if;
  return jsonb_build_object('state', 'blocked');
end;
$$;

revoke all on function riddle_match.block_opponent(uuid) from public;
