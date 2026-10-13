create function public.app_schedule_share_calendar(p_share_hash text,p_month text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.app_users; start_day date; end_day date;
begin
 if p_share_hash is null or p_share_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('status','invalid'); end if;
 select a.* into u from private.schedule_shares s join public.app_users a on a.id=s.user_id where s.token_hash=p_share_hash and s.revoked_at is null and a.is_active;
 if not found then return jsonb_build_object('status','invalid'); end if;
 if p_month is null or p_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then return jsonb_build_object('status','bad_input'); end if;
 start_day:=(p_month||'-01')::date-7;end_day:=(p_month||'-01')::date+interval '1 month 7 days';
 return jsonb_build_object('status','ok','name',u.name,'team',u.team,
 'requests',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'requested_by',r.requested_by,'requested_by_id',r.requested_by_id,'team',r.team,'shift_type',r.shift_type,'shift_date',r.shift_date,'filled_by',r.filled_by,'filled_by_id',r.filled_by_id,'status',r.status,'reason',r.reason,'request_kind',r.request_kind,'helper_team',coalesce((select a.team from public.app_users a where a.id=r.filled_by_id),(select max(a.team) from public.app_users a where a.name=r.filled_by having count(*)=1))) order by r.shift_date,r.id) from public.requests r where r.shift_date>=start_day and r.shift_date<end_day),'[]'::jsonb),
 'memos',coalesce((select jsonb_agg(jsonb_build_object('date',m.date,'memo',m.memo) order by m.date) from public.daily_memos m where m.date>=start_day and m.date<end_day),'[]'::jsonb));
end $$;
revoke all on function public.app_schedule_share_calendar(text,text) from public,anon,authenticated;
grant execute on function public.app_schedule_share_calendar(text,text) to service_role;