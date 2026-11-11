const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const adapter=html.slice(html.indexOf('  async function callSessionRegistration('),html.indexOf('  async function requestOff('));
const registration=html.slice(html.indexOf('  async function acceptRequest('),html.indexOf('  async function cancelSub('));
function setup(role,name,users=[]){
 const calls=[],alerts=[];
 const c=vm.createContext({Date,currentUser:{id:1,name:'Self',team:'C',role,is_active:true},currentSessionToken:'fixture',
  supabaseClient:{functions:{invoke:async(_,{body})=>{calls.push(body);return {data:{success:true,users},error:null};}}},
  chooseSubstitution:async({manual,employeeName})=>name===null?null:manual?name:employeeName,
  alert:m=>alerts.push(m),getSuggestedHelperTeam:()=> 'C조',getShiftInfo:()=> '휴무',
  canRegisterSubstitution:()=>true,isSuperAdmin:()=>role==='admin',isTeamAdmin:()=>role==='team_admin',isManager:()=>role!=='user',loadData:()=>{},
 });
 vm.runInContext(adapter+registration+';globalThis.accept=acceptRequest;',c);
 return {c,calls,alerts};
}
test('superadmin assigns unregistered text to an existing request without employee lookup',async()=>{
 const {c,calls,alerts}=setup('admin','  External (Day)  ');
 await c.accept('request-id','A','2026-11-03','주간');
 assert.equal(calls.length,1);assert.equal(calls[0].action,'sub_register');assert.equal(calls[0].filled_by,'External (Day)');assert.equal(alerts.length,0);
});
test('superadmin can create a new vacancy with literal text',async()=>{
 const {c,calls}=setup('admin','External <test>');
 await c.accept('new_A_2026-11-03','A','2026-11-03','주간');
 assert.equal(calls.length,1);assert.equal(calls[0].action,'vacancy_create');assert.equal(calls[0].filled_by,'External <test>');
});
test('team admin still cannot assign an unregistered person',async()=>{
 const {c,calls,alerts}=setup('team_admin','External');await c.accept('request-id','A','2026-11-03','주간');
 assert.equal(calls.length,1);assert.equal(calls[0].action,'helper_lookup');assert.equal(alerts.length,1);
});
test('team admin lookup and own-team checks remain intact',async()=>{
 const allowed=setup('team_admin','Employee',[{name:'Employee',team:'C'}]);await allowed.c.accept('request-id','A','2026-11-03','주간');
 assert.deepEqual(allowed.calls.map(x=>x.action),['helper_lookup','sub_register']);
 const denied=setup('team_admin','Employee',[{name:'Employee',team:'B'}]);await denied.c.accept('request-id','A','2026-11-03','주간');
 assert.equal(denied.calls.length,1);assert.equal(denied.alerts.length,1);
});
test('blank, cancelled and overlong names never submit',async()=>{
 for(const name of [null,'   ','x'.repeat(201)]){
  const {c,calls}=setup('admin',name);await c.accept('request-id','A','2026-11-03','주간');assert.equal(calls.length,0);
 }
});
test('regular users still register themselves without arbitrary text input',async()=>{
 const {c,calls}=setup('user','External');await c.accept('request-id','A','2026-11-03','주간');
 assert.equal(calls.length,1);assert.equal(calls[0].filled_by,'Self');
});

test('regular users can cancel without registering a substitution',async()=>{
 const {c,calls}=setup('user',null);await c.accept('request-id','A','2026-11-03','주간');
 assert.equal(calls.length,0);
});
test('a substitution dialog left open during a session or role change cannot register',async()=>{
 for(const change of ["currentSessionToken='different-session'","currentUser.role='user'"]){
  const {c,calls}=setup('admin','External');
  vm.runInContext(`chooseSubstitution=async()=>{${change};return 'External';};`,c);
  await c.accept('request-id','A','2026-11-03','주간');
  assert.equal(calls.length,0);
 }
});
