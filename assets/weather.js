/* Gwangyang forecast badges. Independent of leave/memo registration. */
(function(){
'use strict';
const REGION={name:'광양시 금호동',latitude:34.9374,longitude:127.7246};
const CACHE_KEY='shift-weather-gwangyang-geumho-v1',TTL=30*60*1000,MAX_AGE=6*60*60*1000;
const STATES={
0:['☀️','맑음'],1:['🌤️','대체로 맑음'],2:['⛅','구름 조금'],3:['☁️','흐림'],
45:['🌫️','안개'],48:['🌫️','착빙 안개'],
51:['🌦️','약한 이슬비'],53:['🌦️','이슬비'],55:['🌧️','강한 이슬비'],
56:['🌧️','약한 어는 이슬비'],57:['🌧️','강한 어는 이슬비'],
61:['🌧️','약한 비'],63:['🌧️','비'],65:['🌧️','강한 비'],
66:['🌧️','약한 어는 비'],67:['🌧️','강한 어는 비'],
71:['🌨️','약한 눈'],73:['🌨️','눈'],75:['❄️','강한 눈'],77:['🌨️','싸락눈'],
80:['🌦️','약한 소나기'],81:['🌧️','소나기'],82:['🌧️','강한 소나기'],
85:['🌨️','약한 눈 소나기'],86:['❄️','강한 눈 소나기'],
95:['⛈️','뇌우'],96:['⛈️','우박 동반 뇌우'],97:['⛈️','강한 뇌우'],99:['⛈️','강한 우박 동반 뇌우']
};
function dayKey(now=new Date()){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)}
function dayAfter(key,days){const d=new Date(key+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function state(code){return typeof code==='number'&&Number.isInteger(code)?STATES[code]||null:null}
function finite(value,min,max){return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:null}
function normalize(payload,today=dayKey()){
 const daily=payload?.daily;
 if(!daily||!Array.isArray(daily.time)||!Array.isArray(daily.weather_code)||daily.time.length>16||daily.weather_code.length!==daily.time.length)throw new Error('invalid forecast');
 const rows=[];
 for(let i=0;i<daily.time.length;i++){
  const date=daily.time[i],code=daily.weather_code[i];
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<today||date>dayAfter(today,6)||!state(code))continue;
  if(new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)continue;
  rows.push({date,code,min:finite(daily.temperature_2m_min?.[i],-100,70),max:finite(daily.temperature_2m_max?.[i],-100,70),rain:finite(daily.precipitation_probability_max?.[i],0,100)});
 }
 if(!rows.length)throw new Error('no valid forecast');
 return rows;
}
function url(){const q=new URLSearchParams({latitude:String(REGION.latitude),longitude:String(REGION.longitude),daily:'weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max',timezone:'Asia/Seoul',forecast_days:'7'});return 'https://api.open-meteo.com/v1/forecast?'+q}
let rows=[],fetchedAt=0,inflight=null,nextAttempt=0,credit,dialog,status='idle',renderPending=false;
function readCache(){try{const v=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');if(!v||v.day!==dayKey()||typeof v.time!=='number'||v.time>Date.now()||Date.now()-v.time>MAX_AGE||!Array.isArray(v.rows))return null;
 const payload={daily:{time:v.rows.map(r=>r.date),weather_code:v.rows.map(r=>r.code),temperature_2m_min:v.rows.map(r=>r.min),temperature_2m_max:v.rows.map(r=>r.max),precipitation_probability_max:v.rows.map(r=>r.rain)}};
 return {rows:normalize(payload),time:v.time}}catch{return null}}
function timeLabel(){return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(fetchedAt)}
function validRows(){const today=dayKey();if(!fetchedAt||Date.now()-fetchedAt>MAX_AGE)return [];return rows.filter(r=>r.date>=today&&r.date<=dayAfter(today,6))}
function apply(){
 if(!credit)return;
 const data=validRows(),byDate=new Map(data.map(r=>[r.date,r]));
 document.querySelectorAll('#calendarGrid .day-cell').forEach(cell=>{
  const date=cell.id.slice('calendar-day-'.length),header=cell.querySelector('.day-date-part');if(!header)return;
  const row=byDate.get(date);let button=header.querySelector('.weather-badge');
  if(!row){button?.remove();return}
  const [icon,label]=state(row.code),old=status==='error'||Date.now()-fetchedAt>TTL;
  const text=REGION.name+' '+date+' '+label+' 예보'+(old?' · 이전 조회 자료':'');
  if(!button){button=document.createElement('button');button.type='button';button.className='weather-badge';button.dataset.weatherDate=date;header.append(button)}
  if(button.textContent!==icon)button.textContent=icon;
  button.title=text;button.setAttribute('aria-label',text);button.classList.toggle('weather-stale',old);
 });
 const p=credit.querySelector('span');
 p.textContent=REGION.name+' · 오늘부터 7일 예보'+(status==='loading'?' · 불러오는 중':status==='error'?(data.length?' · 갱신 실패, 이전 조회 '+timeLabel()+' 자료':' · 날씨 연결을 확인해 주세요'):data.length?' · 조회 '+timeLabel():'');
 credit.querySelector('button').hidden=status!=='error';credit.querySelector('button').disabled=!!inflight;
}
function queueApply(){if(renderPending)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;apply()})}
async function refresh(force=false){
 if(inflight)return inflight;
 if(!force&&Date.now()<nextAttempt)return;
 const cache=readCache();if(cache){rows=cache.rows;fetchedAt=cache.time}
 if(!force&&cache&&Date.now()-fetchedAt<TTL){status='ready';apply();return}
 status='loading';apply();
 inflight=(async()=>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetch(url(),{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});
  if(!response.ok)throw new Error('weather unavailable');
  const fresh=normalize(await response.json());
  rows=fresh;fetchedAt=Date.now();status='ready';nextAttempt=Date.now()+TTL;
  try{localStorage.setItem(CACHE_KEY,JSON.stringify({day:dayKey(),time:fetchedAt,rows}))}catch{}
 }catch{status='error';nextAttempt=Date.now()+60000}
 finally{clearTimeout(timer);inflight=null;apply()}
 })();return inflight;
}
function openDetails(date){
 const row=validRows().find(r=>r.date===date);if(!row)return;
 const [icon,label]=state(row.code);
 dialog.querySelector('h2').textContent=icon+' '+label;
 dialog.querySelector('.weather-location').textContent=REGION.name+' · '+date;
 const temp=x=>x===null?'정보 없음':Math.round(x)+'°C';
 dialog.querySelector('.weather-temperature').textContent='최저 '+temp(row.min)+' / 최고 '+temp(row.max);
 dialog.querySelector('.weather-rain').textContent='강수확률 '+(row.rain===null?'정보 없음':Math.round(row.rain)+'%');
 dialog.querySelector('.weather-updated').textContent='조회 '+timeLabel()+(status==='error'||Date.now()-fetchedAt>TTL?' · 이전 조회 자료':'');
 if(!dialog.open)dialog.showModal();
}
function init(){
 const grid=document.getElementById('calendarGrid');if(!grid)return;
 const calendar=grid.closest('.app-calendar');if(!calendar)return;
 credit=document.createElement('div');credit.className='weather-credit';
 credit.innerHTML='<span role="status"></span> <button type="button" hidden>날씨 다시 시도</button> <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">날씨 자료: Open-Meteo</a>';
 calendar.after(credit);credit.querySelector('button').addEventListener('click',()=>{if(Date.now()>=nextAttempt)refresh(true)});
 dialog=document.createElement('dialog');dialog.className='weather-dialog';dialog.setAttribute('aria-labelledby','weatherDialogTitle');
 dialog.innerHTML='<h2 id="weatherDialogTitle"></h2><p class="weather-location"></p><p class="weather-temperature"></p><p class="weather-rain"></p><p class="weather-updated"></p><p class="weather-note">하루 대표 예보이며 시간대별 날씨는 다를 수 있습니다. 예보 범위 밖의 날짜에는 아이콘이 표시되지 않습니다.</p><button type="button">닫기</button>';
 document.body.append(dialog);dialog.querySelector('button').addEventListener('click',()=>dialog.close());
 grid.addEventListener('click',event=>{const badge=event.target.closest('.weather-badge');if(badge){event.stopPropagation();openDetails(badge.dataset.weatherDate)}});
 new MutationObserver(queueApply).observe(grid,{childList:true});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){apply();refresh()}});
 window.addEventListener('online',()=>refresh());
 setInterval(()=>{if(document.visibilityState==='visible'){apply();refresh()}},TTL);
 refresh();
}
window.ShiftWeather={dayKey,dayAfter,state,normalize,refresh};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();