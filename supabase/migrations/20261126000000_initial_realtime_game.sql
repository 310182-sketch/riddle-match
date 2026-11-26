-- Supabase foundation for anonymous two-player riddle rooms.
-- Room answers stay in room_secrets and are only available through guarded RPCs.

create table if not exists public.matchmaking_queue (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 24),
  created_at timestamptz not null default now()
);

create index if not exists matchmaking_queue_created_at_idx
  on public.matchmaking_queue (created_at, user_id);

create table if not exists public.match_rooms (
  id uuid primary key default gen_random_uuid(),
  player_one_id uuid not null references auth.users (id) on delete cascade,
  player_two_id uuid not null references auth.users (id) on delete cascade,
  player_one_nickname text not null check (char_length(btrim(player_one_nickname)) between 1 and 24),
  player_two_nickname text not null check (char_length(btrim(player_two_nickname)) between 1 and 24),
  setter_id uuid not null references auth.users (id) on delete cascade,
  guesser_id uuid not null references auth.users (id) on delete cascade,
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
  on public.match_rooms (player_one_id)
  where status in ('waiting_setter', 'active');

create unique index if not exists match_rooms_one_open_room_per_player_two_idx
  on public.match_rooms (player_two_id)
  where status in ('waiting_setter', 'active');

create index if not exists match_rooms_player_one_status_idx
  on public.match_rooms (player_one_id, status, created_at desc);

create index if not exists match_rooms_player_two_status_idx
  on public.match_rooms (player_two_id, status, created_at desc);

create table if not exists public.room_secrets (
  room_id uuid not null references public.match_rooms (id) on delete cascade,
  round_number integer not null check (round_number > 0),
  answer text not null check (char_length(btrim(answer)) between 1 and 80),
  hint text not null check (char_length(btrim(hint)) between 1 and 180),
  accepted_answers text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (room_id, round_number),
  check (cardinality(accepted_answers) <= 10)
);

create table if not exists public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.match_rooms (id) on delete cascade,
  round_number integer not null check (round_number > 0),
  sender_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 180),
  created_at timestamptz not null default now()
);

create index if not exists room_messages_room_round_created_idx
  on public.room_messages (room_id, round_number, created_at, id);

alter table public.matchmaking_queue enable row level security;
alter table public.match_rooms enable row level security;
alter table public.room_secrets enable row level security;
alter table public.room_messages enable row level security;

-- The queue is only changed by SECURITY DEFINER matchmaking RPCs.
revoke all on table public.matchmaking_queue from anon, authenticated;

revoke all on table public.match_rooms from anon, authenticated;
grant select on table public.match_rooms to authenticated;
drop policy if exists match_rooms_participant_read on public.match_rooms;
create policy match_rooms_participant_read
  on public.match_rooms for select to authenticated
  using (auth.uid() in (player_one_id, player_two_id));

revoke all on table public.room_secrets from anon, authenticated;
grant select on table public.room_secrets to authenticated;
drop policy if exists room_secrets_current_setter_read on public.room_secrets;
create policy room_secrets_current_setter_read
  on public.room_secrets for select to authenticated
  using (
    exists (
      select 1
      from public.match_rooms as room
      where room.id = room_secrets.room_id
        and room.round_number = room_secrets.round_number
        and room.setter_id = auth.uid()
    )
  );

revoke all on table public.room_messages from anon, authenticated;
grant select, insert on table public.room_messages to authenticated;
drop policy if exists room_messages_participant_read on public.room_messages;
create policy room_messages_participant_read
  on public.room_messages for select to authenticated
  using (
    exists (
      select 1 from public.match_rooms as room
      where room.id = room_messages.room_id
        and auth.uid() in (room.player_one_id, room.player_two_id)
    )
  );
drop policy if exists room_messages_participant_insert on public.room_messages;
create policy room_messages_participant_insert
  on public.room_messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.match_rooms as room
      where room.id = room_messages.room_id
        and room.round_number = room_messages.round_number
        and room.status in ('waiting_setter', 'active')
        and auth.uid() in (room.player_one_id, room.player_two_id)
    )
  );

create or replace function public.normalize_riddle_answer(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select lower(regexp_replace(coalesce(p_value, ''), '[[:space:]，。！？、,.!?]', '', 'g'));
$$;

create or replace function public.join_matchmaking(p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_nickname text := btrim(coalesce(p_nickname, ''));
  v_existing public.match_rooms%rowtype;
  v_peer public.matchmaking_queue%rowtype;
  v_room public.match_rooms%rowtype;
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
  perform pg_advisory_xact_lock(8675309, 1);

  select * into v_existing
  from public.match_rooms as room
  where room.status in ('waiting_setter', 'active')
    and v_user_id in (room.player_one_id, room.player_two_id)
  order by room.created_at desc
  limit 1
  for update;

  if found then
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

  delete from public.matchmaking_queue
  where created_at < now() - interval '5 minutes';

  select * into v_peer
  from public.matchmaking_queue as queued
  where queued.user_id <> v_user_id
  order by queued.created_at, queued.user_id
  limit 1
  for update skip locked;

  if not found then
    insert into public.matchmaking_queue (user_id, nickname)
    values (v_user_id, v_nickname)
    on conflict (user_id) do update set nickname = excluded.nickname;

    return jsonb_build_object('state', 'waiting');
  end if;

  delete from public.matchmaking_queue
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

  insert into public.match_rooms (
    player_one_id, player_two_id, player_one_nickname, player_two_nickname,
    setter_id, guesser_id, topic_number, topic
  ) values (
    v_peer.user_id, v_user_id, v_peer.nickname, v_nickname,
    v_setter_id, v_guesser_id, v_topic_number, v_topics[v_topic_number]
  ) returning * into v_room;

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

create or replace function public.cancel_matchmaking()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted integer;
  v_room public.match_rooms%rowtype;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(8675309, 1);
  delete from public.matchmaking_queue where user_id = v_user_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    select * into v_room
    from public.match_rooms as room
    where room.status in ('waiting_setter', 'active')
      and v_user_id in (room.player_one_id, room.player_two_id)
    order by room.created_at desc
    limit 1
    for update;
    if found then
      update public.match_rooms
      set status = 'abandoned', ended_at = now(), updated_at = now()
      where id = v_room.id;
      get diagnostics v_deleted = row_count;
    end if;
  end if;
  return v_deleted > 0;
end;
$$;

create or replace function public.submit_riddle(
  p_room_id uuid,
  p_riddle text,
  p_answer text,
  p_hint text,
  p_accepted_answers text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.match_rooms%rowtype;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_riddle, ''))) not between 1 and 180
    or char_length(btrim(coalesce(p_answer, ''))) not between 1 and 80
    or char_length(btrim(coalesce(p_hint, ''))) not between 1 and 180
    or coalesce(cardinality(p_accepted_answers), 0) > 10 then
    raise exception 'riddle_fields_invalid' using errcode = '22023';
  end if;

  select * into v_room
  from public.match_rooms as room
  where room.id = p_room_id
  for update;

  if not found or v_room.setter_id <> v_user_id or v_room.status <> 'waiting_setter' then
    raise exception 'setter_action_not_allowed' using errcode = '42501';
  end if;

  insert into public.room_secrets (room_id, round_number, answer, hint, accepted_answers)
  values (
    v_room.id,
    v_room.round_number,
    btrim(p_answer),
    btrim(p_hint),
    coalesce(p_accepted_answers, '{}')
  );

  update public.match_rooms
  set riddle = btrim(p_riddle),
      status = 'active',
      expires_at = now() + interval '5 minutes',
      hint_used = false,
      updated_at = now()
  where id = v_room.id;

  return jsonb_build_object('state', 'active', 'expires_at', now() + interval '5 minutes');
end;
$$;

create or replace function public.submit_guess(p_room_id uuid, p_guess text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.match_rooms%rowtype;
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
  if public.normalize_riddle_answer(p_guess) = '' then
    raise exception 'guess_has_no_answer_text' using errcode = '22023';
  end if;

  select * into v_room
  from public.match_rooms as room
  where room.id = p_room_id
  for update;

  if not found or v_room.guesser_id <> v_user_id then
    raise exception 'guesser_action_not_allowed' using errcode = '42501';
  end if;
  if v_room.status <> 'active' then
    return jsonb_build_object('state', v_room.status, 'correct', v_room.status = 'solved');
  end if;

  if v_room.expires_at <= now() then
    update public.match_rooms
    set status = 'timed_out', ended_at = now(), updated_at = now()
    where id = v_room.id;
    select secret.answer into v_answer
    from public.room_secrets as secret
    where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
    return jsonb_build_object('state', 'timed_out', 'correct', false, 'answer', v_answer);
  end if;

  select secret.answer, secret.accepted_answers
  into v_answer, v_accepted_answers
  from public.room_secrets as secret
  where secret.room_id = v_room.id and secret.round_number = v_room.round_number;

  if not found then
    raise exception 'answer_not_available' using errcode = '55000';
  end if;

  v_correct := public.normalize_riddle_answer(p_guess)
    = public.normalize_riddle_answer(v_answer)
    or exists (
      select 1
      from unnest(v_accepted_answers) as accepted(answer)
      where public.normalize_riddle_answer(accepted.answer)
        = public.normalize_riddle_answer(p_guess)
    );

  if v_correct then
    update public.match_rooms
    set status = 'solved', ended_at = now(), updated_at = now()
    where id = v_room.id;
  end if;

  return jsonb_build_object(
    'state', case when v_correct then 'solved' else 'active' end,
    'correct', v_correct
  );
end;
$$;

create or replace function public.request_room_hint(p_room_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.match_rooms%rowtype;
  v_hint text;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into v_room
  from public.match_rooms as room
  where room.id = p_room_id
  for update;

  if not found or v_room.guesser_id <> v_user_id or v_room.status <> 'active' then
    raise exception 'hint_action_not_allowed' using errcode = '42501';
  end if;
  if v_room.expires_at <= now() then
    update public.match_rooms
    set status = 'timed_out', ended_at = now(), updated_at = now()
    where id = v_room.id;
    return null;
  end if;
  if v_room.hint_used then
    raise exception 'hint_already_used' using errcode = '22023';
  end if;

  select secret.hint into v_hint
  from public.room_secrets as secret
  where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
  if not found then
    raise exception 'hint_not_available' using errcode = '55000';
  end if;

  update public.match_rooms
  set hint_used = true, updated_at = now()
  where id = v_room.id;

  return v_hint;
end;
$$;

create or replace function public.end_expired_round(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.match_rooms%rowtype;
  v_answer text;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into v_room
  from public.match_rooms as room
  where room.id = p_room_id
    and auth.uid() in (room.player_one_id, room.player_two_id)
  for update;

  if not found then
    raise exception 'room_access_denied' using errcode = '42501';
  end if;

  if v_room.status = 'active' and v_room.expires_at <= now() then
    update public.match_rooms
    set status = 'timed_out', ended_at = now(), updated_at = now()
    where id = v_room.id;
    v_room.status := 'timed_out';
  elsif v_room.status = 'active' then
    return jsonb_build_object('state', 'active', 'expires_at', v_room.expires_at);
  end if;

  if v_room.status = 'timed_out' then
    select secret.answer into v_answer
    from public.room_secrets as secret
    where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
  end if;

  return jsonb_build_object('state', v_room.status, 'answer', v_answer);
end;
$$;

create or replace function public.start_next_round(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.match_rooms%rowtype;
  v_topics text[] := array[
    '日常小物', '城市角落', '餐桌風景', '午後時光', '自然觀察', '居家日常',
    '旅行途中', '天氣心情', '書桌一角', '夜晚抬頭', '小小植物', '聲音記憶'
  ];
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into v_room
  from public.match_rooms as room
  where room.id = p_room_id
    and auth.uid() in (room.player_one_id, room.player_two_id)
  for update;

  if not found then
    raise exception 'room_access_denied' using errcode = '42501';
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

  update public.match_rooms
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
      updated_at = now()
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

create or replace function public.leave_room(p_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.match_rooms%rowtype;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into v_room
  from public.match_rooms as room
  where room.id = p_room_id
    and auth.uid() in (room.player_one_id, room.player_two_id)
  for update;

  if not found then
    return false;
  end if;

  if v_room.status in ('waiting_setter', 'active') then
    update public.match_rooms
    set status = 'abandoned', ended_at = now(), updated_at = now()
    where id = v_room.id;
  end if;
  delete from public.matchmaking_queue
  where user_id in (v_room.player_one_id, v_room.player_two_id);
  return true;
end;
$$;

revoke all on function public.normalize_riddle_answer(text) from public, anon, authenticated;
revoke all on function public.join_matchmaking(text) from public, anon;
revoke all on function public.cancel_matchmaking() from public, anon;
revoke all on function public.submit_riddle(uuid, text, text, text, text[]) from public, anon;
revoke all on function public.submit_guess(uuid, text) from public, anon;
revoke all on function public.request_room_hint(uuid) from public, anon;
revoke all on function public.end_expired_round(uuid) from public, anon;
revoke all on function public.start_next_round(uuid) from public, anon;
revoke all on function public.leave_room(uuid) from public, anon;

grant execute on function public.join_matchmaking(text) to authenticated;
grant execute on function public.cancel_matchmaking() to authenticated;
grant execute on function public.submit_riddle(uuid, text, text, text, text[]) to authenticated;
grant execute on function public.submit_guess(uuid, text) to authenticated;
grant execute on function public.request_room_hint(uuid) to authenticated;
grant execute on function public.end_expired_round(uuid) to authenticated;
grant execute on function public.start_next_round(uuid) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;

-- Realtime publishes only participant-visible room state and chat messages.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'match_rooms'
  ) then
    alter publication supabase_realtime add table public.match_rooms;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_messages'
  ) then
    alter publication supabase_realtime add table public.room_messages;
  end if;
end;
$$;
