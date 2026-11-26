-- Harden open-room membership, room transitions and client-supplied messages.
-- The optional p_round_number argument keeps older RPC calls working while
-- allowing current clients to reject delayed requests from an earlier round.

-- Check existing data rather than silently closing anyone's room during upgrade.
do $$
begin
  if exists (
    select 1 from public.match_rooms a join public.match_rooms b on a.id < b.id
    where a.status <> 'abandoned' and b.status <> 'abandoned'
      and (a.player_one_id in (b.player_one_id, b.player_two_id)
        or a.player_two_id in (b.player_one_id, b.player_two_id))
  ) then
    raise exception 'duplicate_open_rooms: close duplicate rooms before applying migration';
  end if;
end;
$$;

create or replace function public.guard_open_room_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
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
  perform pg_advisory_xact_lock(8675309, 1);
  if exists (
    select 1 from public.match_rooms as room
    where room.id <> new.id and room.status <> 'abandoned'
      and (new.player_one_id in (room.player_one_id, room.player_two_id)
        or new.player_two_id in (room.player_one_id, room.player_two_id))
  ) then
    raise exception 'player_already_in_open_room' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_open_room_membership() from public, anon, authenticated;
drop trigger if exists guard_open_room_membership on public.match_rooms;
create trigger guard_open_room_membership
  before insert or update of status, player_one_id, player_two_id on public.match_rooms
  for each row execute function public.guard_open_room_membership();

-- Only the server may assign message identity and timestamp. A locked room row
-- serializes message acceptance with solving, timeout, leaving and round changes.
revoke insert on public.room_messages from authenticated;
grant insert (room_id, round_number, sender_id, body) on public.room_messages to authenticated;
create or replace function public.guard_room_message()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_room public.match_rooms%rowtype;
begin
  select * into v_room from public.match_rooms where id = new.room_id for update;
  if not found or new.sender_id <> auth.uid()
    or auth.uid() not in (v_room.player_one_id, v_room.player_two_id)
    or new.round_number <> v_room.round_number
    or v_room.status not in ('waiting_setter', 'active')
    or (v_room.status = 'active' and v_room.expires_at <= clock_timestamp()) then
    raise exception 'message_action_not_allowed' using errcode = '42501';
  end if;
  new.created_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.guard_room_message() from public, anon, authenticated;
drop trigger if exists guard_room_message on public.room_messages;
create trigger guard_room_message before insert on public.room_messages
  for each row execute function public.guard_room_message();

-- Replace the original signatures; defaulted arguments preserve old clients.
drop function if exists public.submit_riddle(uuid, text, text, text, text[]);
drop function if exists public.submit_guess(uuid, text);
drop function if exists public.request_room_hint(uuid);
drop function if exists public.end_expired_round(uuid);
drop function if exists public.start_next_round(uuid);
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
  where room.status in ('waiting_setter', 'active', 'solved', 'timed_out')
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
    and not exists (
      select 1 from public.match_rooms as open_room
      where open_room.status in ('waiting_setter', 'active', 'solved', 'timed_out')
        and queued.user_id in (open_room.player_one_id, open_room.player_two_id)
    )
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
    where room.status in ('waiting_setter', 'active', 'solved', 'timed_out')
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

  -- Always acquire the queue lock before the room lock.
  perform pg_advisory_xact_lock(8675309, 1);

  select * into v_room
  from public.match_rooms as room
  where room.id = p_room_id
    and auth.uid() in (room.player_one_id, room.player_two_id)
  for update;

  if not found then
    return false;
  end if;

  if v_room.status <> 'abandoned' then
    update public.match_rooms
    set status = 'abandoned', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_room.id;
    delete from public.matchmaking_queue
    where user_id in (v_room.player_one_id, v_room.player_two_id);
  end if;
  return true;
end;
$$;

create or replace function public.submit_riddle(
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
    or public.normalize_riddle_answer(p_answer) = ''
    or coalesce(cardinality(p_accepted_answers), 0) > 10
    or exists (select 1 from unnest(coalesce(p_accepted_answers, '{}')) as a(value)
               where a.value is null or char_length(btrim(a.value)) not between 1 and 80
                 or public.normalize_riddle_answer(a.value) = '') then
    raise exception 'riddle_fields_invalid' using errcode = '22023';
  end if;

  select * into v_room
  from public.match_rooms as room
  where room.id = p_room_id
  for update;

  if not found or v_room.setter_id <> v_user_id then
    raise exception 'setter_action_not_allowed' using errcode = '42501';
  end if;
  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;
  if v_room.status <> 'waiting_setter' then
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
      expires_at = clock_timestamp() + interval '5 minutes',
      hint_used = false,
      updated_at = clock_timestamp()
  where id = v_room.id
  returning expires_at into v_room.expires_at;

  return jsonb_build_object('state', 'active', 'expires_at', v_room.expires_at);
end;
$$;

create or replace function public.submit_guess(p_room_id uuid, p_guess text, p_round_number integer default null)
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
  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;
  if v_room.status <> 'active' then
    if v_room.status = 'timed_out' then
      select secret.answer into v_answer from public.room_secrets as secret
      where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
    end if;
    return jsonb_build_object('state', v_room.status, 'correct', null, 'answer', v_answer);
  end if;

  if v_room.expires_at <= clock_timestamp() then
    update public.match_rooms
    set status = 'timed_out', ended_at = clock_timestamp(), updated_at = clock_timestamp()
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
    set status = 'solved', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_room.id;
  end if;

  return jsonb_build_object(
    'state', case when v_correct then 'solved' else 'active' end,
    'correct', v_correct
  );
end;
$$;

create or replace function public.request_room_hint(p_room_id uuid, p_round_number integer default null)
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

  if not found or v_room.guesser_id <> v_user_id then
    raise exception 'hint_action_not_allowed' using errcode = '42501';
  end if;
  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;
  if v_room.status <> 'active' then
    raise exception 'hint_action_not_allowed' using errcode = '42501';
  end if;
  if v_room.expires_at <= clock_timestamp() then
    update public.match_rooms
    set status = 'timed_out', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_room.id;
    return null;
  end if;
  select secret.hint into v_hint
  from public.room_secrets as secret
  where secret.room_id = v_room.id and secret.round_number = v_room.round_number;
  if not found then
    raise exception 'hint_not_available' using errcode = '55000';
  end if;

  update public.match_rooms
  set hint_used = true, updated_at = clock_timestamp()
  where id = v_room.id;

  return v_hint;
end;
$$;

create or replace function public.end_expired_round(p_room_id uuid, p_round_number integer default null)
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

  if p_round_number is not null and p_round_number <> v_room.round_number then
    raise exception 'round_changed' using errcode = '55000';
  end if;

  if v_room.status = 'active' and v_room.expires_at <= clock_timestamp() then
    update public.match_rooms
    set status = 'timed_out', ended_at = clock_timestamp(), updated_at = clock_timestamp()
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

create or replace function public.start_next_round(p_room_id uuid, p_round_number integer default null)
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
revoke all on function public.submit_riddle(uuid, text, text, text, text[], integer) from public, anon;
revoke all on function public.submit_guess(uuid, text, integer) from public, anon;
revoke all on function public.request_room_hint(uuid, integer) from public, anon;
revoke all on function public.end_expired_round(uuid, integer) from public, anon;
revoke all on function public.start_next_round(uuid, integer) from public, anon;
grant execute on function public.submit_riddle(uuid, text, text, text, text[], integer) to authenticated;
grant execute on function public.submit_guess(uuid, text, integer) to authenticated;
grant execute on function public.request_room_hint(uuid, integer) to authenticated;
grant execute on function public.end_expired_round(uuid, integer) to authenticated;
grant execute on function public.start_next_round(uuid, integer) to authenticated;
