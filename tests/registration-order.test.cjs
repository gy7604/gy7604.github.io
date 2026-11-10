const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/calendar.js'),'utf8');
function fixture(own=false){
  const nodes=[],deleted=[];
  const document={createElement(tag){const el={tag,children:[],listeners:{},setAttribute(){},append(...items){this.children.push(...items)},addEventListener(k,f){this.listeners[k]=f},showModal(){this.open=true},close(){this.open=false;this.listeners.close?.()},remove(){this.removed=true}};nodes.push(el);return el},body:{append(el){this.dialog=el}}};
  const c=vm.createContext({document,requestsData:[{id:'a',requested_by:'샘플',created_at:'2026-11-09T00:43:54Z'}],currentUser:{},isOwnRequest:()=>own,isSuperAdmin:()=>false,deleteRequest:(...args)=>deleted.push(args)});
  vm.runInContext(source,c);
  return {c,document,nodes,deleted};
}
test('oldest registration wins even when IDs and input order disagree; missing times last',()=>{
 const {c}=fixture();
 const rows=[{id:'a',created_at:'2026-11-09T00:00:00Z'},{id:'z',created_at:'2026-10-02T00:00:00Z'},{id:'b',created_at:'2026-11-06T00:00:00Z'},{id:'0'}];
 assert.deepEqual(rows.sort(c.compareRequestRegistration).map(r=>r.id),['z','b','a','0']);
 assert.equal(c.compareRequestRegistration({id:'a'},{id:'b'}),-1);
});
test('timestamp uses Korea time including midnight rollover and handles missing data',()=>{
 const {c}=fixture();
 assert.equal(c.requestRegistrationLabel({created_at:'2026-11-09T16:43:54Z'}),'등록 시각: 2026-11-10 01:43:54 (한국시간)');
 assert.equal(c.requestRegistrationLabel({}),'등록 시각 정보 없음');
});
test('viewing another registration never offers cancellation or deletes data',()=>{
 const {c,document,deleted}=fixture();c.showRequestRegistration('a');
 const dialog=document.body.dialog;
 assert.equal(dialog.open,true);assert.equal(dialog.children[2].children.length,1);
 assert.match(dialog.children[1].textContent,/09:43:54/);
 dialog.children[2].children[0].onclick();assert.equal(dialog.removed,true);assert.equal(deleted.length,0);
});
test('own registration opens information first and cancellation delegates to existing confirmation',()=>{
 const {c,document,deleted}=fixture(true);c.showRequestRegistration('a');
 assert.equal(deleted.length,0);
 document.body.dialog.children[2].children[1].onclick();
 assert.deepEqual(deleted,[['a','휴무 신청']]);assert.equal(document.body.dialog.removed,true);
});
