const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const edge=fs.readFileSync(path.join(__dirname,'../supabase/functions/app-session/index.ts'),'utf8');
const passkey=fs.readFileSync(path.join(__dirname,'../supabase/functions/app-passkey/index.ts'),'utf8');
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261111172900_team_admin_eight_digit_pin.sql'),'utf8');

const begin=html.indexOf('  function validTeamAdminPin(code) {');
const end=html.indexOf('  function showShortCodeUpgrade(',begin);
assert.ok(begin>=0&&end>begin,'browser PIN validator present');
const context=vm.createContext({});
vm.runInContext(html.slice(begin,end)+'\nglobalThis.check=validTeamAdminPin;',context);
const check=context.check;

test('only eight decimal digits without three identical or sequential digits',()=>{
  for(const code of ['58024739','83619504','10293847'])assert.equal(check(code),true,code);
  for(const code of ['12345678','98765432','90123456','21765439','11175342','58000247',
   '123','123456','1234567','123456789','5802473a','5802 739','5839-047','00000000'])
   assert.equal(check(code),false,code);
});

test('all PIN entry paths are gated, including passkeys and existing sessions',()=>{
  assert.match(migration,/WHERE role='team_admin' AND is_active/);
  for(const fn of ['app_session_login','app_session_login_fast','app_session_verify','app_passkey_access'])
    assert.match(migration,new RegExp('Enforce upgrade for '+fn.replace(/_/g,'_')));
  assert.match(migration,/admin_upgrade_required/);
  assert.match(migration,/u\.role='team_admin' AND NOT private\.app_valid_team_admin_pin\(next_code\)/);
  assert.match(migration,/REVOKE ALL ON FUNCTION public\.app_session_upgrade_team_admin_pin/);
  assert.match(migration,/credential_version=u\.credential_version/);
});

test('web and edge use a separate forced-upgrade action',()=>{
  assert.match(html,/showShortCodeUpgrade\(code,sessionData\.code_upgrade_kind\)/);
  assert.match(html,/upgrade_team_admin_pin/);
  assert.match(html,/autoNumericLoginTimer=setTimeout/);
  assert.match(edge,/validTeamAdminPin\(body\.new_code\)/);
  assert.match(edge,/app_session_upgrade_team_admin_pin/);
  assert.match(edge,/code_upgrade_kind:"team_admin"/);
  assert.match(passkey,/admin_upgrade_required/);
});
