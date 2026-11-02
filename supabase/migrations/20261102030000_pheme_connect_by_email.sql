-- Open registration for any confirmed login, and self-service connections by email.
-- A member names an email; if that person has joined they are connected now, otherwise the
-- connection completes when that email registers. Approvals can be layered on later.

drop function public.pheme_allow_email(text, text[]);
drop function public.pheme_register(uuid, text, text, text, text);
drop table public.pheme_allowed_emails;

alter table public.pheme_users add column email text unique check (email = lower(email));
update public.pheme_users u set email = lower(a.email) from auth.users a where a.id = u.auth_user_id;

create table public.pheme_pending_connections (
  requester text not null references public.pheme_users(id) on delete cascade,
  email text not null check (email = lower(email)),
  created_at timestamptz not null default now(),
  primary key (requester, email)
);
create index pheme_pending_by_email on public.pheme_pending_connections (email);
alter table public.pheme_pending_connections enable row level security;
revoke all on public.pheme_pending_connections from anon, authenticated;

create function public.pheme_register(p_auth uuid, p_email text, p_handle text, p_name text, p_token_hash text) returns jsonb
language plpgsql as $$
declare pending record;
begin
  if p_handle !~ '^[a-zA-Z0-9_-]{1,80}$' then raise exception 'pheme:400:Handle must be 1-80 letters, digits, _ or -'; end if;
  perform pg_advisory_xact_lock(hashtextextended('register:' || p_auth::text, 0));
  if exists (select 1 from pheme_users where auth_user_id = p_auth) then raise exception 'pheme:409:This account is already registered; rotate the token instead'; end if;
  if exists (select 1 from pheme_users where id = p_handle) then raise exception 'pheme:409:Handle is taken'; end if;
  insert into pheme_users(id, name, token_hash, auth_user_id, email) values (p_handle, p_name, p_token_hash, p_auth, lower(p_email));
  -- Anyone who asked to connect to this email gets connected now.
  for pending in select requester from pheme_pending_connections where email = lower(p_email) loop
    perform pheme_connect(p_handle, pending.requester);
  end loop;
  delete from pheme_pending_connections where email = lower(p_email);
  return jsonb_build_object('id', p_handle, 'name', p_name);
end $$;

-- The reply never says whether the email has an account, so this cannot be used to probe who is registered.
create function public.pheme_connect_email(p_user text, p_email text) returns jsonb
language plpgsql as $$
declare target pheme_users; mail text := lower(trim(p_email));
begin
  select * into target from pheme_users where email = mail;
  if found and target.id = p_user then raise exception 'pheme:400:That is your own email'; end if;
  if found then
    perform pheme_connect(p_user, target.id);
  else
    if (select count(*) from pheme_pending_connections where requester = p_user) >= 50 then raise exception 'pheme:429:Too many pending connection requests'; end if;
    insert into pheme_pending_connections(requester, email) values (p_user, mail) on conflict do nothing;
  end if;
  return jsonb_build_object('requested', true);
end $$;

create function public.pheme_connections(p_user text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'people', pheme_people(p_user),
    'pending', (select coalesce(jsonb_agg(email order by email), '[]'::jsonb) from pheme_pending_connections where requester = p_user));
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
