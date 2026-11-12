-- Count rejected credentials in the same transaction that verifies the code.
-- The existing short-window code/network guard continues to count all requests.
CREATE OR REPLACE FUNCTION public.app_session_code_attempt(
 p_action text, p_code text, p_new_code text, p_token_hash text,
 p_lookup_hash text, p_lookup_key_id text, p_peer_hash text, p_browser_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
 v_browser_delays CONSTANT integer[] := ARRAY[60,300,900,1800];
 v_browser_window CONSTANT interval := interval '10 minutes';
 v_browser_rapid_window CONSTANT interval := interval '1 minute';
 v_peer_window CONSTANT interval := interval '5 minutes';
 v_peer_cap CONSTANT integer := 40;
 v_browser text;
 v_browser_lockout text;
 v_browser_last_failure text;
 v_browser_previous_failure text;
 v_previous_failure_at timestamptz;
 v_peer text;
 v_now timestamptz;
 v_result jsonb;
 v_status text;
 v_retry integer;
 v_attempts integer;
 v_start timestamptz;
BEGIN
 IF p_action IS NULL OR p_action NOT IN ('login','upgrade_short_code','upgrade_team_admin_pin')
 OR p_peer_hash IS NULL OR p_peer_hash !~ '^[0-9a-f]{64}$'
 OR (p_browser_hash IS NOT NULL AND p_browser_hash !~ '^[0-9a-f]{64}$')
 THEN RETURN jsonb_build_object('status','invalid'); END IF;

 v_browser:='browser-failure:'||p_browser_hash;
 v_browser_lockout:='browser-lockout:'||p_browser_hash;
 v_browser_last_failure:='browser-failure-last:'||p_browser_hash;
 v_browser_previous_failure:='browser-failure-previous:'||p_browser_hash;
 v_peer:='peer-failure:'||p_peer_hash;
 IF v_browser IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('app-session:'||v_browser,0));
 END IF;

 v_now:=clock_timestamp();
 SELECT greatest(0,coalesce(max(
   ceil(extract(epoch FROM l.window_start-v_now)) +
   CASE WHEN l.bucket=v_peer THEN extract(epoch FROM v_peer_window)
        ELSE v_browser_delays[l.attempts] END
  ),0))::integer
 INTO v_retry
 FROM private.app_login_limits l
 WHERE (l.bucket=v_browser_lockout AND l.attempts BETWEEN 1 AND cardinality(v_browser_delays))
    OR (l.bucket=v_peer AND l.attempts>=v_peer_cap);
 IF v_retry>0 THEN RETURN jsonb_build_object('status','rate_limited','retry_after',v_retry); END IF;

 CASE p_action
  WHEN 'login' THEN
   v_result:=public.app_session_login_fast(p_code,p_token_hash,p_lookup_hash,p_lookup_key_id);
  WHEN 'upgrade_short_code' THEN
   v_result:=public.app_session_upgrade_short_code(p_code,p_new_code,p_token_hash,p_lookup_hash,p_lookup_key_id);
  WHEN 'upgrade_team_admin_pin' THEN
   v_result:=public.app_session_upgrade_team_admin_pin(p_code,p_new_code,p_token_hash,p_lookup_hash,p_lookup_key_id);
 END CASE;
 v_status:=v_result->>'status';

 IF v_status IN ('ok','upgrade_required','admin_upgrade_required','duplicate') THEN
  DELETE FROM private.app_login_limits
  WHERE bucket IN (v_browser,v_browser_lockout,v_browser_last_failure,v_browser_previous_failure);
 ELSIF v_status='invalid' THEN
  v_now:=clock_timestamp();
  IF v_browser IS NOT NULL THEN
   INSERT INTO private.app_login_limits AS l(bucket,window_start,attempts)
   VALUES(v_browser,v_now,1)
   ON CONFLICT(bucket) DO UPDATE SET
    attempts=CASE WHEN l.window_start<=v_now-v_browser_window THEN 1 ELSE l.attempts+1 END,
    window_start=CASE WHEN l.window_start<=v_now-v_browser_window THEN v_now ELSE l.window_start END
   RETURNING l.attempts INTO v_attempts;

   SELECT window_start INTO v_previous_failure_at
   FROM private.app_login_limits WHERE bucket=v_browser_previous_failure;

   IF v_attempts>=5 OR v_previous_failure_at>v_now-v_browser_rapid_window THEN
    -- The third failure in a rolling minute or the fifth in ten minutes advances the cooldown.
    DELETE FROM private.app_login_limits
    WHERE bucket IN (v_browser,v_browser_last_failure,v_browser_previous_failure);
    INSERT INTO private.app_login_limits AS l(bucket,window_start,attempts)
    VALUES(v_browser_lockout,v_now,1)
    ON CONFLICT(bucket) DO UPDATE SET
     attempts=CASE WHEN l.window_start<=v_now-interval '1 day' THEN 1
                   ELSE least(l.attempts+1,cardinality(v_browser_delays)) END,
     window_start=v_now
    RETURNING l.attempts INTO v_attempts;
    v_retry:=v_browser_delays[v_attempts];
   ELSE
    -- Keep only the two most recent failures for the rolling-minute check.
    INSERT INTO private.app_login_limits(bucket,window_start,attempts)
    SELECT v_browser_previous_failure,window_start,1
    FROM private.app_login_limits WHERE bucket=v_browser_last_failure
    ON CONFLICT(bucket) DO UPDATE SET window_start=EXCLUDED.window_start;

    INSERT INTO private.app_login_limits(bucket,window_start,attempts)
    VALUES(v_browser_last_failure,v_now,1)
    ON CONFLICT(bucket) DO UPDATE SET window_start=EXCLUDED.window_start;
   END IF;
  END IF;

  -- Network failures are counted across browsers. Blocked requests never extend a cooldown.
  INSERT INTO private.app_login_limits AS l(bucket,window_start,attempts)
  VALUES(v_peer,v_now,1)
  ON CONFLICT(bucket) DO UPDATE SET
   attempts=CASE WHEN l.window_start<=v_now-v_peer_window THEN 1
                 ELSE least(l.attempts+1,v_peer_cap) END,
   window_start=CASE WHEN l.window_start<=v_now-v_peer_window THEN v_now
                     WHEN l.attempts=v_peer_cap-1 THEN greatest(l.window_start,v_now)
                     ELSE l.window_start END
  RETURNING l.attempts,l.window_start INTO v_attempts,v_start;
  IF v_attempts>=v_peer_cap THEN
   v_retry:=greatest(v_retry,ceil(extract(epoch FROM v_start+v_peer_window-v_now))::integer);
  END IF;
  IF v_retry>0 THEN RETURN jsonb_build_object('status','rate_limited','retry_after',v_retry); END IF;
 END IF;
 RETURN v_result;
END $function$;

REVOKE ALL ON FUNCTION public.app_session_code_attempt(text,text,text,text,text,text,text,text)
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_session_code_attempt(text,text,text,text,text,text,text,text)
 TO service_role;
