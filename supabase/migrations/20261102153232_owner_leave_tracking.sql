-- Additive ledger only; do not backfill or rewrite existing requests.
create table private.owner_leave_settings (
 user_id bigint not null references public.app_users(id),
 year integer not null check(year between 1901 and 2199),
 reset text not null,
 total integer not null check(total between 0 and 366),
 primary key(user_id,year)
);
create table private.owner_leave_kinds (
 request_id uuid primary key references public.requests(id) on delete cascade,
 kind text not null check(kind in ('annual','reward'))
);
alter table private.owner_leave_settings enable row level security;
alter table private.owner_leave_kinds enable row level security;
revoke all on private.owner_leave_settings, private.owner_leave_kinds from public,anon,authenticated;

-- Uses the existing PIN session verifier, never a client-supplied account id.
create function private.owner_leave_user(p_token_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s jsonb;
begin
 s:=public.app_session_verify(p_token_hash);
 if s->>'status' is distinct from 'ok' then return jsonb_build_object('status','invalid');end if;
 if s->'user'->>'id' is distinct from '29' or s->'user'->>'is_active' is distinct from 'true' then
  return jsonb_build_object('status','forbidden');end if;
 return s;
end $$;
revoke all on function private.owner_leave_user(text) from public,anon,authenticated;

create function public.app_session_leave_settings(p_token_hash text,p_year integer,p_reset text,p_total integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; d date;
begin
 s:=private.owner_leave_user(p_token_hash);if s->>'status'<>'ok' then return s;end if;
 if p_year is null or p_year not between 1901 and 2199 or p_total is null or p_total not between 0 and 366
 or p_reset is null or p_reset !~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' or p_reset='02-29'
 then return jsonb_build_object('status','bad_input');end if;
 begin d:=(p_year||'-'||p_reset)::date;
 exception when datetime_field_overflow or invalid_datetime_format then return jsonb_build_object('status','bad_input');end;
 insert into private.owner_leave_settings(user_id,year,reset,total) values(29,p_year,p_reset,p_total)
 on conflict(user_id,year) do update set reset=excluded.reset,total=excluded.total;
 return jsonb_build_object('status','ok');
end $$;

create function public.app_session_leave_read(p_token_hash text,p_year integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; rows jsonb; settings jsonb;
begin
 s:=private.owner_leave_user(p_token_hash);if s->>'status'<>'ok' then return s;end if;
 if p_year is null or p_year not between 1901 and 2199 then return jsonb_build_object('status','bad_input');end if;
 select jsonb_build_object('reset',x.reset,'total',x.total) into settings from private.owner_leave_settings x where user_id=29 and year=p_year;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'shift_date',r.shift_date,'reason',r.reason,'request_kind',r.request_kind,'leave_kind',k.kind) order by r.shift_date,r.id),'[]'::jsonb)
 into rows from public.requests r left join private.owner_leave_kinds k on k.request_id=r.id
 where r.shift_date>=make_date(p_year-1,1,1) and r.shift_date<make_date(p_year+2,1,1)
 and (r.requested_by_id=29 or (r.requested_by_id is null and r.requested_by=s->'user'->>'name' and r.team=s->'user'->>'team'
 and (select count(*) from public.app_users u where u.name=r.requested_by and u.team=r.team)=1))
 and r.request_kind is distinct from 'support' and coalesce(r.reason,'') !~ '정수|지원' and r.requested_by not like '%조 공석';
 return jsonb_build_object('status','ok','rows',rows,'settings',settings);
end $$;

create function public.app_session_leave_classify(p_token_hash text,p_request_id uuid,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; r public.requests%rowtype;
begin
 s:=private.owner_leave_user(p_token_hash);if s->>'status'<>'ok' then return s;end if;
 if p_kind is null or p_kind not in ('annual','reward') then return jsonb_build_object('status','bad_input');end if;
 select * into r from public.requests where id=p_request_id for update;
 if not found then return jsonb_build_object('status','not_found');end if;
 if (r.requested_by_id=29 or (r.requested_by_id is null and r.requested_by=s->'user'->>'name' and r.team=s->'user'->>'team'
 and (select count(*) from public.app_users u where u.name=r.requested_by and u.team=r.team)=1)) is distinct from true
 or r.requested_by like '%조 공석' or r.request_kind='support' or regexp_replace(coalesce(r.reason,''),'\s','','g') ~ '정수|지원|청원휴가|건강검진휴가'
 then return jsonb_build_object('status','forbidden');end if;
 insert into private.owner_leave_kinds(request_id,kind) values(p_request_id,p_kind)
 on conflict(request_id) do update set kind=excluded.kind;
 return jsonb_build_object('status','ok');
end $$;

-- A wrapper keeps existing registration, duplicate checks, history and push intact.
-- Registration and the new ledger entry commit or roll back together.
create function public.app_session_leave_create(p_token_hash text,p_action text,p_team text,p_date date,p_reason text,p_filled_by text,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; result jsonb;
begin
 s:=private.owner_leave_user(p_token_hash);if s->>'status'<>'ok' then return s;end if;
 if p_action is distinct from 'request_create' or p_kind is null or p_kind not in ('annual','reward')
 or regexp_replace(coalesce(p_reason,''),'\s','','g') ~ '정수|지원|청원휴가|건강검진휴가'
 then return jsonb_build_object('status','bad_input');end if;
 result:=public.app_session_request_create(p_token_hash,p_action,p_team,p_date,p_reason,p_filled_by);
 if result->>'status'='ok' then
  insert into private.owner_leave_kinds(request_id,kind) values((result->>'request_id')::uuid,p_kind);
 end if;
 return result;
end $$;

revoke all on function public.app_session_leave_settings(text,integer,text,integer),public.app_session_leave_read(text,integer),public.app_session_leave_classify(text,uuid,text),public.app_session_leave_create(text,text,text,date,text,text,text) from public,anon,authenticated;
grant execute on function public.app_session_leave_settings(text,integer,text,integer),public.app_session_leave_read(text,integer),public.app_session_leave_classify(text,uuid,text),public.app_session_leave_create(text,text,text,date,text,text,text) to service_role;
