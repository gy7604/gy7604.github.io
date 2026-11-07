const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {webcrypto}=require('node:crypto');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const choiceSource=html.slice(html.indexOf('  function offReasonIncludesOwnName('),html.indexOf('  async function requestOff('));
const requestSource=html.slice(html.indexOf('  async function requestOff('),html.indexOf('  async function acceptRequest('));
function dialogFixture(){
 const listeners=new Map();
 const input={value:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;},focus(){},addEventListener(k,f){listeners.set('input:'+k,f);},removeEventListener(k){listeners.delete('input:'+k);}};
 const warning={hidden:true,textContent:''},button={disabled:false};
 const dialog={open:false,querySelector:()=>button,contains:()=>true,addEventListener(k,f){listeners.set(k,f);},removeEventListener(k){listeners.delete(k);},showModal(){this.open=true;},close(){this.open=false;listeners.get('close')?.();}};
 const elements={offReasonDialog:dialog,offReasonContext:{textContent:''},offReasonText:input,offReasonWarning:warning};
 const c=vm.createContext({currentUser:{name:'가상사용자'},document:{getElementById:id=>elements[id]}});
 vm.runInContext(choiceSource+';globalThis.choose=chooseOffReason;globalThis.includesName=offReasonIncludesOwnName;',c);
 return {c,input,warning,button,dialog,listeners,
  type(value){input.value=value;listeners.get('input:input')?.();},
  click(choice){listeners.get('click')?.({target:{closest:()=>({dataset:{offReasonChoice:choice}})}});}
 };
}
test('rejects full own name, mixed reasons, whitespace, invisible characters and decomposed Hangul',()=>{
 const {c}=dialogFixture();
 for(const reason of ['가상사용자','가상사용자/검진','검진 (가상사용자)','가 상 사 용 자','가상\n사용자','가상\u200B사용자','가상사용자'.normalize('NFD'),'가상사용자 지원']){
  assert.equal(c.includesName(reason,'가상사용자'),true,JSON.stringify(reason));
 }
});
test('keeps blank, ordinary and support reasons; does not infer other people or partial names',()=>{
 const {c}=dialogFixture();
 for(const reason of ['',null,'검진','정수 지원','다른사용자 병원동행','사용자','개인 사정'])assert.equal(c.includesName(reason,'가상사용자'),false);
 assert.equal(c.includesName('검진',''),false);
});
test('typing own name shows an accessible warning and disables only reasoned registration',async()=>{
 const f=dialogFixture(),done=f.c.choose('A','2026-11-13');
 f.type('가상사용자/검진');
 assert.equal(f.warning.hidden,false);assert.match(f.warning.textContent,/본인 이름/);
 assert.equal(f.input.attrs['aria-invalid'],'true');assert.equal(f.button.disabled,true);
 assert.equal(f.input.value,'가상사용자/검진');
 f.type('검진');assert.equal(f.warning.hidden,true);assert.equal(f.button.disabled,false);
 assert.equal(f.input.attrs['aria-invalid'],'false');f.click('with');assert.equal(await done,'검진');
});
test('submission guard rejects own name even if a synthetic click bypasses the disabled button',async()=>{
 const f=dialogFixture(),done=f.c.choose('A','2026-11-13');
 f.type('가상사용자');f.click('with');assert.equal(f.dialog.open,true);
 f.click('cancel');assert.equal(await done,null);
});
test('reasonless registration remains available when an unwanted name was typed',async()=>{
 const f=dialogFixture(),done=f.c.choose('A','2026-11-13');
 f.type('가상사용자');f.click('plain');assert.equal(await done,'');
 assert.equal(f.input.value,'');assert.equal(f.button.disabled,false);
});
test('empty reasoned registration still explains the reasonless option',async()=>{
 const f=dialogFixture(),done=f.c.choose('A','2026-11-13');
 f.click('with');assert.equal(f.dialog.open,true);assert.match(f.warning.textContent,/사유 없이 등록/);
 f.click('plain');assert.equal(await done,'');
});
test('closing resets validation and listeners for reopening',async()=>{
 const f=dialogFixture(),done=f.c.choose('A','2026-11-13');
 f.type('가상사용자');f.click('cancel');assert.equal(await done,null);assert.equal(f.listeners.size,0);
 const second=f.c.choose('A','2026-11-14');assert.equal(f.warning.hidden,true);assert.equal(f.button.disabled,false);
 f.click('plain');assert.equal(await second,'');
});
function requestFixture(reason){
 const calls=[],alerts=[];
 const c=vm.createContext({currentUser:{id:3,name:'가상사용자',team:'A'},currentSessionToken:'fixture-session',
 isTeamAdmin:()=>false,isSuperAdmin:()=>false,isSupportReason:r=>/정수|지원/.test(r),
 requestsData:[],isSupportRequest:()=>false,isOwnRequest:()=>false,
 OwnerLeave:{eligible:()=>false},alert:m=>alerts.push(m),loadData:()=>{},
 callSessionRegistration:async body=>{calls.push(body);return {success:true};}});
 vm.runInContext(choiceSource+requestSource+';globalThis.chooseOffReason=async()=>'+JSON.stringify(reason)+';globalThis.request=requestOff;',c);
 return {c,calls,alerts};
}
test('last client gate prevents an alternate reason chooser from submitting an own name',async()=>{
 const f=requestFixture('가상사용자/검진');await f.c.request('2026-11-13','주간','A');
 assert.equal(f.calls.length,0);assert.match(f.alerts[0],/본인 이름/);
});
test('ordinary and blank reasons still reach the same server action',async()=>{
 for(const reason of ['','검진','정수 지원']){
  const f=requestFixture(reason);await f.c.request('2026-11-13','주간','A');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'request_create');assert.equal(f.calls[0].reason,reason);
 }
});
test('a session change while choosing a reason never submits',async()=>{
 const f=requestFixture('검진');
 vm.runInContext("chooseOffReason=async()=>{currentSessionToken='different-session';return '검진';};",f.c);
 await f.c.request('2026-11-13','주간','A');assert.equal(f.calls.length,0);
});
function edgeFixture(result){
 let handler;const calls=[];
 const c=vm.createContext({Request,Response,Headers,TextEncoder,Uint8Array,crypto:webcrypto,AbortSignal,
 Deno:{env:{get:key=>key==='SUPABASE_URL'?'https://fixture.invalid':key==='SUPABASE_SERVICE_ROLE_KEY'?'synthetic-server-key':undefined},serve:fn=>{handler=fn;}},
 fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify(result),{status:200});}});
 const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/app-session/index.ts'),'utf8');
 vm.runInContext(stripTypeScriptTypes(source),c);
 return {calls,call:body=>handler(new Request('https://fixture.invalid/app-session',{method:'POST',headers:{'content-type':'application/json','x-app-session':'a'.repeat(64)},body:JSON.stringify(body)}))};
}
test('Edge API maps the name rejection to a clear HTTP 400 without exposing account details',async()=>{
 const f=edgeFixture({status:'reason_contains_name'});
 const response=await f.call({action:'request_create',team:'A',date:'2026-11-13',reason:'가상사용자'});
 assert.equal(response.status,400);const body=await response.json();
 assert.equal(body.success,false);assert.match(body.message,/본인 이름/);assert.equal(f.calls.length,1);
});
test('owner leave uses the same rejection and the protected leave RPC',async()=>{
 const f=edgeFixture({status:'reason_contains_name'});
 const response=await f.call({action:'request_create',team:'A',date:'2026-11-13',reason:'가상사용자',leave_kind:'annual'});
 assert.equal(response.status,400);assert.match(f.calls[0].url,/app_session_leave_create$/);
});
test('successful reasonless submission keeps the existing success response',async()=>{
 const f=edgeFixture({status:'ok',request_id:'fixture-request'});
 const response=await f.call({action:'request_create',team:'A',date:'2026-11-13',reason:''});
 assert.equal(response.status,200);assert.equal((await response.json()).success,true);
});

