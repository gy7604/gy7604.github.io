const origin = "https://gy7604.github.io";
const headers = {
 "Access-Control-Allow-Origin": origin,
 "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-session",
 "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
 "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
};
const reply = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers});
const hex = (bytes: Uint8Array) => Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
const digest = async (token: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token))));
// Derive a separate lookup key with a fixed purpose label. Optional dedicated secret
// permits independent rotation; default root is the existing server-only service key.
async function loginLookup(code: string, serviceKey: string) {
 const encoder=new TextEncoder();
 const root=Deno.env.get("APP_LOGIN_LOOKUP_SECRET") || serviceKey;
 const rootKey=await crypto.subtle.importKey("raw",encoder.encode(root),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const derived=await crypto.subtle.sign("HMAC",rootKey,encoder.encode("snnc:login-lookup:key:v1"));
 const lookupKey=await crypto.subtle.importKey("raw",derived,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const hash=await crypto.subtle.sign("HMAC",lookupKey,encoder.encode("snnc:login-lookup:code:v1:"+code.trim()));
 const keyId=await crypto.subtle.sign("HMAC",lookupKey,encoder.encode("snnc:login-lookup:key-id:v1"));
 const asHex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
 return {p_lookup_hash:asHex(hash),p_lookup_key_id:asHex(keyId)};
}

Deno.serve(async (request: Request) => {
 if (request.headers.get("origin") && request.headers.get("origin")!==origin) return reply({success:false,message:"허용되지 않은 요청입니다."},403);
 if(request.method==="OPTIONS") return new Response("ok",{headers});
 if(request.method!=="POST") return reply({success:false},405);
 try {
  const raw=await request.text();
  if(raw.length>8192) return reply({success:false},413);
  let body; try {body=JSON.parse(raw);} catch {return reply({success:false},400);}
  if(!body || typeof body!=="object") return reply({success:false},400);
  const action=body.action;
  if(!["login","upgrade_short_code","verify","logout","code_change_status","push_upsert","push_enable","push_delete","push_status","request_create","vacancy_create","sub_register","sub_cancel","request_delete","memo_write","helper_lookup","calendar_read","personal_read","history_read","credential_audit"].includes(action)) return reply({success:false},400);
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url || !key) return reply({success:false,message:"서버 설정을 확인해 주세요."},500);
  let rpc: string, args: Record<string,unknown>, token: string | undefined;
  if(action==="login"){
   if(typeof body.code!=="string" || !body.code.trim() || body.code.length>200) return reply({success:false,message:"접속 코드를 확인해 주세요."},400);
   token=hex(crypto.getRandomValues(new Uint8Array(32)));
   const lookup=await loginLookup(body.code,key);
   const peer=(request.headers.get("cf-connecting-ip")||request.headers.get("x-real-ip")||request.headers.get("x-forwarded-for")?.split(",")[0]||"unknown").trim().slice(0,128);
   const peerKey=await crypto.subtle.importKey("raw",new TextEncoder().encode(Deno.env.get("APP_LOGIN_LOOKUP_SECRET")||key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
   const peerHash=hex(new Uint8Array(await crypto.subtle.sign("HMAC",peerKey,new TextEncoder().encode("snnc:login-peer:v1:"+peer))));
   const guard=await fetch(url+"/rest/v1/rpc/app_session_login_guard",{method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({p_lookup_hash:lookup.p_lookup_hash,p_peer_hash:peerHash}),signal:AbortSignal.timeout(10000)});
   if(!guard.ok)return reply({success:false,message:"로그인 연결을 확인하고 다시 시도해 주세요."},503);
   const allowed=await guard.json();if(allowed.status!=="ok")return reply({success:false,message:"로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요."},429);
   rpc="app_session_login_fast";args={p_code:body.code.trim(),p_token_hash:await digest(token),...lookup};
  }else if(action==="upgrade_short_code"){
   if(typeof body.current_code!=="string" || !/^\d{4}$/.test(body.current_code) ||
      typeof body.new_code!=="string" || typeof body.repeat_code!=="string" ||
      body.new_code!==body.repeat_code || !/^[!-~]{6,50}$/.test(body.new_code) || body.new_code!==body.new_code.trim())
    return reply({success:false,message:"새 코드를 영문·숫자·키보드 특수문자로 공백 없이 6~50자 입력해 주세요."},400);
   token=hex(crypto.getRandomValues(new Uint8Array(32)));
   const lookup=await loginLookup(body.new_code,key);
   rpc="app_session_upgrade_short_code";
   args={p_current_code:body.current_code,p_new_code:body.new_code,p_token_hash:await digest(token),...lookup};
  }else{
   const supplied=request.headers.get("x-app-session") || "";
   if(!/^[0-9a-f]{64}$/.test(supplied)) return reply({success:false,message:"다시 로그인해 주세요."},401);
   const tokenHash=await digest(supplied);
   if(action==="credential_audit"){
    rpc="app_session_credential_audit";args={p_token_hash:tokenHash};
   }else if(action==="personal_read" || action==="history_read"){
    const scope=body.scope,month=body.month,offset=body.offset===undefined?0:body.offset;
    if(!Number.isInteger(offset) || offset<0 || offset>10000) return reply({success:false,message:"조회 범위를 확인해 주세요."},400);
    if(action==="history_read" || scope==="month"){
     if(typeof month!=="string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month<"1900-01" || month>"2200-12") return reply({success:false,message:"조회 월을 확인해 주세요."},400);
    }
    if(action==="personal_read"){
     if(!["upcoming","month"].includes(scope)) return reply({success:false},400);
     rpc="app_session_personal_read";args={p_token_hash:tokenHash,p_scope:scope,p_month:scope==="month"?month+"-01":null,p_offset:offset};
    }else{
     const type=body.type===undefined?"all":body.type,search=body.search===undefined?"":body.search;
     if(!["all","request","helper","memo"].includes(type) || typeof search!=="string" || Array.from(search).length>100) return reply({success:false},400);
     rpc="app_session_history_read";args={p_token_hash:tokenHash,p_month:month+"-01",p_type:type,p_search:search,p_offset:offset};
    }
   }else if(action==="code_change_status"){
    rpc="app_session_code_change_status";args={p_token_hash:tokenHash};
   }else if(action==="calendar_read"){
    if(body.start_date===undefined && body.end_date===undefined){
     // Compatibility for app pages still open from before the range update.
     rpc="app_session_calendar_read";args={p_token_hash:tokenHash};
    }else{
     const dates=[body.start_date,body.end_date];
     if(dates.some(value=>typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))) return reply({success:false,message:"조회 기간을 확인해 주세요."},400);
     const start=new Date(body.start_date+"T00:00:00Z"),end=new Date(body.end_date+"T00:00:00Z");
     if(!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start.toISOString().slice(0,10)!==body.start_date || end.toISOString().slice(0,10)!==body.end_date || end.getTime()<=start.getTime() || end.getTime()-start.getTime()>31*86400000) return reply({success:false,message:"조회 기간을 확인해 주세요."},400);
     rpc="app_session_calendar_read_range";args={p_token_hash:tokenHash,p_start_date:body.start_date,p_end_date:body.end_date};
    }
   }else if(action==="helper_lookup"){
    if(typeof body.name!=="string" || !body.name.trim() || Array.from(body.name).length>200) return reply({success:false,message:"사용자 이름을 확인해 주세요."},400);
    rpc="app_session_helper_lookup";args={p_token_hash:tokenHash,p_name:body.name.trim()};
   }else if(action==="memo_write"){
    if(typeof body.date!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || typeof body.memo!=="string" || Array.from(body.memo).length>500) return reply({success:false,message:"메모는 500자 이내로 입력해 주세요."},400);
    const memoDate=new Date(body.date+"T00:00:00Z");
    if(!Number.isFinite(memoDate.getTime()) || memoDate.toISOString().slice(0,10)!==body.date) return reply({success:false},400);
    if(body.entry_mode==="team"){
     if(body.memo_id!==null && body.memo_id!==undefined && (typeof body.memo_id!=="string"||!/^\d{1,18}$/.test(body.memo_id)))return reply({success:false},400);
     if(body.revision!==null && body.revision!==undefined && (!Number.isSafeInteger(body.revision)||body.revision<1))return reply({success:false},400);
     rpc="app_session_team_memo_write";args={p_token_hash:tokenHash,p_date:body.date,p_memo:body.memo,p_memo_id:body.memo_id||null,p_revision:body.revision??null};
    }else{rpc="app_session_memo_write";args={p_token_hash:tokenHash,p_date:body.date,p_memo:body.memo};}
   }else if(action==="request_delete"){
    if(typeof body.request_id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id)) return reply({success:false,message:"신청 정보를 확인해 주세요."},400);
    rpc="app_session_request_delete";
    args={p_token_hash:tokenHash,p_request_id:body.request_id};
   }else if(action==="sub_register" || action==="sub_cancel"){
    if(typeof body.request_id!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id) ||
       (body.filled_by!==undefined && typeof body.filled_by!=="string")) return reply({success:false,message:"대근 정보를 확인해 주세요."},400);
    rpc="app_session_request_update";
    args={p_token_hash:tokenHash,p_action:action,p_request_id:body.request_id,p_filled_by:body.filled_by||null};
   }else if(action==="request_create" || action==="vacancy_create"){
    if(typeof body.team!=="string" || !["A","B","C","D"].includes(body.team) ||
       typeof body.date!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) ||
       (body.reason!==undefined && typeof body.reason!=="string") ||
       (body.filled_by!==undefined && typeof body.filled_by!=="string")) return reply({success:false,message:"입력 내용을 확인해 주세요."},400);
    const parsedDate=new Date(body.date+"T00:00:00Z");
    if(!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0,10)!==body.date) return reply({success:false},400);
    rpc="app_session_request_create";
    args={p_token_hash:tokenHash,p_action:action,p_team:body.team,p_date:body.date,p_reason:body.reason||"",p_filled_by:body.filled_by||null};
   }else if(action==="push_upsert" || action==="push_enable" || action==="push_delete" || action==="push_status"){
    rpc="app_session_push_v2";
    args={p_token_hash:tokenHash,p_action:action==="push_enable"?"push_upsert":action,p_explicit_enable:action==="push_enable"};
    if(action==="push_upsert" || action==="push_enable") {
     if(!body.subscription || typeof body.subscription!=="object" || Array.isArray(body.subscription)) return reply({success:false},400);
     args.p_subscription=body.subscription;
    }else{
     if(typeof body.endpoint!=="string" || !body.endpoint.trim() || body.endpoint.length>4096) return reply({success:false},400);
     args.p_endpoint=body.endpoint;
    }
   }else{
    rpc=action==="verify"?"app_session_verify":"app_session_logout";args={p_token_hash:tokenHash};
   }
  }
  const result=await fetch(url+"/rest/v1/rpc/"+rpc,{
   method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify(args),signal:AbortSignal.timeout(15000),
  });
  if(!result.ok) return reply({success:false,message:"잠시 후 다시 시도해 주세요."},500);
  const data=await result.json();
  if(action==="login" && data.status==="upgrade_required") return reply({success:true,requires_code_upgrade:true});
  if(action==="upgrade_short_code" && data.status==="ok") return reply({success:true,token,user:data.user,expires_at:data.expires_at});
  if(data.status==="code_required") return reply({success:false,message:"보안을 위해 기존 접속코드를 한 번 확인해 주세요. 4자리 코드는 변경해야 합니다."},401);
  if(data.status==="upgrade_required") return reply({success:false,message:"4자리 접속코드는 변경해야 합니다. 기존 코드를 입력해 주세요."},403);
  if(data.status==="rate_limited") return reply({success:false,message:"잠시 후 다시 시도해 주세요."},429);
  if(data.status==="not_found") return reply({success:false,message:"해당 신청을 찾을 수 없습니다."},404);
  if(data.status==="disabled") return reply({success:false,message:"이 기기의 알림이 꺼져 있습니다. 알림 설정을 눌러 다시 켜 주세요."},409);
  if(data.status==="helper_busy") return reply({success:false,message:"이 대근자는 같은 날짜·같은 근무에 이미 등록되어 있습니다."},409);
  if(data.status==="conflict") return reply({success:false,message:action==="memo_write"?"메모가 변경되었습니다. 달력을 새로 불러온 뒤 다시 입력해 주세요.":"대근 상태가 변경되었습니다. 달력을 새로 불러온 뒤 확인해 주세요."},409);
  if(data.status==="forbidden") return reply({success:false,message:action==="memo_write"?"메모를 작성한 조의 인원만 수정·삭제할 수 있습니다.":"이 기능에 접근할 권한이 없습니다."},403);
  if(data.status==="duplicate") return reply({success:false,message:action==="upgrade_short_code"?"이미 사용 중인 접속코드입니다. 다른 코드를 입력해 주세요.":"이 날짜에 이미 본인의 휴무 신청이 있습니다."},409);
  if(data.status==="bad_input") return reply({success:false,message:action==="upgrade_short_code"?"새 접속코드 입력을 확인해 주세요.":"입력 정보를 확인해 주세요."},400);
  if(data.status!=="ok") return reply({success:false,message:"접속 코드 또는 세션을 확인해 주세요."},401);
  return reply({success:true,...(["personal_read","history_read"].includes(action)?{rows:(data.rows||[]).slice(0,100),has_more:data.has_more===true}:{}),...(action==="credential_audit"?{users:data.users||[]}:{}),...(action==="code_change_status"?{used:data.used,remaining:data.remaining,limit:data.limit,month:data.month}:{}),...(action==="push_status"?{registered:data.registered===true,disabled:data.disabled===true}:{}),...(token?{token}:{}),...(data.user?{user:data.user,expires_at:data.expires_at}:{}),...(action==="helper_lookup"?{users:data.users||[]}: {}),...(action==="calendar_read"?{requests:data.requests||[],memos:data.memos||[]}: {})});
 }catch{
  // Never log credentials, session tokens, or RPC payloads.
  return reply({success:false,message:"잠시 후 다시 시도해 주세요."},500);
 }
});

