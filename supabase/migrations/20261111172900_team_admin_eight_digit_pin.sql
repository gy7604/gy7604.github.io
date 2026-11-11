-- Team-admin (A/B/C/D) mandatory PIN rotation. Review-only migration.
-- Apply LAST, after updated app-session, app-passkey Edge Functions and web UI
-- are deployed; applying this to the current server first will lock managers out.
-- Super-admin, general staff and existing leave/push records are not changed.
BEGIN;

CREATE TABLE IF NOT EXISTS private.app_team_admin_pin_upgrade_required (
 user_id bigint PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
 marked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.app_team_admin_pin_upgrade_required ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.app_team_admin_pin_upgrade_required FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.app_valid_team_admin_pin(p_code text)
 RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path TO '' AS $validator$
DECLARE i integer; a integer; b integer; c integer;
BEGIN
 IF p_code IS NULL OR p_code !~ '^[0-9]{8}$' THEN RETURN false; END IF;
 -- Reject 3 consecutive ascending, descending or identical digits, anywhere.
 FOR i IN 1..6 LOOP
  a:=ascii(substr(p_code,i,1)); b:=ascii(substr(p_code,i+1,1)); c:=ascii(substr(p_code,i+2,1));
  IF (b=a+1 AND c=b+1) OR (b=a-1 AND c=b-1) OR (a=b AND b=c) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $validator$;
REVOKE ALL ON FUNCTION private.app_valid_team_admin_pin(text) FROM PUBLIC, anon, authenticated;

-- Enforce upgrade for app_session_login.
CREATE OR REPLACE FUNCTION public.app_session_login(p_code text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE u public.app_users%rowtype; matches bigint[]; k text; attempts integer; code text:=btrim(p_code);
BEGIN
 IF code IS NULL OR code='' OR length(code)>200 OR octet_length(code)>72
 OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 k:='global';
 PERFORM pg_advisory_xact_lock(hashtextextended('app-session:'||k,0));
 INSERT INTO private.app_login_limits(bucket,window_start,attempts) VALUES(k,now(),1)
 ON CONFLICT(bucket) DO UPDATE SET
  attempts=CASE WHEN private.app_login_limits.window_start<=now()-interval '1 minute' THEN 1 ELSE private.app_login_limits.attempts+1 END,
  window_start=CASE WHEN private.app_login_limits.window_start<=now()-interval '1 minute' THEN now() ELSE private.app_login_limits.window_start END
 RETURNING private.app_login_limits.attempts INTO attempts;
 IF attempts>30 THEN RETURN jsonb_build_object('status','rate_limited'); END IF;

 -- Bcrypt checks only: do not create an unsalted, fast-search code digest.
 SELECT array_agg(a.id) INTO matches FROM public.app_users a
 WHERE a.is_active AND private.app_code_matches(code,a.login_code_hash);
 IF cardinality(matches) IS DISTINCT FROM 1 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 SELECT * INTO u FROM public.app_users WHERE id=matches[1] FOR UPDATE;
 IF NOT u.is_active OR NOT private.app_code_matches(code,u.login_code_hash)
 THEN RETURN jsonb_build_object('status','invalid'); END IF;

 IF u.role='team_admin' AND EXISTS(SELECT 1 FROM private.app_team_admin_pin_upgrade_required WHERE user_id=u.id)
 THEN RETURN jsonb_build_object('status','admin_upgrade_required'); END IF;
 DELETE FROM private.app_login_limits WHERE window_start<now()-interval '1 day';
 DELETE FROM private.app_sessions WHERE expires_at<now()-interval '1 day';
 INSERT INTO private.app_sessions(token_hash,user_id,credential_version,expires_at)
 VALUES(p_token_hash,u.id,u.credential_version,now()+interval '8 hours');
 RETURN jsonb_build_object('status','ok','expires_at',now()+interval '8 hours',
 'user',jsonb_build_object('id',u.id,'name',u.name,'team',u.team,'role',u.role,'is_active',u.is_active));
END $function$
;

-- Enforce upgrade for app_session_login_fast.
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
 IF u.role='team_admin' AND EXISTS(SELECT 1 FROM private.app_team_admin_pin_upgrade_required WHERE user_id=u.id)
 THEN RETURN jsonb_build_object('status','admin_upgrade_required'); END IF;
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

-- Enforce upgrade for app_session_verify.
CREATE OR REPLACE FUNCTION public.app_session_verify(p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 IF v_user->>'role'='team_admin' AND EXISTS(SELECT 1 FROM private.app_team_admin_pin_upgrade_required WHERE user_id=(v_user->>'id')::bigint)
 THEN RETURN jsonb_build_object('status','admin_upgrade_required'); END IF;
 return jsonb_build_object('status','ok','expires_at','infinity','user',v_user);
end $function$
;

-- Enforce upgrade for app_session_change_code.
CREATE OR REPLACE FUNCTION public.app_session_change_code(p_token_hash text, p_current_code text, p_new_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE s jsonb; u public.app_users%rowtype; next_code text:=btrim(p_new_code);
 v_month date:=date_trunc('month',now() AT TIME ZONE 'Asia/Seoul')::date; v_count integer; next_version bigint;
BEGIN
 s:=public.app_session_verify(p_token_hash);
 IF s->>'status' IS DISTINCT FROM 'ok' THEN RETURN jsonb_build_object('status','invalid'); END IF;
 PERFORM set_config('app.audit_actor_id',s->'user'->>'id',true);
 PERFORM set_config('app.audit_actor_name',s->'user'->>'name',true);
 -- Serialize code writers so salted hashes still preserve code uniqueness.
 PERFORM pg_advisory_xact_lock(hashtextextended('app-code-write',0));
 SELECT * INTO u FROM public.app_users WHERE id=(s->'user'->>'id')::bigint FOR UPDATE;
 s:=public.app_session_verify(p_token_hash);
 IF s->>'status' IS DISTINCT FROM 'ok' OR NOT u.is_active
 OR NOT private.app_code_matches(btrim(p_current_code),u.login_code_hash)
 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 IF u.role='team_admin' AND NOT private.app_valid_team_admin_pin(next_code)
 THEN RETURN jsonb_build_object('status','admin_pin_invalid'); END IF;
 IF next_code IS NULL OR char_length(next_code)<6 OR char_length(next_code)>50 OR octet_length(next_code)>72 OR p_new_code !~ '^[!-~]{6,50}$'
 OR private.app_code_matches(next_code,u.login_code_hash)
 THEN RETURN jsonb_build_object('status','bad_input'); END IF;
 IF EXISTS(SELECT 1 FROM public.app_users a WHERE private.app_code_matches(next_code,a.login_code_hash))
 THEN RETURN jsonb_build_object('status','duplicate'); END IF;
 SELECT changes INTO v_count FROM private.app_code_change_limits WHERE user_id=u.id AND month=v_month;
 IF coalesce(v_count,0)>=2 AND current_setting('app.force_short_code_upgrade',true) IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('status','rate_limited'); END IF;

 PERFORM set_config('app.credential_event','self_change',true);
 UPDATE public.app_users SET login_code_hash=private.app_hash_code(next_code)
 WHERE id=u.id RETURNING credential_version INTO next_version;
 IF current_setting('app.force_short_code_upgrade',true) IS DISTINCT FROM 'true' THEN
  INSERT INTO private.app_code_change_limits(user_id,month,changes) VALUES(u.id,v_month,1)
  ON CONFLICT(user_id,month) DO UPDATE SET changes=private.app_code_change_limits.changes+1;
 END IF;
 UPDATE private.app_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=u.id AND token_hash<>p_token_hash;
 -- Keep current session for the existing endpoint cleanup/logout flow.
 UPDATE private.app_sessions SET credential_version=next_version WHERE token_hash=p_token_hash;
 DELETE FROM private.app_login_limits WHERE bucket='user:'||u.id;
 RETURN jsonb_build_object('status','ok');
END $function$
;

-- Enforce upgrade for app_session_upgrade_short_code.
CREATE OR REPLACE FUNCTION public.app_session_upgrade_short_code(p_current_code text, p_new_code text, p_token_hash text, p_lookup_hash text, p_lookup_key_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE u public.app_users%rowtype; ids bigint[]; attempts integer; result jsonb; version bigint; expires timestamptz;
BEGIN
 IF p_current_code IS NULL OR p_current_code !~ '^[0-9]{4}$'
 OR p_new_code IS NULL OR char_length(p_new_code)<6 OR char_length(p_new_code)>50
 OR octet_length(p_new_code)>72 OR p_new_code !~ '^[!-~]{6,50}$'
 OR p_new_code IS DISTINCT FROM btrim(p_new_code)
 OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
 OR p_lookup_hash IS NULL OR p_lookup_hash !~ '^[0-9a-f]{64}$'
 OR p_lookup_key_id IS NULL OR p_lookup_key_id !~ '^[0-9a-f]{64}$'
 THEN RETURN jsonb_build_object('status','bad_input'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('app-session:global',0));
 INSERT INTO private.app_login_limits(bucket,window_start,attempts) VALUES('global',now(),1)
 ON CONFLICT(bucket) DO UPDATE SET
  attempts=CASE WHEN private.app_login_limits.window_start<=now()-interval '1 minute' THEN 1 ELSE private.app_login_limits.attempts+1 END,
  window_start=CASE WHEN private.app_login_limits.window_start<=now()-interval '1 minute' THEN now() ELSE private.app_login_limits.window_start END
 RETURNING private.app_login_limits.attempts INTO attempts;
 IF attempts>30 THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('app-code-write',0));
 SELECT array_agg(a.id) INTO ids FROM public.app_users a
 WHERE a.is_active AND private.app_code_matches(p_current_code,a.login_code_hash);
 IF cardinality(ids) IS DISTINCT FROM 1 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 SELECT * INTO u FROM public.app_users WHERE id=ids[1] FOR UPDATE;
 IF u.role='team_admin' AND EXISTS(SELECT 1 FROM private.app_team_admin_pin_upgrade_required WHERE user_id=u.id)
 THEN RETURN jsonb_build_object('status','admin_upgrade_required'); END IF;
 IF NOT EXISTS(SELECT 1 FROM private.app_short_code_upgrade_required WHERE user_id=u.id)
 OR NOT u.is_active OR NOT private.app_code_matches(p_current_code,u.login_code_hash)
 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 IF private.app_code_matches(p_new_code,u.login_code_hash)
 OR EXISTS(SELECT 1 FROM public.app_users a WHERE private.app_code_matches(p_new_code,a.login_code_hash))
 THEN RETURN jsonb_build_object('status','duplicate'); END IF;
 INSERT INTO private.app_sessions(token_hash,user_id,credential_version,expires_at)
 VALUES(p_token_hash,u.id,u.credential_version,now()+interval '8 hours');
 PERFORM set_config('app.force_short_code_upgrade','true',true);
 result:=public.app_session_change_code_fast(p_token_hash,p_current_code,p_new_code,p_lookup_hash,p_lookup_key_id);
 IF result->>'status' IS DISTINCT FROM 'ok' THEN
  DELETE FROM private.app_sessions WHERE token_hash=p_token_hash;
  RETURN result;
 END IF;
 DELETE FROM private.app_short_code_upgrade_required WHERE user_id=u.id;
 DELETE FROM private.app_passkey_code_recheck WHERE user_id=u.id;
 DELETE FROM private.app_login_limits WHERE bucket='user:'||u.id;
 SELECT credential_version INTO version FROM public.app_users WHERE id=u.id;
 SELECT expires_at INTO expires FROM private.app_sessions WHERE token_hash=p_token_hash;
 RETURN jsonb_build_object('status','ok','expires_at',expires,
  'user',jsonb_build_object('id',u.id,'name',u.name,'team',u.team,'role',u.role,'is_active',u.is_active));
END $function$
;

-- Enforce upgrade for app_passkey_access.
CREATE OR REPLACE FUNCTION public.app_passkey_access(p_action text, p_token_hash text DEFAULT NULL::text, p_challenge text DEFAULT NULL::text, p_challenge_id uuid DEFAULT NULL::uuid, p_credential_id text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE s jsonb; uid bigint; u public.app_users%rowtype; c private.app_passkey_challenges%rowtype; k private.app_passkeys%rowtype; rid uuid; old_count bigint; new_count bigint;
BEGIN
 IF p_action IN ('status','register_begin','register_consume','register_finish') THEN
  s:=public.app_session_verify(p_token_hash);
  IF s->>'status' IS DISTINCT FROM 'ok' THEN RETURN jsonb_build_object('status','invalid'); END IF;
  uid:=(s->'user'->>'id')::bigint;
 ELSIF p_action='login_begin' THEN
  SELECT user_id INTO uid FROM private.app_passkeys WHERE credential_id=p_credential_id;
 ELSIF p_action IN ('login_consume','login_finish') THEN
  SELECT user_id INTO uid FROM private.app_passkey_challenges WHERE id=p_challenge_id AND kind='login';
 ELSE RETURN jsonb_build_object('status','bad_input'); END IF;
 IF uid IS NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
 SELECT * INTO u FROM public.app_users WHERE id=uid AND is_active AND role IN ('user','team_admin','admin') FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','invalid'); END IF;
 IF p_action IN ('login_begin','login_consume','login_finish') THEN
  IF u.role='team_admin' AND EXISTS(SELECT 1 FROM private.app_team_admin_pin_upgrade_required WHERE user_id=uid)
  THEN RETURN jsonb_build_object('status','admin_upgrade_required'); END IF;
  IF EXISTS(SELECT 1 FROM private.app_short_code_upgrade_required WHERE user_id=uid) THEN RETURN jsonb_build_object('status','upgrade_required'); END IF;
  IF EXISTS(SELECT 1 FROM private.app_passkey_code_recheck WHERE user_id=uid) THEN RETURN jsonb_build_object('status','code_required'); END IF;
 END IF;
 IF p_action='status' THEN RETURN jsonb_build_object('status','ok','eligible',true,'registered',EXISTS(SELECT 1 FROM private.app_passkeys WHERE user_id=uid AND credential_version=u.credential_version)); END IF;

 IF p_action IN ('register_begin','login_begin') THEN
  IF p_challenge IS NULL OR p_challenge !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN jsonb_build_object('status','bad_input'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey-options:'||uid,0));
  IF (SELECT count(*) FROM private.app_passkey_challenges WHERE user_id=uid AND created_at>now()-interval '1 minute')>=10 THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
  IF p_action='register_begin' THEN
   IF NOT EXISTS(SELECT 1 FROM private.app_sessions WHERE token_hash=p_token_hash AND created_at>now()-interval '15 minutes')
   OR NOT private.app_code_matches(p_payload->>'current_code',u.login_code_hash) THEN RETURN jsonb_build_object('status','reauth'); END IF;
   IF p_payload->>'current_code' ~ '^[0-9]{4}$' THEN
    INSERT INTO private.app_short_code_upgrade_required(user_id,marked_at) VALUES(uid,now())
    ON CONFLICT(user_id) DO UPDATE SET marked_at=EXCLUDED.marked_at;
    RETURN jsonb_build_object('status','upgrade_required');
   END IF;
   DELETE FROM private.app_passkey_code_recheck WHERE user_id=uid;
   IF (SELECT count(*) FROM private.app_passkeys WHERE user_id=uid AND credential_version=u.credential_version)>=10 THEN RETURN jsonb_build_object('status','limit'); END IF;
  ELSE
   SELECT * INTO k FROM private.app_passkeys WHERE credential_id=p_credential_id AND user_id=uid AND credential_version=u.credential_version;
   IF NOT FOUND THEN RETURN jsonb_build_object('status','invalid'); END IF;
  END IF;
  INSERT INTO private.app_passkey_challenges(challenge,kind,user_id,credential_version,session_hash,credential_id)
  VALUES(p_challenge,CASE WHEN p_action='register_begin' THEN 'register' ELSE 'login' END,uid,u.credential_version,CASE WHEN p_action='register_begin' THEN p_token_hash END,p_credential_id) RETURNING id INTO rid;
  RETURN jsonb_build_object('status','ok','challenge_id',rid,'user_id',uid,'user_name',u.name,
   'credentials',coalesce((SELECT jsonb_agg(jsonb_build_object('id',credential_id,'transports',transports)) FROM private.app_passkeys WHERE user_id=uid AND credential_version=u.credential_version),'[]'));
 END IF;

 SELECT * INTO c FROM private.app_passkey_challenges WHERE id=p_challenge_id FOR UPDATE;
 IF NOT FOUND OR c.user_id<>uid OR c.credential_version<>u.credential_version OR c.expires_at<=now()
 OR (p_action LIKE 'register_%' AND (c.kind<>'register' OR c.session_hash IS DISTINCT FROM p_token_hash))
 OR (p_action LIKE 'login_%' AND (c.kind<>'login' OR c.credential_id IS DISTINCT FROM p_credential_id)) THEN RETURN jsonb_build_object('status','invalid'); END IF;
 IF p_action IN ('register_consume','login_consume') THEN
  IF c.used_at IS NOT NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
  UPDATE private.app_passkey_challenges SET used_at=now() WHERE id=c.id;
  IF p_action='register_consume' THEN RETURN jsonb_build_object('status','ok','challenge',c.challenge,'user_id',uid); END IF;
  SELECT * INTO k FROM private.app_passkeys WHERE credential_id=c.credential_id AND credential_version=u.credential_version;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','invalid'); END IF;
  RETURN jsonb_build_object('status','ok','challenge',c.challenge,'credential',to_jsonb(k));
 END IF;
 IF c.used_at IS NULL OR c.finalized_at IS NOT NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
 IF p_action='register_finish' THEN
  IF p_credential_id IS NULL OR length(p_credential_id)>2048 OR p_credential_id !~ '^[A-Za-z0-9_-]+$' OR (p_payload->>'public_key') IS NULL OR length(p_payload->>'public_key')>4096 OR (p_payload->>'public_key') !~ '^[A-Za-z0-9_-]+$' THEN RETURN jsonb_build_object('status','bad_input'); END IF;
  INSERT INTO private.app_passkeys(credential_id,user_id,public_key,counter,transports,credential_version,device_type,backed_up)
  VALUES(p_credential_id,uid,p_payload->>'public_key',(p_payload->>'counter')::bigint,coalesce(p_payload->'transports','[]'),u.credential_version,p_payload->>'device_type',(p_payload->>'backed_up')::boolean)
  ON CONFLICT(credential_id) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','conflict'); END IF;
  UPDATE private.app_passkey_challenges SET finalized_at=now() WHERE id=c.id;
  RETURN jsonb_build_object('status','ok');
 END IF;
 -- Only the Edge Function can call this after WebAuthn signature verification.
 SELECT * INTO k FROM private.app_passkeys WHERE credential_id=p_credential_id AND user_id=uid AND credential_version=u.credential_version FOR UPDATE;
 IF NOT FOUND OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('status','invalid'); END IF;
 old_count:=(p_payload->>'expected_counter')::bigint; new_count:=(p_payload->>'new_counter')::bigint;
 IF old_count IS NULL OR new_count IS NULL OR k.counter<>old_count OR new_count<0 OR ((old_count>0 OR new_count>0) AND new_count<=old_count) THEN RETURN jsonb_build_object('status','invalid'); END IF;
 UPDATE private.app_passkeys SET counter=new_count,last_used_at=now(),backed_up=(p_payload->>'backed_up')::boolean WHERE credential_id=k.credential_id;
 UPDATE private.app_passkey_challenges SET finalized_at=now() WHERE id=c.id;
 INSERT INTO private.app_sessions(token_hash,user_id,credential_version,expires_at) VALUES(p_token_hash,uid,u.credential_version,now()+interval '8 hours');
 RETURN jsonb_build_object('status','ok','expires_at',now()+interval '8 hours','user',jsonb_build_object('id',u.id,'name',u.name,'team',u.team,'role',u.role,'is_active',u.is_active));
END $function$
;

CREATE OR REPLACE FUNCTION public.app_session_upgrade_team_admin_pin(
 p_current_code text, p_new_code text, p_token_hash text,
 p_lookup_hash text, p_lookup_key_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $upgrade$
DECLARE u public.app_users%rowtype; ids bigint[]; attempts integer; next_version bigint; expires timestamptz;
BEGIN
 IF p_current_code IS NULL OR p_current_code !~ '^[!-~]{4,50}$'
 OR NOT private.app_valid_team_admin_pin(p_new_code)
 OR p_current_code=p_new_code
 OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
 OR p_lookup_hash IS NULL OR p_lookup_hash !~ '^[0-9a-f]{64}$'
 OR p_lookup_key_id IS NULL OR p_lookup_key_id !~ '^[0-9a-f]{64}$'
 THEN RETURN jsonb_build_object('status','admin_pin_invalid'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('app-session:global',0));
 INSERT INTO private.app_login_limits(bucket,window_start,attempts) VALUES('global',now(),1)
 ON CONFLICT(bucket) DO UPDATE SET
 attempts=CASE WHEN private.app_login_limits.window_start<=now()-interval '1 minute' THEN 1 ELSE private.app_login_limits.attempts+1 END,
 window_start=CASE WHEN private.app_login_limits.window_start<=now()-interval '1 minute' THEN now() ELSE private.app_login_limits.window_start END
 RETURNING private.app_login_limits.attempts INTO attempts;
 IF attempts>30 THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('app-code-write',0));
 SELECT array_agg(a.id) INTO ids FROM public.app_users a
 WHERE a.is_active AND private.app_code_matches(p_current_code,a.login_code_hash);
 IF cardinality(ids) IS DISTINCT FROM 1 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 SELECT * INTO u FROM public.app_users WHERE id=ids[1] FOR UPDATE;
 IF NOT u.is_active OR u.role<>'team_admin'
 OR NOT EXISTS(SELECT 1 FROM private.app_team_admin_pin_upgrade_required WHERE user_id=u.id)
 OR NOT private.app_code_matches(p_current_code,u.login_code_hash)
 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 IF EXISTS(SELECT 1 FROM public.app_users a WHERE private.app_code_matches(p_new_code,a.login_code_hash))
 THEN RETURN jsonb_build_object('status','duplicate'); END IF;
 PERFORM set_config('app.audit_actor_id',u.id::text,true);
 PERFORM set_config('app.audit_actor_name',u.name,true);
 PERFORM set_config('app.credential_event','self_change',true);
 UPDATE public.app_users SET login_code_hash=private.app_hash_code(p_new_code)
 WHERE id=u.id RETURNING credential_version INTO next_version;
 -- Preserve currently valid device-bound passkeys, without re-enabling older revoked versions.
 UPDATE private.app_passkeys SET credential_version=next_version
 WHERE user_id=u.id AND credential_version=u.credential_version;
 INSERT INTO private.app_code_lookup(user_id,lookup_key_id,lookup_hash,credential_version)
 VALUES(u.id,p_lookup_key_id,p_lookup_hash,next_version)
 ON CONFLICT(user_id) DO UPDATE SET lookup_key_id=EXCLUDED.lookup_key_id,
 lookup_hash=EXCLUDED.lookup_hash,credential_version=EXCLUDED.credential_version,updated_at=now();
 DELETE FROM private.app_team_admin_pin_upgrade_required WHERE user_id=u.id;
 DELETE FROM private.app_short_code_upgrade_required WHERE user_id=u.id;
 DELETE FROM private.app_passkey_code_recheck WHERE user_id=u.id;
 UPDATE private.app_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=u.id AND revoked_at IS NULL;
 INSERT INTO private.app_sessions(token_hash,user_id,credential_version,expires_at)
 VALUES(p_token_hash,u.id,next_version,now()+interval '8 hours') RETURNING expires_at INTO expires;
 DELETE FROM private.app_login_limits WHERE bucket='user:'||u.id;
 RETURN jsonb_build_object('status','ok','expires_at',expires,
 'user',jsonb_build_object('id',u.id,'name',u.name,'team',u.team,'role',u.role,'is_active',u.is_active));
END $upgrade$;
REVOKE ALL ON FUNCTION public.app_session_upgrade_team_admin_pin(text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_session_upgrade_team_admin_pin(text,text,text,text,text) TO service_role;

-- Existing four team admin accounts; no credentials are changed here.
INSERT INTO private.app_team_admin_pin_upgrade_required(user_id)
 SELECT id FROM public.app_users WHERE role='team_admin' AND is_active
 ON CONFLICT(user_id) DO NOTHING;
COMMIT;
