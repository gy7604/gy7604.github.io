-- Private pilot: no changes to existing users, requests, sessions or push subscriptions.
CREATE TABLE private.app_passkey_pilot (
 user_id bigint PRIMARY KEY REFERENCES public.app_users(id), enabled boolean NOT NULL DEFAULT true
);
INSERT INTO private.app_passkey_pilot(user_id)
SELECT id FROM public.app_users WHERE name='장경준' AND team='B' AND role='user' AND is_active
AND (SELECT count(*) FROM public.app_users WHERE name='장경준' AND is_active)=1;
DO $$ BEGIN IF (SELECT count(*) FROM private.app_passkey_pilot)<>1 THEN RAISE EXCEPTION 'Pilot account is not unique'; END IF; END $$;
CREATE TABLE private.app_passkeys (
 credential_id text PRIMARY KEY, user_id bigint NOT NULL REFERENCES public.app_users(id),
 public_key text NOT NULL, counter bigint NOT NULL CHECK(counter>=0), transports jsonb NOT NULL DEFAULT '[]',
 credential_version bigint NOT NULL, device_type text NOT NULL, backed_up boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);
CREATE INDEX app_passkeys_user_idx ON private.app_passkeys(user_id);
CREATE TABLE private.app_passkey_challenges (
 id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(), challenge text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('register','login')), user_id bigint NOT NULL REFERENCES public.app_users(id),
 credential_version bigint NOT NULL, session_hash text, credential_id text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '3 minutes',
 used_at timestamptz, finalized_at timestamptz
);
CREATE INDEX app_passkey_challenges_user_idx ON private.app_passkey_challenges(user_id,created_at);
ALTER TABLE private.app_passkey_pilot ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.app_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.app_passkey_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.app_passkey_pilot,private.app_passkeys,private.app_passkey_challenges FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.app_passkey_access(p_action text,p_token_hash text DEFAULT NULL,p_challenge text DEFAULT NULL,p_challenge_id uuid DEFAULT NULL,p_credential_id text DEFAULT NULL,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
 IF uid IS NULL OR NOT EXISTS(SELECT 1 FROM private.app_passkey_pilot WHERE user_id=uid AND enabled) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
 SELECT * INTO u FROM public.app_users WHERE id=uid AND is_active FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','invalid'); END IF;
 IF p_action='status' THEN RETURN jsonb_build_object('status','ok','eligible',true,'registered',EXISTS(SELECT 1 FROM private.app_passkeys WHERE user_id=uid AND credential_version=u.credential_version)); END IF;

 IF p_action IN ('register_begin','login_begin') THEN
  IF p_challenge IS NULL OR p_challenge !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN jsonb_build_object('status','bad_input'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey-options:'||uid,0));
  IF (SELECT count(*) FROM private.app_passkey_challenges WHERE user_id=uid AND created_at>now()-interval '1 minute')>=10 THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
  IF p_action='register_begin' THEN
   IF NOT EXISTS(SELECT 1 FROM private.app_sessions WHERE token_hash=p_token_hash AND created_at>now()-interval '15 minutes')
   OR NOT private.app_code_matches(p_payload->>'current_code',u.login_code_hash) THEN RETURN jsonb_build_object('status','reauth'); END IF;
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
END $$;
REVOKE ALL ON FUNCTION public.app_passkey_access(text,text,text,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.app_passkey_access(text,text,text,uuid,text,jsonb) TO service_role;
