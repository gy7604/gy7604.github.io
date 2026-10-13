create function public.app_session_login_guard(p_lookup_hash text,p_peer_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare b text; n integer; cap integer;
begin
 if p_lookup_hash !~ '^[0-9a-f]{64}$' or p_peer_hash !~ '^[0-9a-f]{64}$' or p_lookup_hash is null or p_peer_hash is null then return jsonb_build_object('status','invalid'); end if;
 foreach b in array array['code:'||p_lookup_hash,'peer:'||p_peer_hash] loop
  cap:=case when b like 'code:%' then 30 else 120 end;
  insert into private.app_login_limits(bucket,window_start,attempts) values(b,now(),1)
  on conflict(bucket) do update set attempts=case when private.app_login_limits.window_start<=now()-interval '1 minute' then 1 else private.app_login_limits.attempts+1 end,
  window_start=case when private.app_login_limits.window_start<=now()-interval '1 minute' then now() else private.app_login_limits.window_start end returning attempts into n;
  if n>cap then return jsonb_build_object('status','rate_limited'); end if;
 end loop;
 return jsonb_build_object('status','ok');
end $$;
revoke all on function public.app_session_login_guard(text,text) from public,anon,authenticated;
grant execute on function public.app_session_login_guard(text,text) to service_role;

CREATE OR REPLACE FUNCTION public.app_session_login_fast(p_code text, p_token_hash text, p_lookup_hash text, p_lookup_key_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE u public.app_users%rowtype; matches bigint[]; k text; attempts integer; code text:=btrim(p_code);
BEGIN
 IF code IS NULL OR code='' OR length(code)>200 OR octet_length(code)>72
 OR p_lookup_hash IS NULL OR p_lookup_hash !~ '^[0-9a-f]{64}$' OR p_lookup_key_id IS NULL OR p_lookup_key_id !~ '^[0-9a-f]{64}$'
 OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 -- The HMAC key stays in Edge Function environment variables, never in this table.
 SELECT a.* INTO u FROM private.app_code_lookup l JOIN public.app_users a ON a.id=l.user_id
 WHERE l.lookup_key_id=p_lookup_key_id AND l.lookup_hash=p_lookup_hash
 AND l.credential_version=a.credential_version AND a.is_active;
 IF FOUND THEN
  SELECT * INTO u FROM public.app_users WHERE id=u.id FOR UPDATE;
  IF NOT u.is_active OR NOT private.app_code_matches(code,u.login_code_hash)
  THEN RETURN jsonb_build_object('status','invalid'); END IF;
 ELSE
  -- Cold accounts and key rotations keep working through the bcrypt path.
  SELECT array_agg(a.id) INTO matches FROM public.app_users a
  WHERE a.is_active AND NOT EXISTS(SELECT 1 FROM private.app_code_lookup l
   WHERE l.user_id=a.id AND l.lookup_key_id=p_lookup_key_id AND l.credential_version=a.credential_version)
  AND private.app_code_matches(code,a.login_code_hash);
  IF cardinality(matches) IS DISTINCT FROM 1 THEN RETURN jsonb_build_object('status','invalid'); END IF;
  SELECT * INTO u FROM public.app_users WHERE id=matches[1] FOR UPDATE;
  IF NOT u.is_active OR NOT private.app_code_matches(code,u.login_code_hash)
  THEN RETURN jsonb_build_object('status','invalid'); END IF;
 END IF;
 INSERT INTO private.app_code_lookup(user_id,lookup_key_id,lookup_hash,credential_version)
 VALUES(u.id,p_lookup_key_id,p_lookup_hash,u.credential_version)
 ON CONFLICT(user_id) DO UPDATE SET lookup_key_id=EXCLUDED.lookup_key_id,lookup_hash=EXCLUDED.lookup_hash,
 credential_version=EXCLUDED.credential_version,updated_at=now();

 IF code ~ '^[0-9]{4}$' THEN
  INSERT INTO private.app_short_code_upgrade_required(user_id,marked_at) VALUES(u.id,now())
  ON CONFLICT(user_id) DO UPDATE SET marked_at=EXCLUDED.marked_at;
  RETURN jsonb_build_object('status','upgrade_required');
 END IF;
 DELETE FROM private.app_passkey_code_recheck WHERE user_id=u.id;
 DELETE FROM private.app_login_limits WHERE window_start<now()-interval '1 day';
 DELETE FROM private.app_sessions WHERE expires_at<now()-interval '1 day';
 INSERT INTO private.app_sessions(token_hash,user_id,credential_version,expires_at)
 VALUES(p_token_hash,u.id,u.credential_version,now()+interval '8 hours');
 RETURN jsonb_build_object('status','ok','expires_at',now()+interval '8 hours',
 'user',jsonb_build_object('id',u.id,'name',u.name,'team',u.team,'role',u.role,'is_active',u.is_active));
END $function$

;
CREATE OR REPLACE FUNCTION public.upsert_push_subscription(p_user_id bigint, p_user_name text, p_subscription jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_endpoint text;
  v_existing_id bigint;
begin
  if p_user_id is null or p_user_name is null or btrim(p_user_name) = '' or p_subscription is null then
    raise exception 'invalid push subscription input';
  end if;

  if not exists (
    select 1
    from public.app_users u
    where u.id = p_user_id
      and u.name = p_user_name
      and u.is_active = true
  ) then
    raise exception 'invalid active user';
  end if;

  v_endpoint := p_subscription ->> 'endpoint';
  if v_endpoint is null or btrim(v_endpoint) = '' then
    raise exception 'push endpoint is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('push:'||p_user_id||':'||v_endpoint,0));

  select ps.id
    into v_existing_id
  from public.push_subscriptions ps
  where ps.user_id = p_user_id
    and ps.subscription ->> 'endpoint' = v_endpoint
  order by ps.id
  limit 1;

  if v_existing_id is not null then
    update public.push_subscriptions
    set user_name = p_user_name,
        subscription = p_subscription,
        updated_at = now()
    where id = v_existing_id;
  else
    insert into public.push_subscriptions(user_id, user_name, subscription, updated_at)
    values (p_user_id, p_user_name, p_subscription, now());
  end if;
end;
$function$

;
create table private.app_push_preferences(user_id bigint not null references public.app_users(id),endpoint text not null,enabled boolean not null,updated_at timestamptz not null default now(),primary key(user_id,endpoint));
alter table private.app_push_preferences enable row level security;
revoke all on private.app_push_preferences from public,anon,authenticated;
create function public.app_session_push_v2(p_token_hash text,p_action text,p_subscription jsonb default null,p_endpoint text default null,p_explicit_enable boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; uid bigint; name text; v_endpoint text; enabled boolean;
begin
 s:=public.app_session_verify(p_token_hash);if s->>'status' is distinct from 'ok' then return jsonb_build_object('status','invalid');end if;
 uid:=(s->'user'->>'id')::bigint;name:=s->'user'->>'name';
 v_endpoint:=case when p_action='push_upsert' then p_subscription->>'endpoint' else p_endpoint end;
 if v_endpoint is null or length(v_endpoint)>4096 or not private.app_push_endpoint_allowed(v_endpoint) then return jsonb_build_object('status','bad_input');end if;
 if p_action='push_status' then
  select p.enabled into enabled from private.app_push_preferences p where p.user_id=uid and p.endpoint=v_endpoint;
  return jsonb_build_object('status','ok','disabled',enabled is false,'registered',coalesce(enabled,true) and exists(select 1 from public.push_subscriptions ps where ps.user_id=uid and ps.subscription->>'endpoint'=v_endpoint));
 end if;
 perform pg_advisory_xact_lock(hashtextextended('push:'||uid||':'||v_endpoint,0));
 if p_action='push_delete' then
  insert into private.app_push_preferences(user_id,endpoint,enabled) values(uid,v_endpoint,false) on conflict(user_id,endpoint) do update set enabled=false,updated_at=now();
  perform public.delete_push_subscription(uid,v_endpoint);
 elsif p_action='push_upsert' then
  if p_subscription is null or jsonb_typeof(p_subscription)<>'object' then return jsonb_build_object('status','bad_input');end if;
  select p.enabled into enabled from private.app_push_preferences p where p.user_id=uid and p.endpoint=v_endpoint;
  if enabled is false and not coalesce(p_explicit_enable,false) then return jsonb_build_object('status','disabled');end if;
  insert into private.app_push_preferences(user_id,endpoint,enabled) values(uid,v_endpoint,true) on conflict(user_id,endpoint) do update set enabled=true,updated_at=now();
  perform public.upsert_push_subscription(uid,name,p_subscription);
 else return jsonb_build_object('status','bad_input');end if;
 return jsonb_build_object('status','ok');
end $$;
revoke all on function public.app_session_push_v2(text,text,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.app_session_push_v2(text,text,jsonb,text,boolean) to service_role;
create or replace function public.app_session_push(p_token_hash text,p_action text,p_subscription jsonb default null,p_endpoint text default null) returns jsonb language sql security definer set search_path='' as $$ select public.app_session_push_v2(p_token_hash,p_action,p_subscription,p_endpoint,false) $$;
create function public.app_push_delivery_targets(p_user_ids bigint[]) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb) from (
  select distinct on (ps.subscription->>'endpoint') ps.id,ps.user_id,ps.user_name,ps.subscription
  from public.push_subscriptions ps where ps.user_id=any(p_user_ids) and not exists(select 1 from private.app_push_preferences p where p.user_id=ps.user_id and p.endpoint=ps.subscription->>'endpoint' and not p.enabled)
  order by ps.subscription->>'endpoint',ps.updated_at desc,ps.id desc
 ) d
$$;
revoke all on function public.app_push_delivery_targets(bigint[]) from public,anon,authenticated;
grant execute on function public.app_push_delivery_targets(bigint[]) to service_role;
