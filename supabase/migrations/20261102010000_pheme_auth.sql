-- Self-service sign up: a Supabase Auth user claims a Pheme handle with a single-use
-- invite code and receives a bridge token. Only token hashes are stored.

alter table public.pheme_users add column auth_user_id uuid unique references auth.users(id) on delete set null;

create table public.pheme_invites (
  code_hash text primary key,
  note text,
  created_at timestamptz not null default now(),
  used_by text references public.pheme_users(id),
  used_at timestamptz
);
alter table public.pheme_invites enable row level security;
revoke all on public.pheme_invites from anon, authenticated;

create function public.pheme_create_invite(p_hash text, p_note text) returns jsonb
language plpgsql as $$
begin
  insert into pheme_invites(code_hash, note) values (p_hash, p_note);
  return jsonb_build_object('created', true);
end $$;

create function public.pheme_register(p_auth uuid, p_handle text, p_name text, p_invite_hash text, p_token_hash text) returns jsonb
language plpgsql as $$
begin
  if p_handle !~ '^[a-zA-Z0-9_-]{1,80}$' then raise exception 'pheme:400:Handle must be 1-80 letters, digits, _ or -'; end if;
  perform pg_advisory_xact_lock(hashtextextended('register:' || p_auth::text, 0));
  if exists (select 1 from pheme_users where auth_user_id = p_auth) then raise exception 'pheme:409:This account is already registered; rotate the token instead'; end if;
  if exists (select 1 from pheme_users where id = p_handle) then raise exception 'pheme:409:Handle is taken'; end if;
  -- Consume the invite first; the whole function rolls back if anything below fails.
  update pheme_invites set used_at = now() where code_hash = p_invite_hash and used_at is null;
  if not found then raise exception 'pheme:403:Invalid or already used invite code'; end if;
  insert into pheme_users(id, name, token_hash, auth_user_id) values (p_handle, p_name, p_token_hash, p_auth);
  update pheme_invites set used_by = p_handle where code_hash = p_invite_hash;
  return jsonb_build_object('id', p_handle, 'name', p_name);
end $$;

create function public.pheme_rotate(p_auth uuid, p_token_hash text) returns jsonb
language plpgsql as $$
declare u pheme_users;
begin
  update pheme_users set token_hash = p_token_hash where auth_user_id = p_auth returning * into u;
  if not found then raise exception 'pheme:404:This account has no Pheme handle; register first'; end if;
  return jsonb_build_object('id', u.id, 'name', u.name);
end $$;

create function public.pheme_me(p_auth uuid) returns jsonb
language plpgsql stable as $$
declare u pheme_users;
begin
  select * into u from pheme_users where auth_user_id = p_auth;
  if not found then raise exception 'pheme:404:This account has no Pheme handle; register first'; end if;
  return jsonb_build_object('id', u.id, 'name', u.name);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
