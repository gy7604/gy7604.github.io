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
function validTeamAdminPin(code: unknown): code is string {
 if(typeof code!=="string" || !/^[0-9]{8}$/.test(code))return false;
 for(let i=0;i<=5;i++){
  const a=code.charCodeAt(i),b=code.charCodeAt(i+1),c=code.charCodeAt(i+2);
  if((b===a+1 && c===b+1)||(b===a-1 && c===b-1)||(a===b && b===c))return false;
 }
 return true;
}
// The lookup root is independent of the database service role.
async function loginLookup(code: string, rootKey: CryptoKey) {
 const encoder=new TextEncoder();
 const derived=await crypto.subtle.sign("HMAC",rootKey,encoder.encode("snnc:login-lookup:key:v1"));
 const lookupKey=await crypto.subtle.importKey("raw",derived,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const hash=await crypto.subtle.sign("HMAC",lookupKey,encoder.encode("snnc:login-lookup:code:v1:"+code.trim()));
 const keyId=await crypto.subtle.sign("HMAC",lookupKey,encoder.encode("snnc:login-lookup:key-id:v1"));
 const asHex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
 return {p_lookup_hash:asHex(hash),p_lookup_key_id:asHex(keyId)};
}

function codeRateLimited(retryAfter: unknown = 60) {
 const seconds=typeof retryAfter==="number" && Number.isFinite(retryAfter)
  ? Math.max(1,Math.min(1800,Math.ceil(retryAfter))) : 60;
 const minutes=Math.ceil(seconds/60);
 return new Response(JSON.stringify({success:false,retry_after:seconds,
  message:"접속 코드 입력을 잠시 제한했습니다. "+minutes+"분 후 다시 시도해 주세요."}),
  {status:429,headers:{...headers,"Retry-After":String(seconds)}});
}

async function loginAttemptHashes(request: Request, browserId: unknown, rootKey: CryptoKey) {
 const peer=(request.headers.get("cf-connecting-ip")||request.headers.get("x-real-ip")
  ||request.headers.get("x-forwarded-for")?.split(",")[0]||"unknown").trim().slice(0,128);
 const encoder=new TextEncoder();
 const hash=async (label: string) => hex(new Uint8Array(await crypto.subtle.sign("HMAC",rootKey,encoder.encode(label))));
 const p_peer_hash=await hash("snnc:login-peer:v1:"+peer);
 const p_browser_hash=typeof browserId==="string" && /^[0-9a-f]{32}$/.test(browserId)
  ? await hash("snnc:login-browser:v1:"+browserId) : null;
 return {p_peer_hash,p_browser_hash};
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
  if(!["login","upgrade_short_code","upgrade_team_admin_pin","verify","logout","code_change_status","push_upsert","push_enable","push_delete","push_status","request_create","vacancy_create","sub_register","sub_cancel","request_delete","memo_write","helper_lookup","calendar_read","personal_read","history_read","credential_audit","leave_read","leave_settings","leave_classify","owner_mode"].includes(action)) return reply({success:false},400);
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url || !key) return reply({success:false,message:"서버 설정을 확인해 주세요."},500);
  let rpc: string, args: Record<string,unknown>, token: string | undefined;
  const isCodeAttempt=action==="login" || action==="upgrade_short_code" || action==="upgrade_team_admin_pin";
  if(isCodeAttempt){
   const isLogin=action==="login";
   let code: string;
   if(isLogin){
    if(typeof body.code!=="string" || !body.code.trim() || body.code.length>200)
     return reply({success:false,message:"접속 코드를 확인해 주세요."},400);
    code=body.code.trim();
   }else{
    if(action==="upgrade_short_code"){
     if(typeof body.current_code!=="string" || !/^\d{4}$/.test(body.current_code) ||
        typeof body.new_code!=="string" || typeof body.repeat_code!=="string" ||
        body.new_code!==body.repeat_code || !/^[!-~]{6,50}$/.test(body.new_code) || body.new_code!==body.new_code.trim())
      return reply({success:false,message:"새 코드를 영문·숫자·키보드 특수문자로 공백 없이 6~50자 입력해 주세요."},400);
    }else if(typeof body.current_code!=="string" || !/^[!-~]{4,50}$/.test(body.current_code) ||
             !validTeamAdminPin(body.new_code) || body.new_code!==body.repeat_code){
     return reply({success:false,message:"조 관리자 새 PIN은 연속·반복 숫자 없이 8자리로 입력해 주세요."},400);
    }
    code=body.current_code;
   }

   const lookupSecret=Deno.env.get("APP_LOGIN_LOOKUP_SECRET");
   if(!lookupSecret) return reply({success:false,message:"로그인 서버 설정을 확인해 주세요."},503);
   const rootKey=await crypto.subtle.importKey("raw",new TextEncoder().encode(lookupSecret),
    {name:"HMAC",hash:"SHA-256"},false,["sign"]);
   const currentLookup=await loginLookup(code,rootKey);
   const attempt=await loginAttemptHashes(request,body.browser_id,rootKey);
   const guard=await fetch(url+"/rest/v1/rpc/app_session_login_guard",{
    method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"},
    body:JSON.stringify({p_lookup_hash:currentLookup.p_lookup_hash,p_peer_hash:attempt.p_peer_hash}),
    signal:AbortSignal.timeout(10000),
   });
   if(!guard.ok) return reply({success:false,message:"로그인 연결을 확인하고 다시 시도해 주세요."},503);
   if((await guard.json()).status!=="ok") return codeRateLimited();

   token=hex(crypto.getRandomValues(new Uint8Array(32)));
   const lookup=isLogin?currentLookup:await loginLookup(body.new_code,rootKey);
   rpc="app_session_code_attempt";
   args={p_action:action,p_code:code,p_new_code:isLogin?null:body.new_code,
    p_token_hash:await digest(token),...lookup,...attempt};
  }else{
   const supplied=request.headers.get("x-app-session") || "";
   if(!/^[0-9a-f]{64}$/.test(supplied)) return reply({success:false,message:"다시 로그인해 주세요."},401);
   const tokenHash=await digest(supplied);
   if(action==="owner_mode"){
    if(typeof body.enabled!=="boolean")return reply({success:false,message:"전환할 모드를 확인해 주세요."},400);
    rpc="app_session_set_owner_mode";args={p_token_hash:tokenHash,p_enabled:body.enabled};
   }else if(["leave_read","leave_settings","leave_classify"].includes(action)){
    if(action!=="leave_classify" && (!Number.isInteger(body.year)||body.year<1901||body.year>2199))return reply({success:false,message:"기준 연도를 확인해 주세요."},400);
    if(action==="leave_classify"){
     if(typeof body.request_id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id)||!["annual","reward"].includes(body.leave_kind))return reply({success:false},400);
     rpc="app_session_leave_classify";args={p_token_hash:tokenHash,p_request_id:body.request_id,p_kind:body.leave_kind};
    }else if(action==="leave_settings"){
     if(typeof body.reset!=="string"||!/^\d{2}-\d{2}$/.test(body.reset)||!Number.isInteger(body.total)||body.total<0||body.total>366)return reply({success:false,message:"설정값을 확인해 주세요."},400);
     rpc="app_session_leave_settings";args={p_token_hash:tokenHash,p_year:body.year,p_reset:body.reset,p_total:body.total};
    }else{rpc="app_session_leave_read";args={p_token_hash:tokenHash,p_year:body.year};}
   }else if(action==="credential_audit"){
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
    if(body.leave_kind!==undefined){
     if(action!=="request_create" || !["annual","reward"].includes(body.leave_kind))return reply({success:false},400);
     rpc="app_session_leave_create";args.p_kind=body.leave_kind;
    }
   }else if(action==="push_upsert" || action==="push_enable" || action==="push_delete" || action==="push_status"){
    if(action==="push_upsert" || action==="push_enable"){
     const ua=request.headers.get("user-agent")||"";
     const mobile=/Android|iPhone|iPad|iPod/i.test(ua) ||
       (/Macintosh/i.test(ua) && body.device_type==="mobile");
     if(!mobile)return reply({success:false,message:"알림은 휴대폰에서만 설정할 수 있습니다."},403);
    }
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
  if(action==="login" && data.status==="admin_upgrade_required")
   return reply({success:true,requires_code_upgrade:true,code_upgrade_kind:"team_admin"});
  if(action==="login" && data.status==="upgrade_required")
   return reply({success:true,requires_code_upgrade:true,code_upgrade_kind:"short"});
  if(["upgrade_short_code","upgrade_team_admin_pin"].includes(action) && data.status==="ok") return reply({success:true,token,user:data.user,expires_at:data.expires_at});
  if(data.status==="code_required") return reply({success:false,message:"보안을 위해 기존 접속코드를 한 번 확인해 주세요. 4자리 코드는 변경해야 합니다."},401);
  if(data.status==="admin_upgrade_required") return reply({success:false,message:"조 관리자 계정은 기존 접속번호로 로그인한 뒤 8자리 PIN으로 변경해야 합니다."},403);
  if(data.status==="admin_pin_invalid") return reply({success:false,message:"조 관리자 PIN은 연속·반복 숫자가 없는 8자리 숫자로 입력해 주세요."},400);
  if(data.status==="upgrade_required") return reply({success:false,message:"4자리 접속코드는 변경해야 합니다. 기존 코드를 입력해 주세요."},403);
  if(data.status==="rate_limited") return isCodeAttempt?codeRateLimited(data.retry_after):reply({success:false,message:"잠시 후 다시 시도해 주세요."},429);
  if(data.status==="not_found") return reply({success:false,message:"해당 신청을 찾을 수 없습니다."},404);
  if(data.status==="disabled") return reply({success:false,message:"이 기기의 알림이 꺼져 있습니다. 알림 설정을 눌러 다시 켜 주세요."},409);
  if(data.status==="helper_busy") return reply({success:false,message:"이 대근자는 같은 날짜·같은 근무에 이미 등록되어 있습니다."},409);
  if(data.status==="conflict") return reply({success:false,message:action==="memo_write"?"메모가 변경되었습니다. 달력을 새로 불러온 뒤 다시 입력해 주세요.":"대근 상태가 변경되었습니다. 달력을 새로 불러온 뒤 확인해 주세요."},409);
  if(data.status==="forbidden") return reply({success:false,message:action==="memo_write"?"메모를 작성한 조의 인원만 수정·삭제할 수 있습니다.":"이 기능에 접근할 권한이 없습니다."},403);
  if(data.status==="duplicate") return reply({success:false,message:["upgrade_short_code","upgrade_team_admin_pin"].includes(action)?"이미 사용 중인 접속코드입니다. 다른 코드를 입력해 주세요.":"이 날짜에 이미 본인의 휴무 신청이 있습니다."},409);
  if(data.status==="reason_contains_name") return reply({success:false,message:"신청자 이름은 자동으로 표시됩니다. 사유에서 본인 이름을 지우고 등록해 주세요."},400);
  if(data.status==="bad_input") return reply({success:false,message:action==="upgrade_short_code"?"새 접속코드 입력을 확인해 주세요.":"입력 정보를 확인해 주세요."},400);
  if(data.status!=="ok") return reply({success:false,message:"접속 코드 또는 세션을 확인해 주세요."},401);
  return reply({success:true,...(action==="leave_read"?{rows:data.rows||[],settings:data.settings||null}:{}),...(["personal_read","history_read"].includes(action)?{rows:(data.rows||[]).slice(0,100),has_more:data.has_more===true}:{}),...(action==="credential_audit"?{users:data.users||[]}:{}),...(action==="code_change_status"?{used:data.used,remaining:data.remaining,limit:data.limit,month:data.month}:{}),...(action==="push_status"?{registered:data.registered===true,disabled:data.disabled===true}:{}),...(token?{token}:{}),...(data.user?{user:data.user,expires_at:data.expires_at}:{}),...(action==="helper_lookup"?{users:data.users||[]}: {}),...(action==="calendar_read"?{requests:data.requests||[],memos:data.memos||[]}: {})});
 }catch{
  // Never log credentials, session tokens, or RPC payloads.
  return reply({success:false,message:"잠시 후 다시 시도해 주세요."},500);
 }
});

