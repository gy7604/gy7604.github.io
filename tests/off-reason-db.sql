-- Synthetic test records only. Run after the admin-helper fixture, owner-leave
-- migration and prevent_own_name_in_off_reason migration in an isolated database.
insert into public.app_users values(29,'가상소유자','B','user',true);
update public.app_users set name='가상사용자' where id=1;
update public.app_users set name='가상일반',team='A' where id=3;
create or replace function public.app_session_verify(t text) returns jsonb language sql as $$
 select coalesce((select jsonb_build_object('status','ok','user',to_jsonb(u)) from public.app_users u
 where u.id=case t when 'admin' then 1 when 'manager' then 2 when 'user' then 3 when 'viewer' then 9 when 'owner' then 29 end and u.is_active),
 jsonb_build_object('status','invalid'))
$$;
create table private.fixture_events(kind text,request_id uuid);
create function private.fixture_record_insert() returns trigger language plpgsql as $$
begin insert into private.fixture_events values('audit',NEW.id),('notification',NEW.id);return NEW;end $$;
create trigger fixture_insert after insert on public.requests for each row execute function private.fixture_record_insert();
create table private.fixture_legacy as select * from public.requests limit 0;
with old as (
 insert into public.requests(requested_by,requested_by_id,team,shift_type,shift_date,reason,status,filled_by,filled_by_id)
 values('가상사용자',1,'B','주간','2026-10-01','가상사용자/기존 기록','FILLED','Employee',5) returning *
) insert into private.fixture_legacy select * from old;

do $$
declare r jsonb; candidate_reason text; before_rows bigint; before_events bigint; rid uuid;
begin
 select count(*) into before_rows from public.requests;
 select count(*) into before_events from private.fixture_events;
 foreach candidate_reason in array array['가상사용자','가상사용자/검진','검진 (가상사용자)','가 상 사 용 자',
 E'가상\n사용자',U&'가상\200B사용자',U&'가상\2060사용자',normalize('가상사용자',NFD),'가상사용자 지원'] loop
  r:=public.app_session_request_create('admin','request_create','B','2026-11-13',candidate_reason,null);
  assert r->>'status'='reason_contains_name','direct API rejects own name before inserting a request';
 end loop;
 r:=public.app_session_request_create('user','request_create','A','2026-11-14','가상일반/검진',null);
 assert r->>'status'='reason_contains_name','ordinary user self name rejected';
 r:=public.app_session_leave_create('owner','request_create','B','2026-11-15','가상소유자/개인사정',null,'annual');
 assert r->>'status'='reason_contains_name','annual leave wrapper cannot bypass the guard';
 r:=public.app_session_leave_create('owner','request_create','B','2026-11-16','가상 소유자',null,'reward');
 assert r->>'status'='reason_contains_name','reward leave wrapper cannot bypass the guard';
 assert (select count(*)=before_rows from public.requests),'rejected requests create no records';
 assert (select count(*)=before_events from private.fixture_events),'rejected requests create no audit or notification events';
 assert (select count(*)=0 from private.owner_leave_kinds),'rejected requests create no leave ledger record';

 r:=public.app_session_request_create('admin','request_create','B','2026-11-17','',null);
 assert r->>'status'='ok','reasonless registration works';
 rid:=(r->>'request_id')::uuid;
 assert (select requested_by='가상사용자' and requested_by_id=1 and reason='' and request_kind='off' from public.requests where id=rid),'server still supplies the applicant identity';
 r:=public.app_session_request_create('admin','request_create','B','2026-11-18','검진',null);
 assert r->>'status'='ok','ordinary reason works';
 r:=public.app_session_request_create('admin','request_create','B','2026-11-18','검진',null);
 assert r->>'status'='duplicate','duplicate protection stays intact';
 r:=public.app_session_request_create('admin','request_create','B','2026-11-19','정수 지원',null);
 assert r->>'status'='ok','support reason works';
 assert (select request_kind='support' from public.requests where id=(r->>'request_id')::uuid),'support classification preserved';
 r:=public.app_session_request_create('admin','request_create','B','2026-11-20','사용자',null);
 assert r->>'status'='ok','partial names are not mistaken for a full own name';
 r:=public.app_session_request_create('admin','request_create','B','2026-11-21','다른사용자 병원동행',null);
 assert r->>'status'='ok','does not consult or expose a personnel directory';

 r:=public.app_session_leave_create('owner','request_create','B','2026-11-22','개인사정',null,'annual');
 assert r->>'status'='ok','owner annual leave still works';
 assert (select kind='annual' from private.owner_leave_kinds where request_id=(r->>'request_id')::uuid),'annual classification preserved';
 r:=public.app_session_leave_create('owner','request_create','B','2026-11-23','',null,'reward');
 assert r->>'status'='ok','owner reasonless reward leave still works';
 assert (select kind='reward' from private.owner_leave_kinds where request_id=(r->>'request_id')::uuid),'reward classification preserved';
 r:=public.app_session_request_create('user','request_create','A','2026-11-24',null,null);
 assert r->>'status'='ok','null reason remains optional';
 r:=public.app_session_request_create('admin','vacancy_create','A','2026-11-25','가상사용자','External <test>');
 assert r->>'status'='ok','vacancy/helper flow stays separate from applicant reason validation';
 assert (select reason='지정 대근' and filled_by='External <test>' from public.requests where id=(r->>'request_id')::uuid),'free-text helper behavior preserved';
 r:=public.app_session_request_create('invalid','request_create','A','2026-11-26','가상사용자',null);
 assert r->>'status'='invalid','invalid sessions rejected first';
 r:=public.app_session_request_create('viewer','request_create','A','2026-11-26','검진',null);
 assert r->>'status'='forbidden','viewer permission stays intact';
 r:=public.app_session_request_create('user','request_create','B','2026-11-26','검진',null);
 assert r->>'status'='forbidden','ordinary users cannot create another team request';
 assert not has_function_privilege('anon','public.app_session_request_create(text,text,text,date,text,text)','EXECUTE'),'no anonymous RPC access';
 assert not has_function_privilege('authenticated','public.app_session_request_create(text,text,text,date,text,text)','EXECUTE'),'no direct authenticated RPC access';
 assert has_function_privilege('service_role','public.app_session_request_create(text,text,text,date,text,text)','EXECUTE'),'server access preserved';
 assert (select bool_and(to_jsonb(existing_request)=to_jsonb(l)) from private.fixture_legacy l join public.requests existing_request on existing_request.id=l.id),'legacy record and helper unchanged';
 assert (select count(*)=10 from public.app_users),'no accounts created or removed by validation';
end $$;

