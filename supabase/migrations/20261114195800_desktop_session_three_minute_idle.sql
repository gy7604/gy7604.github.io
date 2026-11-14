-- PC-only three-minute idle timeout. All existing sessions start as
-- non-desktop to avoid breaking active mobile sessions; new login endpoints
-- classify and bind the device before returning a session token.
-- No existing session, login code, push subscription, memo or request is deleted.
ALTER TABLE private.app_sessions
  ADD COLUMN IF NOT EXISTS is_desktop boolean NOT NULL DEFAULT false;
ALTER TABLE private.app_sessions
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();

-- Session activity must be driven by a genuine UI interaction; normal reads,
-- calendar refreshes and polling must not extend the PC session.
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
 and (NOT s.is_desktop OR s.last_activity_at > now()-interval '3 minutes')
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

CREATE OR REPLACE FUNCTION public.app_session_bind_device(
 p_token_hash text, p_is_desktop boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $bind$
DECLARE uid bigint;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_is_desktop IS NULL
 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 UPDATE private.app_sessions s
 SET is_desktop=p_is_desktop,last_activity_at=now()
 FROM public.app_users u
 WHERE s.token_hash=p_token_hash
   AND s.user_id=u.id AND u.is_active
   AND s.credential_version=u.credential_version
   AND s.revoked_at IS NULL AND s.expires_at>now()
   AND s.created_at>now()-interval '2 minutes'
 RETURNING s.user_id INTO uid;
 IF uid IS NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
 RETURN jsonb_build_object('status','ok','desktop_session',p_is_desktop);
END $bind$;
REVOKE ALL ON FUNCTION public.app_session_bind_device(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.app_session_bind_device(text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.app_session_desktop_activity(p_token_hash text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $activity$
DECLARE uid bigint;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
 THEN RETURN jsonb_build_object('status','invalid'); END IF;
 UPDATE private.app_sessions s
 SET last_activity_at=now()
 FROM public.app_users u
 WHERE s.token_hash=p_token_hash
   AND s.user_id=u.id AND u.is_active
   AND s.credential_version=u.credential_version
   AND s.is_desktop AND s.revoked_at IS NULL AND s.expires_at>now()
   AND s.last_activity_at > now()-interval '3 minutes'
 RETURNING s.user_id INTO uid;
 IF uid IS NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
 RETURN jsonb_build_object('status','ok');
END $activity$;
REVOKE ALL ON FUNCTION public.app_session_desktop_activity(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.app_session_desktop_activity(text) TO service_role;
