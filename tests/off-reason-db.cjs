// Usage: node tests/off-reason-db.cjs /absolute/path/to/pglite/dist/index.js
// In-memory PostgreSQL only; never connects to Supabase or another database.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
(async()=>{
 if(!process.argv[2])throw Error('Provide the installed PGlite entry point');
 const {PGlite}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
 const db=new PGlite();
 const root=path.join(__dirname,'..');
 const read=p=>fs.readFileSync(path.join(root,p),'utf8');
 try{
  const [setup,regression]=read('tests/admin-helper-db.sql').split('-- APPLY_MIGRATION_HERE');
  await db.exec(setup);
  await db.exec(read('supabase/migrations/20261102173503_admin_free_text_helper.sql'));
  await db.exec(read('supabase/migrations/20261102153232_owner_leave_tracking.sql'));
  const before=await db.query("select oid,proacl::text from pg_proc where oid='public.app_session_request_create(text,text,text,date,text,text)'::regprocedure");
  const migrations=fs.readdirSync(path.join(root,'supabase/migrations')).filter(p=>p.endsWith('_prevent_own_name_in_off_reason.sql'));
  assert.equal(migrations.length,1);
  await db.exec(read('supabase/migrations/'+migrations[0]));
  const after=await db.query("select oid,proacl::text from pg_proc where oid='public.app_session_request_create(text,text,text,date,text,text)'::regprocedure");
  assert.deepEqual(after.rows,before.rows,'function identity and privileges must be preserved');
  await db.exec(regression);
  await db.exec(read('tests/off-reason-db.sql'));
  console.log(JSON.stringify({passed:true,engine:(await db.query('select version()')).rows[0].version,scope:'IN_MEMORY_SYNTHETIC_POSTGRESQL; NO_LIVE_DATA_OR_NETWORK',adminHelperRegression:true,requestRpcIdentityAndPrivilegesPreserved:true,nameGuardAndOwnerLeaveVerified:true,legacyRecordsPreserved:true}));
 }finally{await db.close();}
})().catch(e=>{console.error(e.message,e.where||'');process.exitCode=1;});

