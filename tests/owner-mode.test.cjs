const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const adapter=html.slice(html.indexOf('  async function callSessionRegistration('),html.indexOf('  async function requestOff('));
const controls=html.slice(html.indexOf('let ownerModeBusy=false;'),html.indexOf('function auditMessage('));
function setup(respond){
 const elements=new Map(),calls=[],alerts=[],messages=[];
 const el=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',open:false,attrs:{},setAttribute(k,v){this.attrs[k]=v;},close(){this.open=false;},replaceChildren(){this.cleared=true;}});return elements.get(id);};
 const c=vm.createContext({currentUser:{id:29,name:'Owner',team:'B',role:'user',is_active:true,owner_admin_mode:false},currentSessionToken:'fixture',
  auditEl:el,OwnerLeave:{refresh(){},clear(){}},clearTimeout,closeAppMenu(){},calendarConnection:m=>messages.push(m),loadData:async()=>{},alert:m=>alerts.push(m),
  supabaseClient:{functions:{invoke:async(_,{body})=>{calls.push(body);return respond?respond(body,c):{data:{success:true,user:{...c.currentUser,role:body.enabled?'admin':'user',owner_admin_mode:body.enabled}},error:null};}}},
 });
 c.isSuperAdmin=()=>c.currentUser?.role==='admin';c.isTeamAdmin=()=>c.currentUser?.role==='team_admin';
 vm.runInContext('let personalViewVersion=0,historyViewVersion=0,credentialViewVersion=0,historySearchTimer;let personalViewRows=[],historyViewRows=[],credentialViewUsers=[];'+adapter+controls+';globalThis.toggle=toggleOwnerAdminMode;globalThis.refresh=refreshOwnerModeButton;',c);
 return {c,el,calls,alerts,messages};
}
test('only owner sees the mode button',()=>{
 const {c,el}=setup();c.refresh();assert.equal(el('ownerModeTools').hidden,false);
 for(const user of [null,{id:30,is_active:true,role:'admin'},{id:29,is_active:false}]){c.currentUser=user;c.refresh();assert.equal(el('ownerModeTools').hidden,true);}
});
test('server response switches both ways and clears privileged dialogs',async()=>{
 const {c,el,calls}=setup();el('credentialDialog').open=true;
 await c.toggle();assert.equal(c.currentUser.id,29);assert.equal(c.currentUser.role,'admin');assert.equal(c.currentUser.owner_admin_mode,true);
 assert.equal(el('ownerModeToggle').attrs['aria-pressed'],'true');assert.equal(el('ownerModeToggle').textContent,'일반 모드로 전환');assert.equal(el('credentialDialog').open,false);
 await c.toggle();assert.equal(c.currentUser.role,'user');assert.equal(el('adminTools').hidden,true);assert.equal(el('credentialResults').cleared,true);
 assert.deepEqual(calls.map(x=>x.enabled),[true,false]);
});
test('lost switch response recovers the authoritative mode through verify',async()=>{
 const {c,calls}=setup(async(body,c)=>body.action==='owner_mode'?{data:null,error:{}}:{data:{success:true,user:{...c.currentUser,role:'admin',owner_admin_mode:true}},error:null});
 await c.toggle();assert.equal(c.currentUser.role,'admin');assert.deepEqual(calls.map(x=>x.action),['owner_mode','verify']);
});
test('incomplete replies never grant local admin privileges',async()=>{
 const {c,el,messages}=setup(async()=>({data:{success:true},error:null}));await c.toggle();
 assert.equal(c.currentUser.role,'user');assert.equal(el('adminTools').hidden,true);assert.ok(messages.at(-1).includes('확인하지 못했습니다'));
});
test('late mode replies cannot affect another logged-in account',async()=>{
 let resolve;const {c}=setup(()=>new Promise(r=>resolve=r));
 const work=c.toggle();c.currentSessionToken='other';c.currentUser={id:30,role:'user',is_active:true};
 resolve({data:{success:true,user:{id:29,role:'admin',is_active:true,owner_admin_mode:true}},error:null});await work;
 assert.equal(c.currentUser.id,30);assert.equal(c.currentUser.role,'user');
});
test('repeated clicks send one switch request',async()=>{
 let resolve;const {c,calls}=setup(()=>new Promise(r=>resolve=r));const work=c.toggle();await c.toggle();assert.equal(calls.length,1);
 resolve({data:{success:true,user:{...c.currentUser,role:'admin',owner_admin_mode:true}},error:null});await work;
});
