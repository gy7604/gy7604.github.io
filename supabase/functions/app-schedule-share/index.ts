import { createClient } from "npm:@supabase/supabase-js@2.95.0";
const origin="https://gy7604.github.io";
const headers={"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"content-type,apikey,authorization,x-client-info,x-app-session","Access-Control-Allow-Methods":"POST,OPTIONS","Content-Type":"application/json","Cache-Control":"no-store","Vary":"Origin"};
const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)))).map(n=>n.toString(16).padStart(2,"0")).join("");
Deno.serve(async(req)=>{
 const out=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(req.headers.get("origin") && req.headers.get("origin")!==origin)return out({success:false},403);
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers});
 if(req.method!=="POST")return out({success:false},405);
 try{
  if(Number(req.headers.get("content-length")||0)>4096)return out({success:false},413);
  const text=await req.text();if(text.length>4096)return out({success:false},413);
  const body=JSON.parse(text),action=body.action;
  if(!["issue","revoke","status","read","read_full"].includes(action))return out({success:false},400);
  let token:string|undefined,sessionHash:string|null=null,shareHash:string|null=null;
  if(action==="read"||action==="read_full"){
   if(typeof body.token!=="string"||!/^[0-9a-f]{64}$/.test(body.token))return out({success:false,message:"유효하지 않은 공유 링크입니다."},401);
   shareHash=await hash(body.token);
  }else{
   const session=req.headers.get("x-app-session")||"";
   if(!/^[0-9a-f]{64}$/.test(session))return out({success:false},401);
   sessionHash=await hash(session);
   if(action==="issue"){token=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(n=>n.toString(16).padStart(2,"0")).join("");shareHash=await hash(token);}
  }
  const {data,error}=action==="read_full" ? await db.rpc("app_schedule_share_calendar",{p_share_hash:shareHash,p_month:body.month}) : await db.rpc("app_schedule_share",{p_action:action,p_session_hash:sessionHash,p_share_hash:shareHash,p_month:action==="read"?body.month:null});
  if(error)return out({success:false,message:"잠시 후 다시 시도해 주세요."},500);
  if(data?.status!=="ok")return out({success:false,message:"공유가 해제되었거나 유효하지 않은 링크입니다."},data?.status==="bad_input"?400:401);
  return out({success:true,...data,...(token?{token}:{})});
 }catch{return out({success:false,message:"요청을 처리하지 못했습니다."},400);}
});