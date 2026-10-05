import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from 'npm:@simplewebauthn/server@13.2.2';

const origin='https://gy7604.github.io', rpID='gy7604.github.io';
const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type,x-app-session','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Max-Age':'600','Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'};
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
const messages:Record<string,string>={invalid:'생체인증 등록 또는 세션을 확인해 주세요. 기존 코드로 로그인할 수 있습니다.',forbidden:'이 계정은 생체인증 시험 대상이 아닙니다.',reauth:'기존 접속코드로 다시 로그인한 뒤 15분 이내에 등록해 주세요.',rate_limited:'잠시 후 다시 시도해 주세요.',limit:'등록 가능한 패스키 수를 초과했습니다.',conflict:'이미 등록된 패스키입니다.'};
Deno.serve(async(request:Request)=>{
 if(request.headers.get('origin')!==origin) return reply({success:false,message:'허용되지 않은 요청입니다.'},403);
 if(request.method==='OPTIONS') return new Response('ok',{headers});
 if(request.method!=='POST') return reply({success:false},405);
 try{
  const raw=await request.text();if(raw.length>32768)return reply({success:false},413);
  const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))return reply({success:false},400);
  const action=body.action;
  if(!['status','register_options','register_verify','login_options','login_verify'].includes(action))return reply({success:false},400);
  const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!url||!key)return reply({success:false,message:'서버 설정을 확인해 주세요.'},503);
  const rpc=async(args:Record<string,unknown>)=>{
   const res=await fetch(url+'/rest/v1/rpc/app_passkey_access',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args)});
   if(!res.ok)throw Error('RPC unavailable');return await res.json();
  };
  let tokenHash:string|undefined;
  if(action==='status'||action.startsWith('register_')){
   const token=request.headers.get('x-app-session')||'';
   if(!/^[0-9a-f]{64}$/.test(token))return reply({success:false,message:messages.invalid},401);
   tokenHash=await digest(token);
  }
  const failed=(data:{status:string})=>reply({success:false,message:messages[data.status]||'생체인증을 확인하지 못했습니다.'},data.status==='rate_limited'?429:data.status==='invalid'?401:data.status==='forbidden'?403:400);
  if(action==='status'){
   const data=await rpc({p_action:'status',p_token_hash:tokenHash});
   return data.status==='ok'?reply({success:true,eligible:true,registered:data.registered}):failed(data);
  }
  if(action==='register_options'){
   if(typeof body.current_code!=='string'||body.current_code.length>200)return reply({success:false},400);
   const challenge=crypto.getRandomValues(new Uint8Array(32));
   const data=await rpc({p_action:'register_begin',p_token_hash:tokenHash,p_challenge:encode(challenge),p_payload:{current_code:body.current_code}});
   if(data.status!=='ok')return failed(data);
   const options=await generateRegistrationOptions({rpName:'교대 근무',rpID,userName:'교대 근무 · '+data.user_name,userDisplayName:data.user_name,userID:new TextEncoder().encode('snnc-user-'+data.user_id),challenge,attestationType:'none',timeout:60000,supportedAlgorithmIDs:[-7,-257],excludeCredentials:data.credentials,authenticatorSelection:{authenticatorAttachment:'platform',residentKey:'required',userVerification:'required'}});
   return reply({success:true,challenge_id:data.challenge_id,options});
  }
  if(action==='login_options'){
   if(typeof body.credential_id!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(body.credential_id))return reply({success:false},400);
   const challenge=crypto.getRandomValues(new Uint8Array(32));
   const data=await rpc({p_action:'login_begin',p_credential_id:body.credential_id,p_challenge:encode(challenge)});
   if(data.status!=='ok')return failed(data);
   const credential=data.credentials.find((c:{id:string})=>c.id===body.credential_id);
   if(!credential)return reply({success:false,message:messages.invalid},401);
   const options=await generateAuthenticationOptions({rpID,challenge,allowCredentials:[credential],timeout:60000,userVerification:'required'});
   return reply({success:true,challenge_id:data.challenge_id,options});
  }
  if(typeof body.challenge_id!=='string'||!/^[-0-9a-f]{36}$/i.test(body.challenge_id)||!body.response||typeof body.response!=='object'||typeof body.response.id!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(body.response.id))return reply({success:false},400);
  const response=body.response;
  if(action==='register_verify'){
   const data=await rpc({p_action:'register_consume',p_token_hash:tokenHash,p_challenge_id:body.challenge_id});
   if(data.status!=='ok')return failed(data);
   const result=await verifyRegistrationResponse({response,expectedChallenge:data.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});
   if(!result.verified||!result.registrationInfo)return reply({success:false,message:messages.invalid},401);
   const info=result.registrationInfo;
   const saved=await rpc({p_action:'register_finish',p_token_hash:tokenHash,p_challenge_id:body.challenge_id,p_credential_id:info.credential.id,p_payload:{public_key:encode(info.credential.publicKey),counter:info.credential.counter,transports:info.credential.transports||[],device_type:info.credentialDeviceType,backed_up:info.credentialBackedUp}});
   return saved.status==='ok'?reply({success:true,credential_id:info.credential.id}):failed(saved);
  }
  const data=await rpc({p_action:'login_consume',p_challenge_id:body.challenge_id,p_credential_id:response.id});
  if(data.status!=='ok')return failed(data);
  const k=data.credential;
  if(response.response?.userHandle&&response.response.userHandle!==encode(new TextEncoder().encode('snnc-user-'+k.user_id)))return reply({success:false,message:messages.invalid},401);
  const result=await verifyAuthenticationResponse({response,expectedChallenge:data.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,credential:{id:k.credential_id,publicKey:decode(k.public_key),counter:Number(k.counter),transports:k.transports}});
  if(!result.verified)return reply({success:false,message:messages.invalid},401);
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  const login=await rpc({p_action:'login_finish',p_token_hash:await digest(token),p_challenge_id:body.challenge_id,p_credential_id:response.id,p_payload:{expected_counter:k.counter,new_counter:result.authenticationInfo.newCounter,backed_up:result.authenticationInfo.credentialBackedUp}});
  return login.status==='ok'?reply({success:true,token,user:login.user,expires_at:login.expires_at}):failed(login);
 }catch{
  // Do not log passwords, session tokens or authenticator responses.
  return reply({success:false,message:'생체인증을 확인하지 못했습니다. 기존 접속코드로 로그인할 수 있습니다.'},400);
 }
});
