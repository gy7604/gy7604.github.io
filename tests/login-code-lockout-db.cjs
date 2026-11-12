// Usage: node tests/login-code-lockout-db.cjs /absolute/path/to/pglite/dist/index.js
// Uses a local PostgreSQL instance and a mocked Edge transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHmac, webcrypto } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const base = read('supabase/migrations/20261111172900_team_admin_eight_digit_pin.sql');
const stability = read('supabase/stability-2026-10-13.sql');
const functionDefinition = (sql, name, delimiter = 'function') => {
  const start = sql.toLowerCase().indexOf('function '+name+'(');
  const tag = '$'+delimiter+'$';
  const bodyStart = sql.indexOf(tag,start);
  const end = sql.indexOf(tag,bodyStart+tag.length);
  assert.ok(start > 0 && bodyStart > start && end > bodyStart,name);
  return 'CREATE OR REPLACE '+sql.slice(start,end+tag.length)+';';
};

function syntheticLookup(secret, code) {
  const lookupKey = createHmac('sha256', secret).update('snnc:login-lookup:key:v1').digest();
  return {
    hash: createHmac('sha256', lookupKey).update('snnc:login-lookup:code:v1:'+code).digest('hex'),
    keyId: createHmac('sha256', lookupKey).update('snnc:login-lookup:key-id:v1').digest('hex'),
  };
}

async function main() {
  if (!process.argv[2]) throw new Error('Provide the installed PGlite entry point');
  const entry = path.resolve(process.argv[2]);
  const { PGlite } = await import(pathToFileURL(entry).href);
  const { pgcrypto } = await import(pathToFileURL(path.join(path.dirname(entry), 'contrib/pgcrypto.js')).href);
  const db = new PGlite({ extensions:{ pgcrypto } });
  try {
    await db.exec(String.raw`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA private;
      CREATE SCHEMA extensions;
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE TABLE public.app_users (
        id bigint PRIMARY KEY, name text, team text, role text, is_active boolean NOT NULL,
        login_code_hash text NOT NULL, credential_version bigint NOT NULL DEFAULT 1
      );
      CREATE TABLE private.app_login_limits (bucket text PRIMARY KEY, window_start timestamptz NOT NULL, attempts int NOT NULL);
      CREATE TABLE private.app_code_lookup (
        user_id bigint PRIMARY KEY, lookup_key_id text, lookup_hash text,
        credential_version bigint, updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE private.app_team_admin_pin_upgrade_required (user_id bigint PRIMARY KEY);
      CREATE TABLE private.app_short_code_upgrade_required (user_id bigint PRIMARY KEY, marked_at timestamptz);
      CREATE TABLE private.app_passkey_code_recheck (user_id bigint PRIMARY KEY);
      CREATE TABLE private.app_passkeys (user_id bigint, credential_version bigint);
      CREATE TABLE private.app_sessions (
        token_hash text PRIMARY KEY, user_id bigint, credential_version bigint,
        expires_at timestamptz, revoked_at timestamptz
      );
      CREATE FUNCTION private.app_code_matches(code text, hash text) RETURNS boolean
      LANGUAGE sql AS $$SELECT extensions.crypt(code,hash)=hash$$;
      CREATE FUNCTION private.app_hash_code(code text) RETURNS text
      LANGUAGE sql AS $$SELECT extensions.crypt(code,extensions.gen_salt('bf',4))$$;
    `);
    await db.exec(functionDefinition(stability, 'public.app_session_login_guard',''));
    for (const fn of ['app_session_login_fast','app_session_upgrade_short_code'])
      await db.exec(functionDefinition(base,'public.'+fn));
    await db.exec(functionDefinition(base,'public.app_session_upgrade_team_admin_pin','upgrade'));
    await db.exec(functionDefinition(base,'private.app_valid_team_admin_pin','validator'));
    await db.exec(read('supabase/migrations/20261112133000_code_attempt_lockout.sql'));

    const loginCode = 'Synthetic#Entry73';
    const legacyCode = '4072';
    const oldLookup = syntheticLookup('synthetic-old-service-role', loginCode);
    const newLookup = syntheticLookup('synthetic-new-dedicated-lookup-key', loginCode);
    await db.query("insert into public.app_users (id,name,team,role,is_active,login_code_hash) values (1,'테스트 직원','A','user',true,private.app_hash_code($1)),(2,'테스트 구형 계정','B','user',true,private.app_hash_code($2))", [loginCode,legacyCode]);
    await db.query("insert into private.app_code_lookup(user_id,lookup_key_id,lookup_hash,credential_version) values(1,$1,$2,1)",[oldLookup.keyId,oldLookup.hash]);

    let handler;
    const lookupEnv = { SUPABASE_URL:'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-role' };
    let verified = 0;
    const context = vm.createContext({
      Deno:{ env:{get:name=>lookupEnv[name]}, serve:fn=>{handler=fn;} },
      Response, Request, AbortSignal, TextEncoder, crypto:webcrypto,
      fetch:async(url, init)=>{
        assert.equal(new URL(url).origin,'https://db.example.test');
        assert.equal(init.headers.apikey,'synthetic-service-role');
        const body=JSON.parse(init.body);
        if (url.endsWith('/app_session_login_guard')) {
          const {rows}=await db.query('select public.app_session_login_guard($1,$2) as payload',[body.p_lookup_hash,body.p_peer_hash]);
          return Response.json(rows[0].payload);
        }
        assert.ok(url.endsWith('/app_session_code_attempt'));
        assert.notEqual(body.p_peer_hash,'192.0.2.10');
        if (body.p_browser_hash) assert.match(body.p_browser_hash,/^[0-9a-f]{64}$/);
        const {rows}=await db.query('select public.app_session_code_attempt($1,$2,$3,$4,$5,$6,$7,$8) as payload',
          [body.p_action,body.p_code,body.p_new_code,body.p_token_hash,body.p_lookup_hash,body.p_lookup_key_id,body.p_peer_hash,body.p_browser_hash]);
        verified++;
        return Response.json(rows[0].payload);
      },
    });
    vm.runInContext(stripTypeScriptTypes(read('supabase/functions/app-session/index.ts')),context);
    const send = async (body,peer='192.0.2.10') => {
      const response = await handler(new Request('https://edge.example.test/app-session',{
        method:'POST',headers:{'cf-connecting-ip':peer},body:JSON.stringify(body),
      }));
      return {status:response.status,headers:response.headers,data:await response.json()};
    };
    const browser = '0123456789abcdef'.repeat(2);
    const other = 'fedcba9876543210'.repeat(2);
    const auth = (code,browser_id=browser) => send({action:'login',code,browser_id});
    assert.equal((await auth(loginCode)).status,503);
    assert.equal(verified,0,'missing lookup secret never falls back to the service-role key');
    lookupEnv.APP_LOGIN_LOOKUP_SECRET='synthetic-new-dedicated-lookup-key';

    const success=await auth(loginCode);
    assert.equal(success.status,200);
    assert.equal(success.data.user.id,1);
    const {rows:lookups}=await db.query('select lookup_key_id,lookup_hash,credential_version from private.app_code_lookup where user_id=1');
    assert.deepEqual(lookups,[{lookup_key_id:newLookup.keyId,lookup_hash:newLookup.hash,credential_version:1}]);

    for (let n=0;n<2;n++) assert.equal((await auth('Wrong#'+n)).status,401);
    assert.equal((await auth(loginCode)).status,200,'success clears browser failures');

    const browserHash=createHmac('sha256',lookupEnv.APP_LOGIN_LOOKUP_SECRET).update('snnc:login-browser:v1:'+browser).digest('hex');
    const peerHash=createHmac('sha256',lookupEnv.APP_LOGIN_LOOKUP_SECRET).update('snnc:login-peer:v1:192.0.2.10').digest('hex');
    const lockoutBucket='browser-lockout:'+browserHash;
    const failureBucket='browser-failure:'+browserHash;
    const lastFailureBucket='browser-failure-last:'+browserHash;
    const previousFailureBucket='browser-failure-previous:'+browserHash;
    const peerBucket='peer-failure:'+peerHash;
    const readLockout=async ()=>(await db.query(
      'select attempts,window_start::text from private.app_login_limits where bucket=$1',[lockoutBucket])).rows;
    const elapse=async minutes=>db.query(
      "update private.app_login_limits set window_start=clock_timestamp()-$1*interval '1 minute' where bucket in ($2,$3)",
      [minutes,lockoutBucket,peerBucket]);
    const ageRecentFailures=async seconds=>db.query(
      "update private.app_login_limits set window_start=window_start-$1*interval '1 second' where bucket in ($2,$3)",
      [seconds,lastFailureBucket,previousFailureBucket]);
    const assertCooldown=(result,seconds)=>{
      assert.equal(result.status,429);
      assert.equal(result.headers.get('Retry-After'),String(seconds));
      assert.equal(result.data.retry_after,seconds);
      assert.ok(result.data.message.includes(String(seconds/60)+'분 후'));
    };
    const lockBrowser=async seconds=>{
      for (let n=0;n<2;n++) assert.equal((await auth('Again#'+n)).status,401);
      assertCooldown(await auth('StillWrong#'),seconds);
    };
    for (const [round,seconds] of [60,300,900,1800,1800].entries()) {
      await lockBrowser(seconds);
      assert.equal((await auth(loginCode)).status,429);
      const before=await readLockout();
      assert.equal(before.length,1);
      assert.equal(before[0].attempts,Math.min(round+1,4));
      if (round===0) {
        assert.equal((await auth(loginCode,other)).status,200,'browser cooldown does not block a coworker');
        assert.equal((await send({action:'login',code:loginCode,browser_id:browser},'192.0.2.11')).status,429,
          'the browser cooldown persists across network changes');
        assert.equal((await auth('WrongDuringCooldown#')).status,429);
        assert.deepEqual(await readLockout(),before,'requests during cooldown never extend or escalate it');
      }
      await elapse(seconds/60+1);
    }

    assert.equal((await auth(loginCode)).status,200,'correct code after the cooldown clears escalation history');
    assert.deepEqual(await readLockout(),[]);
    await lockBrowser(60);
    await elapse(25*60);
    await lockBrowser(60); // A day without another lockout resets the level.
    await elapse(2);
    assert.equal((await auth(loginCode)).status,200);

    assert.equal((await auth('Rolling#0')).status,401);
    await ageRecentFailures(70);
    assert.equal((await auth('Rolling#1')).status,401);
    await ageRecentFailures(10);
    assert.equal((await auth('Rolling#2')).status,401,'the first failure is outside the past minute');
    await ageRecentFailures(5);
    assertCooldown(await auth('Rolling#3'),60);
    await elapse(2);
    assert.equal((await auth(loginCode)).status,200);

    const spacedFailures=async prefix=>{
      for (let n=0;n<4;n++) {
        assert.equal((await auth(prefix+n)).status,401);
        await ageRecentFailures(35);
      }
    };
    await spacedFailures('Spaced#');
    assertCooldown(await auth('Spaced#4'),60);
    await elapse(2);
    assert.equal((await auth(loginCode)).status,200);

    await spacedFailures('Expired#');
    await ageRecentFailures(11*60);
    await db.query("update private.app_login_limits set window_start=clock_timestamp()-interval '11 minutes' where bucket=$1",[failureBucket]);
    assert.equal((await auth('AfterFailureWindow#')).status,401,'the failure window has elapsed');
    assert.equal((await auth(loginCode)).status,200);

    const legacy=await auth(legacyCode,other);
    assert.equal(legacy.status,200);
    assert.equal(legacy.data.code_upgrade_kind,'short');
    const badUpgrade=await send({action:'upgrade_short_code',current_code:'5039',new_code:'Synthetic-New#42',repeat_code:'Synthetic-New#42',browser_id:other});
    assert.equal(badUpgrade.status,401);
    const wrongAdmin=await send({action:'upgrade_team_admin_pin',current_code:'wrong-old',new_code:'58024739',repeat_code:'58024739',browser_id:other});
    assert.equal(wrongAdmin.status,401);
    assert.equal((await auth(loginCode,other)).status,200);

    await db.query("insert into private.app_login_limits values($1,clock_timestamp(),39) on conflict(bucket) do update set attempts=39,window_start=clock_timestamp()",[peerBucket]);
    assert.equal((await send({action:'login',code:'AnotherWrong#'})).status,429);
    assert.equal((await auth(loginCode,other)).status,429,'peer safeguard also covers older cached browsers');
    assert.equal((await send({action:'login',code:loginCode},'192.0.2.11')).status,200);

    const grantSql="select has_function_privilege($1,'public.app_session_code_attempt(text,text,text,text,text,text,text,text)','EXECUTE') as can_execute";
    for (const role of ['anon','authenticated']) assert.equal((await db.query(grantSql,[role])).rows[0].can_execute,false);
    assert.equal((await db.query(grantSql,['service_role'])).rows[0].can_execute,true);

    const html=read('index.html');
    const browserSource=html.slice(html.indexOf('  const LOGIN_BROWSER_KEY'),html.indexOf('  async function loginWithCode'));
    const stored=new Map();
    const localStorage={getItem:name=>stored.get(name),setItem:(name,value)=>stored.set(name,value)};
    const readBrowser = storage => vm.runInNewContext(browserSource+'\ngetLoginBrowserId()', {localStorage:storage,crypto:webcrypto});
    const identity=readBrowser(localStorage);
    assert.match(identity,/^[0-9a-f]{32}$/);
    assert.equal(readBrowser(localStorage),identity);
    assert.equal((html.match(/browser_id:getLoginBrowserId\(\)/g)||[]).length,3);
    console.log('PASS: dedicated lookup rotation, existing PIN, rolling one-minute and ten-minute thresholds, all four cooldowns, cap, expiry, success reset, coworker isolation, old-client peer guard, upgrade routes, and service-only grants');
  } finally {
    await db.close();
  }
}

main().catch(error=>{console.error(error.message,error.where||'');process.exitCode=1;});
