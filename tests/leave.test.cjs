const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context=vm.createContext({Intl,Date,currentUser:null});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../assets/leave.js'),'utf8')+';globalThis.ledger=OwnerLeave;',context);
const calc=(rows,year=2027,reset='04-01',total=20,now='2027-11-03')=>context.ledger.calculate(rows,year,reset,total,now);
const row=(date,kind='annual',reason='연차')=>({shift_date:date,leave_kind:kind,reason});
test('reward thresholds, cap and calendar-year boundaries',()=>{
 for(const [used,expected] of [[0,0],[4,0],[5,1],[9,1],[10,2],[14,2],[15,3],[19,3],[20,4],[25,4]]){
  const rows=Array.from({length:used},()=>row('2026-12-31'));
  rows.push(row('2025-12-31'),row('2027-01-01'),row('2026-07-01','reward'));
  assert.equal(calc(rows).reward,expected);
 }
});
test('annual reset differs from reward expiry; future records do not reduce balance',()=>{
 const rows=[row('2027-03-31'),row('2027-04-01'),row('2028-03-31'),row('2028-04-01'),row('2027-11-04','reward'),row('2027-01-01','reward'),row('2028-01-01','reward')];
 const s=calc(rows);assert.equal(s.annualUsed,1);assert.equal(s.annualPlanned,1);assert.equal(s.annualRemaining,19);assert.equal(s.rewardUsed,1);assert.equal(s.rewardPlanned,1);
});
test('special leave, support excluded; unclassified legacy annual and unset total explicit',()=>{
 const rows=[row('2026-01-01',null),row('2026-01-02','annual','청원 휴가'),row('2026-01-03','annual','건강검진 휴가'),row('2026-01-04','annual','지원'),{...row('2026-01-05'),request_kind:'support'}];
 assert.equal(calc(rows).prior,1);assert.equal(calc(rows,2027,'01-01',null).annualRemaining,null);
});
test('today counts as used; stale or inactive and other accounts are not eligible',()=>{
 assert.equal(calc([row('2027-11-03')]).annualUsed,1);
 for(const user of [null,{id:30,is_active:true},{id:29,is_active:false}]){context.currentUser=user;assert.equal(context.ledger.eligible(),false);}
 context.currentUser={id:29,is_active:true};assert.equal(context.ledger.eligible(),true);
});
test('reward expires after December 31 and never carries into next year',()=>{
 const rows=Array.from({length:10},()=>row('2026-05-01'));
 assert.equal(calc(rows,2027,'04-01',20,'2027-12-31').rewardRemaining,2);
 const expired=calc(rows,2027,'04-01',20,'2028-01-01');
 assert.equal(expired.rewardRemaining,0);assert.equal(expired.rewardUnused,2);assert.equal(expired.rewardExpired,true);
});
