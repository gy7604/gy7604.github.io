-- Rolling 30-day app sessions.
-- Every valid app_session_verify call extends the session by 30 days.
-- Logout, credential_version changes, and account deactivation still revoke access.
CREATE OR REPLACE FUNCTION public.app_session_verify(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_user jsonb;
  v_expires_at timestamptz;
BEGIN
  UPDATE private.app_sessions AS s
  SET expires_at = now() + interval '30 days'
  FROM public.app_users AS u
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND u.id = s.user_id
    AND u.is_active
    AND s.credential_version = u.credential_version
  RETURNING jsonb_build_object(
    'id', u.id,
    'name', u.name,
    'team', u.team,
    'role', u.role,
    'is_active', u.is_active
  ), s.expires_at
  INTO v_user, v_expires_at;

  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'expires_at', v_expires_at,
    'user', v_user
  );
END
$function$;

REVOKE ALL ON FUNCTION public.app_session_verify(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_session_verify(text) TO service_role;
