-- Isolated database only. Load fixture, admin_free_text_helper migration,
-- owner_admin_mode migration, then assertions after APPLY_MIGRATIONS_HERE.
create role anon;create role authenticated;create role service_role;
create schema private;
create table public.app_users(id bigint primary key,name text,team text,role text,is_active boolean,credential_version bigint not null default 1);
insert into public.app_users(id,name,team,role,is_active) values
 (29,'Owner','B','user',true),(30,'Other','C','user',true),(7,'Admin','B','admin',true),(31,'Inactive','C','user',false);
create table private.app_sessions(token_hash text primary key,user_id bigint references public.app_users(id),created_at timestamptz not null default now(),expires_at timestamptz not null,revoked_at timestamptz,credential_version bigint not null);
insert into private.app_sessions(token_hash,user_id,expires_at,credential_version) values
 ('owner',29,now()+interval '1 hour',1),('second',29,now()+interval '1 hour',1),
 ('other',30,now()+interval '1 hour',1),('admin',7,now()+interval '1 hour',1),
 ('inactive',31,now()+interval '1 hour',1),('old-code',29,now()+interval '1 hour',0),('expired',29,now()-interval '1 hour',1);
create table public.requests(id uuid primary key default gen_random_uuid(),requested_by text,requested_by_id bigint,request_kind text default 'off',team text,shift_type text,shift_date date,reason text,status text,filled_by text,filled_by_id bigint);
create function public._shift_for_team(text,date) returns text language sql as $$select '주간'::text$$;
create function public._suggested_helper_team(text,text,date) returns text language sql as $$select 'C조'::text$$;
-- APPLY_MIGRATIONS_HERE
do $$
declare s jsonb;rid uuid;t text;
begin
 s:=public.app_session_verify('owner');assert s->'user'->>'role'='user','owner starts as regular user';
 assert s->'user'->>'owner_admin_mode'='false','existing sessions default to normal';
 s:=public.app_session_set_owner_mode('owner',true);
 assert s->>'status'='ok' and s->'user'->>'role'='admin' and s->'user'->>'owner_admin_mode'='true','owner can enter admin mode';
 assert (s->'user'->>'id')::int=29 and s->'user'->>'name'='Owner','identity stays with owner';
 assert (select role='user' from public.app_users where id=29),'account role is unchanged';
 assert public.app_session_verify('second')->'user'->>'role'='user','another session is not elevated';
 s:=public.app_session_request_create('owner','vacancy_create','A','2026-11-03','','Outside');
 assert s->>'status'='ok','elevated owner can perform a real admin-only assignment';
 rid:=(s->>'request_id')::uuid;
 assert current_setting('app.audit_actor_id')='29','admin action records owner identity';
 assert (select filled_by='Outside' and filled_by_id is null from public.requests where id=rid),'new admin mode supports free text';
 s:=public.app_session_set_owner_mode('owner',false);
 assert s->>'status'='ok' and s->'user'->>'role'='user','owner can leave admin mode';
 s:=public.app_session_request_update('owner','sub_register',rid,'Another outside');
 assert s->>'status' in ('conflict','forbidden'),'normal user cannot overwrite as admin';
 assert (select filled_by='Outside' from public.requests where id=rid),'failed normal-mode action preserves request';
 foreach t in array array['other','admin'] loop
  s:=public.app_session_set_owner_mode(t,true);assert s->>'status'='forbidden','only owner may use endpoint';
 end loop;
 foreach t in array array['inactive','old-code','expired','invalid'] loop
  s:=public.app_session_set_owner_mode(t,true);assert s->>'status'='invalid','inactive, changed-code, expired and invalid sessions denied';
 end loop;
 s:=public.app_session_set_owner_mode('owner',null);assert s->>'status'='bad_input','enabled flag required';
 update private.app_sessions set owner_admin_mode=true where token_hash='other';
 s:=public.app_session_verify('other');assert s->'user'->>'role'='user' and s->'user'->>'owner_admin_mode'='false','mode flag on another account never elevates';
 s:=public.app_session_verify('admin');assert s->'user'->>'role'='admin','native superadmin login remains supported';
 s:=public.app_session_set_owner_mode('owner',true);assert s->>'status'='ok';
 update private.app_sessions set revoked_at=now() where token_hash='owner';
 s:=public.app_session_verify('owner');assert s->>'status'='invalid','revocation also removes admin access';
 insert into private.app_sessions(token_hash,user_id,expires_at,credential_version) values('new-login',29,now()+interval '1 hour',1);
 s:=public.app_session_verify('new-login');assert s->'user'->>'role'='user' and s->'user'->>'owner_admin_mode'='false','fresh login starts in normal mode';
 assert not has_function_privilege('anon','public.app_session_set_owner_mode(text,boolean)','EXECUTE'),'no anonymous RPC access';
 assert not has_function_privilege('authenticated','public.app_session_set_owner_mode(text,boolean)','EXECUTE'),'no bypass via standard signed-in RPC';
 assert has_function_privilege('service_role','public.app_session_set_owner_mode(text,boolean)','EXECUTE'),'only server can invoke mode RPC';
end $$;
