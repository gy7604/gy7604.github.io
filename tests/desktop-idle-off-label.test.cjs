const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const calendar=fs.readFileSync(path.join(root,'assets/calendar.js'),'utf8');
const css=fs.readFileSync(path.join(root,'assets/calendar.css'),'utf8');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20261114195800_desktop_session_three_minute_idle.sql'),'utf8');
const edge=fs.readFileSync(path.join(root,'supabase/functions/app-session/index.ts'),'utf8');
const passkey=fs.readFileSync(path.join(root,'supabase/functions/app-passkey/index.ts'),'utf8');
const start=html.indexOf('  // Desktop-only auto-logout:');
const stop=html.indexOf('  // Fold existing controls',start);
assert.ok(start>0&&stop>start,'desktop idle code exists');
const block=html.slice(start,stop);

function fixture(desktop){
 const clock={time:0},pending=new Map(),events=new Map(),calls=[];
 let next=0;
 const document={addEventListener:(type,cb)=>events.set(type,cb),
  getElementById:()=>({hidden:true,textContent:''})};
 const window={addEventListener:(type,cb)=>events.set(type,cb)};
 const client={functions:{invoke:async(_,{body})=>{
  calls.push(body.action);return{data:{success:true},error:null};
 }}};
 const setup='let currentSessionToken="token",currentUser={id:7},cleared=0;'+
  'function clearSessionScreen(){cleared++;stopDesktopIdle();currentSessionToken="";currentUser=null;}';
 const exportable='return {startDesktopIdle,checkDesktopIdle,onDesktopInput,'+
  'state:()=>({enabled:desktopSessionActive,lastInput:desktopLastInputAt,token:currentSessionToken,cleared})};';
 const make=new Function('document','window','Date','setTimeout','clearTimeout','supabaseClient',
  'closeAppMenu','closeWakeAlarmDialog',setup+block+exportable);
 const ui=make(document,window,{now:()=>clock.time},
  (fn,ms)=>{pending.set(++next,{fn,ms});return next},
  id=>pending.delete(id),client,()=>{},()=>{});
 ui.startDesktopIdle({desktop_session:desktop});
 return {clock,calls,events,...ui};
}

test('PC idle expires exactly at three minutes',async()=>{
 const f=fixture(true);
 f.clock.time=179999;f.checkDesktopIdle();
 assert.equal(f.state().cleared,0);
 f.clock.time=180000;f.checkDesktopIdle();await Promise.resolve();
 assert.equal(f.state().cleared,1);
 assert.equal(f.state().token,'');
 assert.ok(f.calls.includes('logout'));
});

test('human interaction extends deadline and pings server',async()=>{
 const f=fixture(true);
 f.clock.time=170000;f.onDesktopInput({isTrusted:true});
 await Promise.resolve();
 assert.equal(f.state().lastInput,170000);
 assert.ok(f.calls.includes('desktop_activity'));
 f.clock.time=200000;f.checkDesktopIdle();
 assert.equal(f.state().cleared,0);
 f.clock.time=350001;f.checkDesktopIdle();
 assert.equal(f.state().cleared,1);
});

test('synthetic input never extends deadline',()=>{
 const f=fixture(true);
 f.clock.time=170000;f.onDesktopInput({isTrusted:false});
 assert.equal(f.state().lastInput,0);
 f.clock.time=180000;f.checkDesktopIdle();
 assert.equal(f.state().cleared,1);
});

test('mobile login does not get PC timer',()=>{
 const f=fixture(false);
 f.clock.time=300000;f.checkDesktopIdle();
 assert.equal(f.state().cleared,0);
 assert.equal(f.calls.length,0);
});

test('database rejects idle PC token; both login routes bind device class',()=>{
 assert.ok(migration.includes("last_activity_at > now()-interval '3 minutes'"));
 assert.ok(migration.includes('is_desktop boolean NOT NULL DEFAULT false'));
 assert.ok(migration.includes('app_session_desktop_activity'));
 assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.app_session_bind_device'));
 assert.ok(edge.includes('app_session_bind_device'));
 assert.ok(edge.includes('app_session_desktop_activity'));
 assert.ok(passkey.includes('app_session_bind_device'));
});

test('only 휴 inside A휴/B휴/C휴/D휴 is red',()=>{
 assert.ok(calendar.includes('shift-off-letter'));
 assert.ok(calendar.includes("shift === '휴무' ? 'shift-off-letter' : ''"));
 assert.ok(css.includes('.cell-shift .shift-off-letter{color:#d22337!important'));
 assert.ok(html.includes('assets/calendar.js?v=20261114.2'));
});
