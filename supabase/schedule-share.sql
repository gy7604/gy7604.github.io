create table private.schedule_shares (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
 user_id bigint not null references public.app_users(id),
 created_at timestamptz not null default now(),
 revoked_at timestamptz
);
alter table private.schedule_shares enable row level security;
revoke all on private.schedule_shares from public,anon,authenticated;
create function public.app_schedule_share(p_action text,p_session_hash text default null,p_share_hash text default null,p_month text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; uid bigint; u public.app_users; first_day date;
begin
 if p_action in ('issue','revoke','status') then
  s:=public.app_session_verify(p_session_hash);
  if s->>'status' is distinct from 'ok' then return jsonb_build_object('status','invalid'); end if;
  uid:=(s->'user'->>'id')::bigint;
  if uid<>29 then return jsonb_build_object('status','invalid'); end if;
  if p_action='status' then return jsonb_build_object('status','ok','enabled',exists(select 1 from private.schedule_shares where user_id=uid and revoked_at is null)); end if;
  if p_action='issue' and (p_share_hash is null or p_share_hash !~ '^[0-9a-f]{64}$') then return jsonb_build_object('status','bad_input'); end if;
  update private.schedule_shares set revoked_at=now() where user_id=uid and revoked_at is null;
  if p_action='issue' then insert into private.schedule_shares(token_hash,user_id) values(p_share_hash,uid); end if;
  return jsonb_build_object('status','ok');
 elsif p_action='read' then
  if p_share_hash is null or p_share_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('status','invalid'); end if;
  select a.* into u from private.schedule_shares sh join public.app_users a on a.id=sh.user_id where sh.token_hash=p_share_hash and sh.revoked_at is null and a.is_active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if p_month is null or p_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then return jsonb_build_object('status','bad_input'); end if;
  first_day:=(p_month||'-01')::date;
  return jsonb_build_object('status','ok','name',u.name,'team',u.team,'month',p_month,'requests',coalesce((
   select jsonb_agg(jsonb_build_object('date',r.shift_date,'shift',r.shift_type,
    'off',r.request_kind='off' and (r.requested_by_id=u.id or (r.requested_by_id is null and r.requested_by=u.name and (select count(*) from public.app_users a where a.name=u.name)=1)),
    'substitute',r.status='FILLED' and (r.filled_by_id=u.id or (r.filled_by_id is null and r.filled_by=u.name and (select count(*) from public.app_users a where a.name=u.name)=1))))
   from public.requests r where r.shift_date>=first_day and r.shift_date<first_day+interval '1 month' and
   (r.requested_by_id=u.id or r.filled_by_id=u.id or (r.requested_by_id is null and r.requested_by=u.name) or (r.filled_by_id is null and r.filled_by=u.name))
  ),'[]'::jsonb));
 end if;
 return jsonb_build_object('status','bad_input');
end $$;
revoke all on function public.app_schedule_share(text,text,text,text) from public,anon,authenticated;
grant execute on function public.app_schedule_share(text,text,text,text) to service_role;