-- Replaces invite codes with an email allowlist, and restricts who can message whom to
-- connected pairs. For now only the admin (service role) adds people and connections.

drop function public.pheme_register(uuid, text, text, text, text);
drop function public.pheme_create_invite(text, text);
drop table public.pheme_invites;

create table public.pheme_allowed_emails (
  email text primary key check (email = lower(email)),
  connect_with text[] not null default '{}',
  created_at timestamptz not null default now(),
  claimed_by text references public.pheme_users(id),
  claimed_at timestamptz
);
alter table public.pheme_allowed_emails enable row level security;
revoke all on public.pheme_allowed_emails from anon, authenticated;

-- One row per unordered pair; a < b keeps the pair canonical.
create table public.pheme_connections (
  a text not null references public.pheme_users(id) on delete cascade,
  b text not null references public.pheme_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);
create index pheme_connections_b on public.pheme_connections (b);
alter table public.pheme_connections enable row level security;
revoke all on public.pheme_connections from anon, authenticated;

-- Users that already exist form a trusted group: connect everyone to everyone.
insert into public.pheme_connections(a, b)
select x.id, y.id from public.pheme_users x join public.pheme_users y on x.id < y.id;

create function public.pheme_connected(p_x text, p_y text) returns boolean
language sql stable as $$
  select exists (select 1 from pheme_connections where a = least(p_x, p_y) and b = greatest(p_x, p_y));
$$;

create function public.pheme_connect(p_x text, p_y text) returns jsonb
language plpgsql as $$
begin
  if p_x = p_y then raise exception 'pheme:400:Cannot connect a person to themselves'; end if;
  if not exists (select 1 from pheme_users where id = p_x) or not exists (select 1 from pheme_users where id = p_y) then
    raise exception 'pheme:404:Both people must be registered first';
  end if;
  insert into pheme_connections(a, b) values (least(p_x, p_y), greatest(p_x, p_y)) on conflict do nothing;
  return jsonb_build_object('connected', jsonb_build_array(least(p_x, p_y), greatest(p_x, p_y)));
end $$;

create function public.pheme_allow_email(p_email text, p_connect_with text[]) returns jsonb
language plpgsql as $$
begin
  insert into pheme_allowed_emails(email, connect_with) values (lower(p_email), coalesce(p_connect_with, '{}'))
  on conflict (email) do update set connect_with = excluded.connect_with where pheme_allowed_emails.claimed_by is null;
  return jsonb_build_object('email', lower(p_email));
end $$;

-- Called with the verified email of a signed-in Auth user. The allowlist row is consumed.
create function public.pheme_register(p_auth uuid, p_email text, p_handle text, p_name text, p_token_hash text) returns jsonb
language plpgsql as $$
declare allowed pheme_allowed_emails; peer text;
begin
  if p_handle !~ '^[a-zA-Z0-9_-]{1,80}$' then raise exception 'pheme:400:Handle must be 1-80 letters, digits, _ or -'; end if;
  perform pg_advisory_xact_lock(hashtextextended('register:' || p_auth::text, 0));
  if exists (select 1 from pheme_users where auth_user_id = p_auth) then raise exception 'pheme:409:This account is already registered; rotate the token instead'; end if;
  if exists (select 1 from pheme_users where id = p_handle) then raise exception 'pheme:409:Handle is taken'; end if;
  select * into allowed from pheme_allowed_emails where email = lower(p_email) and claimed_by is null for update;
  if not found then raise exception 'pheme:403:This email has not been invited. Ask the admin to add it.'; end if;
  insert into pheme_users(id, name, token_hash, auth_user_id) values (p_handle, p_name, p_token_hash, p_auth);
  update pheme_allowed_emails set claimed_by = p_handle, claimed_at = now() where email = allowed.email;
  foreach peer in array allowed.connect_with loop
    if peer <> p_handle and exists (select 1 from pheme_users where id = peer) then perform pheme_connect(p_handle, peer); end if;
  end loop;
  return jsonb_build_object('id', p_handle, 'name', p_name);
end $$;

create function public.pheme_people(p_user text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name) order by u.id), '[]'::jsonb)
  from pheme_users u where u.id <> p_user and pheme_connected(p_user, u.id);
$$;

-- Reviews may only go to connected people. Unknown and unconnected look the same to avoid probing the directory.
create or replace function public.pheme_create(p_user text, p_key text, p_fp text, p_recipient text, p_title text, p_text text) returns jsonb
language plpgsql as $$
declare scoped text := p_user || ':' || p_key; v jsonb; r pheme_reviews;
begin
  v := pheme_idem(scoped, p_fp); if v is not null then return v; end if;
  if p_user = p_recipient then raise exception 'pheme:400:Choose a different reviewer'; end if;
  if not exists (select 1 from pheme_users where id = p_recipient) or not pheme_connected(p_user, p_recipient) then
    raise exception 'pheme:404:Recipient not found among your connections';
  end if;
  insert into pheme_reviews(owner, recipient, title, text) values (p_user, p_recipient, p_title, p_text) returning * into r;
  insert into pheme_events(inbox, review_id, kind) values (p_recipient, r.id, 'review_requested');
  v := pheme_review_json(r);
  insert into pheme_keys values (scoped, p_fp, v);
  return v;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
