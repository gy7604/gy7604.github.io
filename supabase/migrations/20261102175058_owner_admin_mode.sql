-- Administrative mode is scoped to one verified owner session, never app_users.role.
alter table private.app_sessions add column owner_admin_mode boolean not null default false;

create or replace function public.app_session_verify(p_token_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user jsonb;
begin
 update private.app_sessions as s
 set expires_at='infinity'::timestamptz
 from public.app_users as u
 where s.token_hash=p_token_hash and s.revoked_at is null and s.expires_at>now()
 and u.id=s.user_id and u.is_active and s.credential_version=u.credential_version
 returning jsonb_build_object(
  'id',u.id,'name',u.name,'team',u.team,
  'role',case when u.id=29 and s.owner_admin_mode then 'admin' else u.role end,
  'is_active',u.is_active,'owner_admin_mode',u.id=29 and s.owner_admin_mode
 ) into v_user;
 if v_user is null then return jsonb_build_object('status','invalid');end if;
 return jsonb_build_object('status','ok','expires_at','infinity','user',v_user);
end $$;

create function public.app_session_set_owner_mode(p_token_hash text,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb;
begin
 s:=public.app_session_verify(p_token_hash);
 if s->>'status' is distinct from 'ok' then return jsonb_build_object('status','invalid');end if;
 if s->'user'->>'id' is distinct from '29' then return jsonb_build_object('status','forbidden');end if;
 if p_enabled is null then return jsonb_build_object('status','bad_input');end if;
 update private.app_sessions set owner_admin_mode=p_enabled where token_hash=p_token_hash;
 return public.app_session_verify(p_token_hash);
end $$;

revoke all on function public.app_session_verify(text),public.app_session_set_owner_mode(text,boolean) from public,anon,authenticated;
grant execute on function public.app_session_verify(text),public.app_session_set_owner_mode(text,boolean) to service_role;
