-- Superadmin-only free-text helper assignment. Existing requests and accounts are not rewritten.
CREATE OR REPLACE FUNCTION private.app_helper_slot_available(p_user_id bigint, p_name text, p_date date, p_shift text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
 IF p_name IS NULL OR btrim(p_name)='' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('helper-name-slot:'||btrim(p_name)||':'||p_date||':'||p_shift,0));
 IF p_user_id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('helper-slot:'||p_user_id||':'||p_date||':'||p_shift,0));
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM public.requests r WHERE r.status='FILLED' AND r.shift_date=p_date AND r.shift_type=p_shift
 AND (p_request_id IS NULL OR r.id<>p_request_id)
 AND ((p_user_id IS NOT NULL AND r.filled_by_id=p_user_id) OR r.filled_by=btrim(p_name)));
END $function$;

CREATE OR REPLACE FUNCTION public.app_session_request_create(p_token_hash text, p_action text, p_team text, p_date date, p_reason text DEFAULT ''::text, p_filled_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE s jsonb; uid bigint; uname text; uteam text; urole text; kind text; shift text; helper public.app_users%rowtype; rid uuid; helper_count integer;
BEGIN
 s:=public.app_session_verify(p_token_hash);
 IF s->>'status' IS DISTINCT FROM 'ok' THEN RETURN jsonb_build_object('status','invalid'); END IF;
 PERFORM set_config('app.audit_actor_id',s->'user'->>'id',true);
 PERFORM set_config('app.audit_actor_name',s->'user'->>'name',true);
 uid:=(s->'user'->>'id')::bigint; uname:=s->'user'->>'name'; uteam:=s->'user'->>'team'; urole:=s->'user'->>'role';
 IF p_team IS NULL OR p_team NOT IN ('A','B','C','D') OR p_date IS NULL THEN RETURN jsonb_build_object('status','bad_input'); END IF;
 shift:=public._shift_for_team(p_team,p_date);
 IF shift IS NULL OR shift='휴무' THEN RETURN jsonb_build_object('status','bad_input'); END IF;
 IF p_action='request_create' THEN
  IF urole NOT IN ('user','admin') OR (urole='user' AND p_team<>uteam) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  kind:=CASE WHEN coalesce(p_reason,'') ~ '정수|지원' THEN 'support' ELSE 'off' END;
  PERFORM pg_advisory_xact_lock(hashtextextended('request:'||uid||':'||p_team||':'||p_date,0));
  IF kind='off' AND EXISTS(SELECT 1 FROM public.requests r WHERE r.team=p_team AND r.shift_date=p_date
   AND (r.requested_by_id=uid OR (r.requested_by_id IS NULL AND r.requested_by=uname))
   AND r.request_kind<>'support' AND coalesce(r.reason,'') !~ '정수|지원') THEN
   RETURN jsonb_build_object('status','duplicate');
  END IF;
  INSERT INTO public.requests(requested_by,requested_by_id,request_kind,team,shift_type,shift_date,reason,status)
  VALUES(uname,uid,kind,p_team,shift,p_date,coalesce(p_reason,''),'OPEN') RETURNING id INTO rid;
 ELSIF p_action='vacancy_create' THEN
  IF urole NOT IN ('user','team_admin','admin') OR (urole='team_admin' AND (p_team IN (CASE WHEN uteam IN ('A','D') THEN 'B' WHEN uteam IN ('B','C') THEN 'A' END, CASE WHEN uteam IN ('A','D') THEN 'C' WHEN uteam IN ('B','C') THEN 'D' END)) IS DISTINCT FROM true) OR (urole='user' AND p_team=uteam) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF urole='admin' THEN
   IF p_filled_by IS NULL OR btrim(p_filled_by)='' OR char_length(btrim(p_filled_by))>200 OR p_filled_by !~ '\S'
   THEN RETURN jsonb_build_object('status','bad_input'); END IF;
   SELECT count(*) INTO helper_count FROM public.app_users WHERE name=btrim(p_filled_by) AND is_active;
   IF helper_count=1 THEN
    SELECT * INTO helper FROM public.app_users WHERE name=btrim(p_filled_by) AND is_active;
   ELSE
    helper.name:=btrim(p_filled_by);helper.id:=NULL;
   END IF;
  ELSIF urole='user' THEN
   SELECT * INTO helper FROM public.app_users WHERE id=uid AND is_active;
  ELSE
   SELECT count(*) INTO helper_count FROM public.app_users WHERE name=btrim(p_filled_by) AND is_active;
   IF helper_count<>1 THEN RETURN jsonb_build_object('status','bad_input'); END IF;
   SELECT * INTO helper FROM public.app_users WHERE name=btrim(p_filled_by) AND is_active;
  END IF;
  IF urole='team_admin' AND helper.team IS DISTINCT FROM uteam THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF urole<>'admin' AND (helper.team=p_team OR (helper.team||'조' IS DISTINCT FROM public._suggested_helper_team(p_team,shift,p_date) AND public._shift_for_team(helper.team,p_date)<>'휴무')) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF NOT private.app_helper_slot_available(helper.id,helper.name,p_date,shift) THEN RETURN jsonb_build_object('status','helper_busy'); END IF;
  INSERT INTO public.requests(requested_by,requested_by_id,team,shift_type,shift_date,reason,status,filled_by,filled_by_id)
  VALUES(p_team||'조 공석',uid,p_team,shift,p_date,'지정 대근','FILLED',helper.name,helper.id) RETURNING id INTO rid;
 ELSE RETURN jsonb_build_object('status','bad_input');
 END IF;
 RETURN jsonb_build_object('status','ok','request_id',rid);
END $function$;

CREATE OR REPLACE FUNCTION public.app_session_request_update(p_token_hash text, p_action text, p_request_id uuid, p_filled_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE s jsonb; uid bigint; uname text; uteam text; urole text; req public.requests%rowtype; helper public.app_users%rowtype; cnt integer;
BEGIN
 s:=public.app_session_verify(p_token_hash);
 IF s->>'status' IS DISTINCT FROM 'ok' THEN RETURN jsonb_build_object('status','invalid'); END IF;
 PERFORM set_config('app.audit_actor_id',s->'user'->>'id',true);
 PERFORM set_config('app.audit_actor_name',s->'user'->>'name',true);
 uid:=(s->'user'->>'id')::bigint; uname:=s->'user'->>'name'; uteam:=s->'user'->>'team'; urole:=s->'user'->>'role';
 SELECT * INTO req FROM public.requests WHERE id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF urole NOT IN ('user','team_admin','admin') OR (urole='team_admin' AND (req.team IN (CASE WHEN uteam IN ('A','D') THEN 'B' WHEN uteam IN ('B','C') THEN 'A' END, CASE WHEN uteam IN ('A','D') THEN 'C' WHEN uteam IN ('B','C') THEN 'D' END)) IS DISTINCT FROM true) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
 IF p_action='sub_cancel' THEN
  IF urole='team_admin' AND NOT EXISTS(SELECT 1 FROM public.app_users u WHERE u.team=uteam AND (CASE WHEN req.filled_by_id IS NOT NULL THEN u.id=req.filled_by_id ELSE u.name=req.filled_by END)) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF urole='user' AND (CASE WHEN req.filled_by_id IS NOT NULL THEN req.filled_by_id=uid ELSE req.filled_by=uname END) IS DISTINCT FROM true THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF req.status IS DISTINCT FROM 'FILLED' THEN RETURN jsonb_build_object('status','conflict'); END IF;
  UPDATE public.requests SET status='OPEN',filled_by=NULL,filled_by_id=NULL WHERE id=req.id;
 ELSIF p_action='sub_register' THEN
  IF urole='admin' THEN
   IF p_filled_by IS NULL OR btrim(p_filled_by)='' OR char_length(btrim(p_filled_by))>200 OR p_filled_by !~ '\S'
   THEN RETURN jsonb_build_object('status','bad_input'); END IF;
   SELECT count(*) INTO cnt FROM public.app_users WHERE name=btrim(p_filled_by) AND is_active;
   IF cnt=1 THEN
    SELECT * INTO helper FROM public.app_users WHERE name=btrim(p_filled_by) AND is_active;
   ELSE
    helper.name:=btrim(p_filled_by);helper.id:=NULL;
   END IF;
  ELSIF urole='user' THEN
   IF req.team=uteam THEN RETURN jsonb_build_object('status','forbidden'); END IF;
   IF req.status='FILLED' AND (CASE WHEN req.filled_by_id IS NOT NULL THEN req.filled_by_id<>uid ELSE req.filled_by IS DISTINCT FROM uname END) THEN RETURN jsonb_build_object('status','conflict'); END IF;
   SELECT * INTO helper FROM public.app_users WHERE id=uid AND is_active;
  ELSE
   SELECT count(*) INTO cnt FROM public.app_users WHERE name=btrim(p_filled_by) AND is_active;
   IF cnt<>1 THEN RETURN jsonb_build_object('status','bad_input'); END IF;
   SELECT * INTO helper FROM public.app_users WHERE name=btrim(p_filled_by) AND is_active;
  END IF;
  IF urole='team_admin' AND helper.team IS DISTINCT FROM uteam THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF urole<>'admin' AND (helper.team=req.team OR (helper.team||'조' IS DISTINCT FROM public._suggested_helper_team(req.team,req.shift_type,req.shift_date) AND public._shift_for_team(helper.team,req.shift_date)<>'휴무')) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF NOT private.app_helper_slot_available(helper.id,helper.name,req.shift_date,req.shift_type,req.id) THEN RETURN jsonb_build_object('status','helper_busy'); END IF;
  UPDATE public.requests SET status='FILLED',filled_by=helper.name,filled_by_id=helper.id WHERE id=req.id;
 ELSE RETURN jsonb_build_object('status','bad_input');
 END IF;
 RETURN jsonb_build_object('status','ok');
END $function$;

revoke all on function public.app_session_request_create(text,text,text,date,text,text), public.app_session_request_update(text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.app_session_request_create(text,text,text,date,text,text), public.app_session_request_update(text,text,uuid,text) to service_role;
