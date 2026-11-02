const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const helper=html.slice(html.indexOf('  async function callSessionRegistration('),html.indexOf('  async function requestOff('));
function setup(data){
 const c=vm.createContext({currentUser:{id:29,is_active:true},currentSessionToken:'fixture',supabaseClient:{functions:{invoke:async()=>({data,error:null})}},Intl,Date});
 vm.runInContext(helper+';globalThis.call=callSessionRegistration;',c);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/leave.js'),'utf8')+';globalThis.ledger=OwnerLeave;',c);
 return c;
}
test('actual session response adapter preserves leave settings and existing records',async()=>{
 const rows=['2026-10-10','2026-10-18','2026-10-26','2026-11-20'].map(shift_date=>({shift_date,reason:'연차',leave_kind:null}));
 const c=setup({success:true,settings:{reset:'01-15',total:23},rows});
 const result=await c.call({action:'leave_read',year:2026});
 assert.equal(result.settings?.reset,'01-15');assert.equal(result.settings.total,23);assert.equal(result.rows.length,4);
 const summary=c.ledger.calculate(result.rows,2026,result.settings.reset,result.settings.total,'2026-11-03');
 assert.equal(summary.annualUsed,3);assert.equal(summary.annualPlanned,1);assert.equal(summary.annualRemaining,20);
});
test('empty ledger preserves unset settings without inventing totals',async()=>{
 const c=setup({success:true,settings:null,rows:[]});const result=await c.call({action:'leave_read',year:2026});
 assert.equal(result.settings,null);assert.equal(result.rows.length,0);
});
test('incomplete server responses fail visibly instead of displaying zero usage',async()=>{
 const c=setup({success:true});const result=await c.call({action:'leave_read',year:2026});
 assert.equal(result.success,false);assert.ok(result.message);
});
