const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=readFileSync(path.join(__dirname,'../assets/weather.js'),'utf8');
const today=new Intl.DateTimeFormat('sv-SE',{
 timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'
}).format(new Date());
function dayAfter(n){
 const date=new Date(today+'T00:00:00Z');
 date.setUTCDate(date.getUTCDate()+n);
 return date.toISOString().slice(0,10);
}
function element(){
 const x={
  className:'',textContent:'',hidden:false,disabled:false,dataset:{},attrs:{},
  children:[],setAttribute(k,v){this.attrs[k]=v},
  addEventListener(){},append(child){this.children.push(child)},
  remove(){this.removed=true},
  querySelector(s){
   return s==='span'?this.statusEl:s==='button'?this.buttonEl:
    s==='.day-date-part'?this.header:s==='.weather-badge'?
     this.children.find(c=>!c.removed):null;
  },
  classList:{toggle(key,value){x.attrs[key]=value}},
  showModal(){this.open=true},close(){this.open=false},
  closest(){return this}
 };
 return x;
}
function payload(){
 return {daily:{
  time:[today,dayAfter(1)],
  weather_code:[0,61],
  temperature_2m_min:[4,5],
  temperature_2m_max:[12,13],
  precipitation_probability_max:[15,80]
 }};
}
async function weatherFixture({offline=false,priorCache=false}={}){
 const storage=new Map(),timeouts=[],grid=element(),events={};
 let credit,callCount=0;
 const cells=[dayAfter(-1),today,dayAfter(1),dayAfter(8)].map(date=>{
  const node=element();node.id='calendar-day-'+date;node.header=element();return node;
 });
 if(priorCache){
  storage.set('shift-weather-gwangyang-geumho-v1',JSON.stringify({
   day:dayAfter(-1),time:Date.now()-7*3600000,
   rows:[{date:today,code:3,min:4,max:8,rain:20}]
  }));
 }
 grid.closest=()=>({after(node){
  credit=node;node.statusEl=element();node.buttonEl=element();
 }});
 grid.addEventListener=(name,handler)=>{events[name]=handler};
 const document={
  readyState:'complete',visibilityState:'visible',
  getElementById(id){return id==='calendarGrid'?grid:null},
  querySelectorAll(q){return q==='#calendarGrid .day-cell'?cells:[]},
  createElement(){return element()},
  body:{append(node){node.buttonEl=element()}},
  addEventListener(){}
 };
 const context={
  document,window:{addEventListener(){}},navigator:{onLine:true},
  localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,v)=>storage.set(key,v)},
  setTimeout:(handler,ms)=>{timeouts.push({handler,ms});return timeouts.length},
  setInterval:()=>1,clearTimeout:()=>{},
  AbortController,URLSearchParams,Date,Intl,
  requestAnimationFrame:handler=>handler(),
  MutationObserver:class{constructor(handler){this.handler=handler}observe(){}},
  fetch:async()=>{
   callCount++;
   if(offline)throw new Error('unavailable');
   return {ok:true,json:async()=>payload()};
  }
 };
 vm.runInNewContext(source,context,{timeout:3000});
 for(let i=0;i<15;i++)await Promise.resolve();
 const badge=date=>cells.find(c=>c.id==='calendar-day-'+date)
  ?.header?.children.find(e=>!e.removed);
 return {cells,badge,credit,timeouts,callCount};
}

test('online weather renders real condition only within the seven-day forecast',async()=>{
 const result=await weatherFixture();
 assert.equal(result.callCount,1);
 assert.equal(result.badge(today)?.textContent,'☀️');
 assert.equal(result.badge(dayAfter(1))?.textContent,'🌧️');
 assert.equal(result.badge(dayAfter(-1)),undefined);
 assert.equal(result.badge(dayAfter(8)),undefined);
});

test('offline requests show an explicit fallback instead of an empty date header',async()=>{
 const result=await weatherFixture({offline:true});
 assert.equal(result.badge(today)?.textContent,'⚠️');
 assert.match(result.badge(today)?.attrs['aria-label'],/예보 연결 실패/);
 assert.match(result.credit?.statusEl?.textContent,/날씨 조회 실패/);
 assert.ok(result.timeouts.some(t=>t.ms===60000),'retry should be scheduled for 60 seconds');
});

test('a recent prior-day forecast remains visible with a stale warning',async()=>{
 const result=await weatherFixture({offline:true,priorCache:true});
 assert.equal(result.badge(today)?.textContent,'☁️');
 assert.equal(result.badge(today)?.attrs['weather-stale'],true);
 assert.match(result.credit?.statusEl?.textContent,/이전 조회/);
 assert.equal(result.badge(dayAfter(1))?.textContent,'⚠️');
});
