-- Isolated PostgreSQL fixture, never run on a live database.
-- Load this file up to APPLY_MIGRATION_HERE, the admin_free_text_helper
-- migration, then the assertions below the marker. No production data needed.
create role anon; create role authenticated; create role service_role;
create schema private;
create table public.app_users(id bigint primary key,name text,team text,role text,is_active boolean);
insert into public.app_users values
 (1,'Admin','B','admin',true),(2,'Manager','C','team_admin',true),
 (3,'Regular','C','user',true),(4,'SameTeam','A','user',true),
 (5,'Employee','C','user',true),(6,'Shared','C','user',true),
 (7,'Shared','D','user',true),(8,'Inactive','B','user',false),(9,'Viewer','B','viewer',true);
create table public.requests(
 id uuid primary key default gen_random_uuid(),requested_by text not null,
 requested_by_id bigint references public.app_users(id),request_kind text not null default 'off',
 team text not null,shift_type text not null,shift_date date not null,reason text,status text,
 filled_by text,filled_by_id bigint references public.app_users(id)
);
create function public.app_session_verify(t text) returns jsonb language sql as $$
 select coalesce((select jsonb_build_object('status','ok','user',to_jsonb(u)) from public.app_users u
 where u.id=case t when 'admin' then 1 when 'manager' then 2 when 'user' then 3 when 'viewer' then 9 end and u.is_active),
 jsonb_build_object('status','invalid'))
$$;
create function public._shift_for_team(text,date) returns text language sql as $$
 select case $1 when 'C' then '휴무' when 'D' then '야간' else '주간' end::text
$$;
create function public._suggested_helper_team(text,text,date) returns text language sql as $$select 'C조'::text$$;

-- APPLY_MIGRATION_HERE

do $$
declare r jsonb; rid uuid; other_id uuid; text_name text:='External <test> (Day)'; n integer; v text;
begin
 insert into public.requests(requested_by,requested_by_id,team,shift_type,shift_date,reason,status)
 values('Regular',3,'A','주간','2026-11-03','off','OPEN') returning id into rid;
 r:=public.app_session_request_update('admin','sub_register',rid,'  '||text_name||'  ');
 assert r->>'status'='ok','admin assigns text to existing request';
 assert (select filled_by=text_name and filled_by_id is null and status='FILLED' from public.requests where id=rid),'literal name is trimmed and saved without an account';
 assert (select count(*)=9 from public.app_users),'no user account is created';
 r:=public.app_session_request_update('admin','sub_register',rid,text_name);
 assert r->>'status'='ok','same request can retain the same helper';
 r:=public.app_session_request_create('admin','vacancy_create','B','2026-11-03','',nullif(text_name,''));
 assert r->>'status'='helper_busy','text-only helper cannot fill two slots on the same date and shift';
 r:=public.app_session_request_create('admin','vacancy_create','A','2026-11-04','',text_name);
 assert r->>'status'='ok','admin assigns text to new vacancy';
 other_id:=(r->>'request_id')::uuid;
 assert (select filled_by=text_name and filled_by_id is null from public.requests where id=other_id),'vacancy keeps literal text';
 r:=public.app_session_request_update('manager','sub_cancel',rid);
 assert r->>'status'='forbidden','team admin cannot cancel an unknown helper';
 r:=public.app_session_request_update('user','sub_cancel',rid);
 assert r->>'status'='forbidden','regular user cannot cancel someone else';
 r:=public.app_session_request_update('admin','sub_cancel',rid);
 assert r->>'status'='ok','admin can cancel a text-only helper';
 assert (select filled_by is null and filled_by_id is null and status='OPEN' from public.requests where id=rid),'cancel clears both helper fields';
 r:=public.app_session_request_update('admin','sub_register',rid,'Employee');
 assert r->>'status'='ok','known employee still works';
 assert (select filled_by_id=5 from public.requests where id=rid),'unique active account is linked';
 r:=public.app_session_request_create('admin','vacancy_create','B','2026-11-03','','Employee');
 assert r->>'status'='helper_busy','duplicate known employee stays blocked';
 r:=public.app_session_request_update('admin','sub_register',rid,'Shared');
 assert r->>'status'='ok','admin accepts an ambiguous name as text';
 assert (select filled_by_id is null from public.requests where id=rid),'ambiguous name never links an arbitrary account';
 r:=public.app_session_request_update('admin','sub_register',rid,'Inactive');
 assert r->>'status'='ok','inactive name is accepted as literal text';
 assert (select filled_by_id is null from public.requests where id=rid),'inactive account is not linked';
 r:=public.app_session_request_update('admin','sub_register',rid,'SameTeam');
 assert r->>'status'='ok','superadmin can override helper team eligibility';
 assert (select filled_by_id=4 from public.requests where id=rid),'override still links a known employee';
 -- Existing team-admin restrictions apply in both registration paths.
 r:=public.app_session_request_update('manager','sub_register',rid,'NotRegistered');
 assert r->>'status'='bad_input','manager still needs a registered employee';
 r:=public.app_session_request_create('manager','vacancy_create','A','2026-11-06','','NotRegistered');
 assert r->>'status'='bad_input','manager cannot use vacancy creation to bypass lookup';
 r:=public.app_session_request_update('manager','sub_register',rid,'SameTeam');
 assert r->>'status'='forbidden','manager can only assign own team';
 r:=public.app_session_request_update('manager','sub_register',rid,'Employee');
 assert r->>'status'='ok','eligible employee from own team still works';
 r:=public.app_session_request_create('manager','vacancy_create','A','2026-11-07','','Employee');
 assert r->>'status'='ok','manager vacancy assignment still works';
 -- A normal user cannot impersonate the supplied name.
 r:=public.app_session_request_create('user','vacancy_create','A','2026-11-08','','NotRegistered');
 assert r->>'status'='ok','regular user can register themselves';
 assert (select filled_by='Regular' and filled_by_id=3 from public.requests where id=(r->>'request_id')::uuid),'supplied name is ignored for regular users';
 r:=public.app_session_request_create('user','vacancy_create','C','2026-11-08','','Anything');
 assert r->>'status' in ('bad_input','forbidden'),'regular same-team registration stays blocked';
 -- Direct API requests cannot bypass blank/length checks or roles.
 foreach v in array array[null::text,'', '   ', E'\t\n',repeat('x',201)] loop
  r:=public.app_session_request_update('admin','sub_register',rid,v);
  assert r->>'status'='bad_input','invalid name rejected on existing request';
  r:=public.app_session_request_create('admin','vacancy_create','A','2026-11-10','',v);
  assert r->>'status'='bad_input','invalid name rejected on vacancy';
 end loop;
 r:=public.app_session_request_update('viewer','sub_register',rid,'Anything');
 assert r->>'status'='forbidden','read-only role cannot assign';
 r:=public.app_session_request_update('invalid','sub_register',rid,'Anything');
 assert r->>'status'='invalid','invalid session rejected';
 r:=public.app_session_request_create('admin','request_create','A','2026-11-11','off',null);
 assert r->>'status'='ok','ordinary leave request creation preserved';
 assert not has_function_privilege('anon','public.app_session_request_create(text,text,text,date,text,text)','EXECUTE'),'no anonymous RPC access';
 assert not has_function_privilege('authenticated','public.app_session_request_update(text,text,uuid,text)','EXECUTE'),'no direct signed-in RPC access';
 assert has_function_privilege('service_role','public.app_session_request_update(text,text,uuid,text)','EXECUTE'),'server role retains access';
end $$;
