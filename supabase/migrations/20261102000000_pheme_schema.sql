-- Pheme human-review broker schema. Accessed only by the `pheme` Edge Function
-- through the service role; RLS is on with no policies, so anon/authenticated
-- keys can read or write nothing.

create table public.pheme_users (
  id text primary key check (id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  name text not null,
  token_hash text not null unique
);

create table public.pheme_reviews (
  seq bigint generated always as identity,
  id text primary key default gen_random_uuid()::text,
  owner text not null references public.pheme_users(id),
  recipient text not null references public.pheme_users(id),
  title text not null,
  text text not null,
  version integer not null default 1,
  state text not null default 'pending' check (state in ('pending','responded','finalized')),
  created_at timestamptz not null default now(),
  response jsonb,
  finalization jsonb
);

create table public.pheme_events (
  seq bigint generated always as identity,
  id text primary key default gen_random_uuid()::text,
  inbox text not null references public.pheme_users(id),
  review_id text not null references public.pheme_reviews(id),
  kind text not null,
  acked boolean not null default false
);
create index pheme_events_inbox_unacked on public.pheme_events (inbox, seq) where not acked;

create table public.pheme_keys (
  scoped_key text primary key,
  fingerprint text not null,
  result jsonb not null
);

alter table public.pheme_users enable row level security;
alter table public.pheme_reviews enable row level security;
alter table public.pheme_events enable row level security;
alter table public.pheme_keys enable row level security;
revoke all on public.pheme_users, public.pheme_reviews, public.pheme_events, public.pheme_keys from anon, authenticated;

-- Errors are raised as 'pheme:<http status>:<message>' and mapped by the Edge Function.
create function public.pheme_review_json(r public.pheme_reviews) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', r.id, 'owner', r.owner, 'recipient', r.recipient, 'title', r.title, 'text', r.text,
    'version', r.version, 'createdAt', to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'state', r.state, 'response', r.response, 'finalization', r.finalization));
$$;

create function public.pheme_provision(p_id text, p_name text, p_hash text) returns jsonb
language plpgsql as $$
begin
  if exists (select 1 from pheme_users where id = p_id) then raise exception 'pheme:409:User already exists'; end if;
  insert into pheme_users(id, name, token_hash) values (p_id, p_name, p_hash);
  return jsonb_build_object('id', p_id, 'name', p_name);
end $$;

create function public.pheme_authenticate(p_hash text) returns jsonb
language plpgsql stable as $$
declare u pheme_users;
begin
  select * into u from pheme_users where token_hash = p_hash;
  if not found then raise exception 'pheme:401:Invalid bearer token'; end if;
  return jsonb_build_object('id', u.id, 'name', u.name);
end $$;

create function public.pheme_get_review(p_id text, p_user text) returns jsonb
language plpgsql stable as $$
declare r pheme_reviews;
begin
  select * into r from pheme_reviews where id = p_id and (owner = p_user or recipient = p_user);
  if not found then raise exception 'pheme:404:Review not found'; end if;
  return pheme_review_json(r);
end $$;

create function public.pheme_pending(p_user text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(pheme_review_json(r) order by r.seq), '[]'::jsonb)
  from pheme_reviews r where (r.owner = p_user or r.recipient = p_user) and r.state <> 'finalized';
$$;

create function public.pheme_events(p_user text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'inbox', e.inbox, 'reviewId', e.review_id, 'kind', e.kind, 'acked', e.acked) order by e.seq), '[]'::jsonb)
  from pheme_events e where e.inbox = p_user and not e.acked;
$$;

create function public.pheme_ack(p_id text, p_user text) returns jsonb
language plpgsql as $$
begin
  update pheme_events set acked = true where id = p_id and inbox = p_user;
  if not found then raise exception 'pheme:404:Event not found'; end if;
  return jsonb_build_object('acknowledged', true);
end $$;

-- Returns the stored result when this (user, key) already succeeded, null when new.
create function public.pheme_idem(p_scoped text, p_fp text) returns jsonb
language plpgsql as $$
declare k pheme_keys;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_scoped, 0));
  select * into k from pheme_keys where scoped_key = p_scoped;
  if not found then return null; end if;
  if k.fingerprint <> p_fp then raise exception 'pheme:409:Idempotency key reused'; end if;
  return k.result;
end $$;

create function public.pheme_create(p_user text, p_key text, p_fp text, p_recipient text, p_title text, p_text text) returns jsonb
language plpgsql as $$
declare scoped text := p_user || ':' || p_key; v jsonb; r pheme_reviews;
begin
  v := pheme_idem(scoped, p_fp); if v is not null then return v; end if;
  if not exists (select 1 from pheme_users where id = p_recipient) then raise exception 'pheme:404:Recipient not found'; end if;
  if p_user = p_recipient then raise exception 'pheme:400:Choose a different reviewer'; end if;
  insert into pheme_reviews(owner, recipient, title, text) values (p_user, p_recipient, p_title, p_text) returning * into r;
  insert into pheme_events(inbox, review_id, kind) values (p_recipient, r.id, 'review_requested');
  v := pheme_review_json(r);
  insert into pheme_keys values (scoped, p_fp, v);
  return v;
end $$;

create function public.pheme_respond(p_user text, p_key text, p_fp text, p_id text, p_version integer, p_verdict text, p_feedback text) returns jsonb
language plpgsql as $$
declare scoped text := p_user || ':' || p_key; v jsonb; r pheme_reviews;
begin
  v := pheme_idem(scoped, p_fp); if v is not null then return v; end if;
  select * into r from pheme_reviews where id = p_id for update;
  if not found or r.recipient <> p_user then raise exception 'pheme:403:Only designated reviewer can respond'; end if;
  if r.version <> p_version or r.state <> 'pending' then raise exception 'pheme:409:Review changed; reload'; end if;
  update pheme_reviews set
    response = jsonb_strip_nulls(jsonb_build_object('by', p_user, 'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'verdict', p_verdict, 'feedback', p_feedback)),
    state = 'responded', version = version + 1
  where id = p_id returning * into r;
  insert into pheme_events(inbox, review_id, kind) values (r.owner, r.id, 'review_responded');
  v := pheme_review_json(r);
  insert into pheme_keys values (scoped, p_fp, v);
  return v;
end $$;

create function public.pheme_finalize(p_user text, p_key text, p_fp text, p_id text, p_version integer, p_action text, p_note text) returns jsonb
language plpgsql as $$
declare scoped text := p_user || ':' || p_key; v jsonb; r pheme_reviews;
begin
  v := pheme_idem(scoped, p_fp); if v is not null then return v; end if;
  select * into r from pheme_reviews where id = p_id for update;
  if not found or r.owner <> p_user then raise exception 'pheme:403:Only owner can finalize'; end if;
  if r.version <> p_version or r.state <> 'responded' then raise exception 'pheme:409:Response at expected version required'; end if;
  update pheme_reviews set
    finalization = jsonb_strip_nulls(jsonb_build_object('by', p_user, 'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'action', p_action, 'note', p_note)),
    state = 'finalized', version = version + 1
  where id = p_id returning * into r;
  v := pheme_review_json(r);
  insert into pheme_keys values (scoped, p_fp, v);
  return v;
end $$;

-- Only the service role (the Edge Function) may call these.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
