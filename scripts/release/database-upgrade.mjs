// Installed root-owned beside database_upgrade.py; never selected by an SSH argument.
import pg from 'pg';
import { readFileSync, writeFileSync, readdirSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { databaseUrl } from './packages/db/src/database.js';

const request = JSON.parse(readFileSync('/work/request.json', 'utf8'));
const action = process.argv[2];
const q = value => '"' + value.replaceAll('"', '""') + '"';
const lit = value => "'" + value.replaceAll("'", "''") + "'";
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const save = (name, value) => {
  const temporary = '/work/.' + name + '.' + randomUUID();
  let fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd=undefined;
    renameSync(temporary, '/work/' + name);
    const directory = openSync('/work', 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if(fd!==undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch(error) { if(error.code!=='ENOENT') throw error; }
  }
};
const env = (name, values) => {
  assert(Object.values(values).every(value => typeof value === 'string' && !/[\r\n\0]/.test(value)), 'DATABASE_ENV_UNSUPPORTED');
  save(name, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
};
function ownerUrl() {
  if (process.env.MIGRATION_DATABASE_URL) return new URL(process.env.MIGRATION_DATABASE_URL);
  const names = ['HOST', 'PORT', 'DATABASE', 'USER', 'PASSWORD'];
  assert(names.every(name => process.env['MIGRATION_PG' + name]), 'DATABASE_OWNER_ENV_INCOMPLETE');
  const url = new URL('postgres://127.0.0.1');
  url.hostname = process.env.MIGRATION_PGHOST;
  url.port = process.env.MIGRATION_PGPORT;
  url.pathname = '/' + process.env.MIGRATION_PGDATABASE;
  url.username = process.env.MIGRATION_PGUSER;
  url.password = process.env.MIGRATION_PGPASSWORD;
  return url;
}
const tlsFiles = new Set(['sslcert','sslkey','sslrootcert','sslcrl','sslcrldir']);
const connectionOptions = new Set(['sslmode','connect_timeout','options','application_name','channel_binding','gssencmode','target_session_attrs']);
function connectionUrl(input) {
  const url = new URL(input);
  assert(![...url.searchParams.keys()].some(key => tlsFiles.has(key.toLowerCase()))
    && !['PGSSLCERT','PGSSLKEY','PGSSLROOTCERT','PGSSLCRL','PGSSLCRLDIR'].some(key => process.env[key]), 'DATABASE_TLS_FILES_UNSUPPORTED');
  for (const key of url.searchParams.keys()) assert(connectionOptions.has(key),'DATABASE_CONNECTION_OPTION_UNSUPPORTED');
  const options = url.searchParams.get('options') ?? process.env.PGOPTIONS ?? '';
  // PostgreSQL startup options use backslash-escaped whitespace, not a shell.
  const tokens=[]; let token=''; let escaped=false;
  for (const char of options) {
    if (escaped) { token+=char; escaped=false; }
    else if (char === '\\') escaped=true;
    else if (/\s/.test(char)) { if(token) { tokens.push(token); token=''; } }
    else token+=char;
  }
  if(token) tokens.push(token);
  assert(!escaped && tokens.length % 2 === 0, 'DATABASE_SESSION_OPTIONS_UNSUPPORTED');
  for(let index=0;index<tokens.length;index+=2) {
    const setting=tokens[index+1].match(/^([^=]+)=(.+)$/s);
    assert(tokens[index]==='-c' && setting && ['timezone','search_path','lock_timeout','statement_timeout'].includes(setting[1].toLowerCase())
      && !/[\r\n\0]/.test(setting[2]), 'DATABASE_SESSION_OPTIONS_UNSUPPORTED');
  }
  if(options) url.searchParams.set('options',options);
  return url;
}
function assertIdentities(owner, runtime) {
  assert(runtime.hostname === owner.hostname && (runtime.port || '5432') === (owner.port || '5432')
    && decodeURIComponent(runtime.pathname) === decodeURIComponent(owner.pathname)
    && decodeURIComponent(runtime.username) !== decodeURIComponent(owner.username), 'DATABASE_IDENTITIES_MISMATCH');
}
const sessionQuery = `SELECT current_database() AS database, current_user AS role, inet_server_addr()::text AS address,
  inet_server_port() AS port, current_setting('TimeZone') AS timezone, current_setting('search_path') AS search_path`;
const optionValue = value => value.replace(/([\\\s])/g, '\\$1');
const forcedTimeouts = '-c lock_timeout=15000 -c statement_timeout=120000';
function migrationOptions(url) {
  return [url.searchParams.get('options') || '', forcedTimeouts].filter(Boolean).join(' ');
}
function cloneUrl(source, session, database, migration=false) {
  const url=new URL(`postgres://${encodeURIComponent(session.role)}@127.0.0.1:5432/${encodeURIComponent(database)}`);
  const options=[source.searchParams.get('options') || '', `-c TimeZone=${optionValue(session.timezone)}`, `-c search_path=${optionValue(session.search_path)}`];
  if(migration) options.push(forcedTimeouts);
  url.searchParams.set('options',options.filter(Boolean).join(' '));
  return url.toString();
}

const checkConstraints = `SELECT n.nspname AS schema, t.relname AS table, c.conname AS name,
  pg_get_constraintdef(c.oid, false) AS definition, c.convalidated AS validated,
  c.connoinherit AS noinherit, c.conislocal AS local, c.coninhcount AS inherited
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE c.contype='c' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3`;

async function inspect(client, url) {
  assert(process.env.RUNTIME_DATABASE_PASSWORD === undefined, 'DATABASE_PASSWORD_ROTATION_FORBIDDEN');
  const runtime = connectionUrl(databaseUrl());
  assertIdentities(url, runtime);
  const files = readdirSync('/app/packages/db/src/migrations').filter(name => /^\d+.*\.sql$/.test(name)).sort()
    .map(name => ({ name, sha256: createHash('sha256').update(readFileSync('/app/packages/db/src/migrations/' + name)).digest('hex') }));
  assert(JSON.stringify(files) === JSON.stringify(request.target), 'DATABASE_IMAGE_MIGRATIONS_MISMATCH');
  assert(request.target.length > request.before.length
    && JSON.stringify(request.target.slice(0, request.before.length)) === JSON.stringify(request.before), 'DATABASE_MIGRATIONS_NOT_APPEND_ONLY');
  await client.query('BEGIN READ ONLY');
  const ownerSession=(await client.query(sessionQuery)).rows[0];
  const runtimeClient=new pg.Client({connectionString:runtime.toString(),connectionTimeoutMillis:10000,statement_timeout:30000});
  let runtimeSession;
  try {
    await runtimeClient.connect(); await runtimeClient.query('BEGIN READ ONLY');
    runtimeSession=(await runtimeClient.query(sessionQuery)).rows[0];
    await runtimeClient.query('COMMIT');
  } finally { await runtimeClient.end(); }
  assert(ownerSession.database === runtimeSession.database && ownerSession.address === runtimeSession.address
    && ownerSession.port === runtimeSession.port && ownerSession.role !== runtimeSession.role,'DATABASE_IDENTITIES_MISMATCH');
  const database = (await client.query(`SELECT datname, pg_get_userbyid(datdba) AS owner, datcollate, datctype,
    pg_encoding_to_char(encoding) AS encoding, datlocprovider, dattablespace=(SELECT oid FROM pg_tablespace WHERE spcname='pg_default') AS default_tablespace,
    current_user=session_user AND current_user=pg_get_userbyid(datdba) AS direct_owner,
    current_setting('server_version_num')::int AS version, current_setting('TimeZone') AS timezone
    FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert(database?.direct_owner && Math.floor(database.version / 10000) === request.major, 'DATABASE_OWNER_OR_VERSION_MISMATCH');
  assert(database.datlocprovider === 'c' && database.default_tablespace, 'DATABASE_UNSUPPORTED_LOCALE_OR_TABLESPACE');
  const names = (await client.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => row.name);
  assert(JSON.stringify(names) === JSON.stringify(request.before.map(row => row.name)), 'DATABASE_BASELINE_MISMATCH');
  const validHistory = (await client.query(`WITH ordered AS (SELECT applied_at, lag(applied_at) OVER(ORDER BY name) AS previous FROM schema_migrations)
    SELECT COALESCE(bool_and(applied_at IS NOT NULL AND applied_at <= statement_timestamp()+interval '5 seconds'
      AND (previous IS NULL OR previous <= applied_at+interval '5 seconds')),true) AS valid FROM ordered`)).rows[0];
  assert(validHistory.valid, 'DATABASE_HISTORY_INVALID');
  const roles = (await client.query(`SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
    rolreplication, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname`)).rows;
  const bootstrap = 'greenpms_restore';
  assert(!roles.some(row => row.rolname === bootstrap) && database.datname !== 'postgres', 'DATABASE_REHEARSAL_IDENTITY_COLLISION');
  const memberships = (await client.query(`SELECT parent.rolname AS parent, child.rolname AS child,
    m.admin_option, m.inherit_option, m.set_option FROM pg_auth_members m
    JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member
    WHERE child.rolname !~ '^pg_' ORDER BY 1,2`)).rows;
  const settings = (await client.query(`SELECT COALESCE(r.rolname,'') AS role, COALESCE(d.datname,'') AS database, s.setconfig
    FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole LEFT JOIN pg_database d ON d.oid=s.setdatabase
    WHERE s.setdatabase=0 OR d.datname=current_database() ORDER BY 1,2`)).rows;
  const acl = (await client.query(`SELECT pg_get_userbyid(grantee) AS role, grantee=0 AS public,
    privilege_type, is_grantable FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba)))
    WHERE datname=current_database() ORDER BY grantee,privilege_type`)).rows;
  const constraints = (await client.query(checkConstraints)).rows;
  await client.query('COMMIT');
  const lines = roles.map(role => `CREATE ROLE ${q(role.rolname)} ${[
    [role.rolsuper,'SUPERUSER'],[role.rolinherit,'INHERIT'],[role.rolcreaterole,'CREATEROLE'],
    [role.rolcreatedb,'CREATEDB'],[role.rolcanlogin,'LOGIN'],[role.rolreplication,'REPLICATION'],[role.rolbypassrls,'BYPASSRLS']
  ].map(([enabled, option]) => (enabled ? '' : 'NO') + option).join(' ')} CONNECTION LIMIT ${role.rolconnlimit};`);
  lines.push(...memberships.map(row => `GRANT ${q(row.parent)} TO ${q(row.child)} WITH ADMIN ${row.admin_option}, INHERIT ${row.inherit_option}, SET ${row.set_option};`));
  lines.push(`CREATE DATABASE ${q(database.datname)} OWNER ${q(database.owner)} TEMPLATE template0 ENCODING ${lit(database.encoding)} LC_COLLATE ${lit(database.datcollate)} LC_CTYPE ${lit(database.datctype)} LOCALE_PROVIDER libc;`);
  for (const row of settings) for (const setting of row.setconfig) {
    const index = setting.indexOf('=');
    assert(index > 0 && (row.role || row.database), 'DATABASE_SETTING_UNSUPPORTED');
    const scope = row.role ? `ROLE ${q(row.role)}${row.database ? ' IN DATABASE ' + q(row.database) : ''}` : `DATABASE ${q(row.database)}`;
    lines.push(`ALTER ${scope} SET ${q(setting.slice(0,index))} TO ${lit(setting.slice(index+1))};`);
  }
  save('cluster.sql', lines.join('\n')+'\n');
  save('metadata.json', JSON.stringify({database: database.datname, owner: database.owner, bootstrap, constraints, acl, roles, sessions: { owner: ownerSession, runtime: runtimeSession }}));
  // PGDATABASE environment values are plain names, not expandable connstrings.
  // Preserve supported libpq options without ever putting credentials in argv.
  const pgEnv = { PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10' };
  const pgOptions = { sslmode:'PGSSLMODE', sslcert:'PGSSLCERT', sslkey:'PGSSLKEY', sslrootcert:'PGSSLROOTCERT',
    sslcrl:'PGSSLCRL', sslcrldir:'PGSSLCRLDIR', connect_timeout:'PGCONNECT_TIMEOUT', options:'PGOPTIONS',
    application_name:'PGAPPNAME', channel_binding:'PGCHANNELBINDING', gssencmode:'PGGSSENCMODE', target_session_attrs:'PGTARGETSESSIONATTRS' };
  for (const [key,value] of url.searchParams) {
    assert(Object.hasOwn(pgOptions,key),'DATABASE_CONNECTION_OPTION_UNSUPPORTED');
    pgEnv[pgOptions[key]]=value;
  }
  env('pg.env', pgEnv);
  const operational = { STAFF_PROFILE_MANIFEST_NAME: process.env.STAFF_PROFILE_MANIFEST_NAME || 'unconfigured' };
  for (const [key,value] of Object.entries(process.env)) if (/^PMS_/.test(key) && /^(true|false|0|1)$/i.test(value)) operational[key]=value;
  const migration = new URL(url);
  migration.searchParams.set('application_name', request.applicationName);
  migration.searchParams.set('options', migrationOptions(url));
  env('migration.env', { ...operational, DATABASE_URL: runtime.toString(), MIGRATION_DATABASE_URL: migration.toString() });
  env('clone.env', { ...operational, DATABASE_URL: cloneUrl(runtime,runtimeSession,database.datname), MIGRATION_DATABASE_URL: cloneUrl(url,ownerSession,database.datname,true) });
}

async function normalize(client) {
  const metadata = JSON.parse(readFileSync('/work/metadata.json','utf8'));
  assert(Math.floor(Number((await client.query('SHOW server_version_num')).rows[0].server_version_num)/10000) === request.major, 'DATABASE_REHEARSAL_VERSION_MISMATCH');
  await client.query('BEGIN');
  await client.query(`REVOKE ALL ON DATABASE ${q(metadata.database)} FROM PUBLIC`);
  for (const role of metadata.roles) await client.query(`REVOKE ALL ON DATABASE ${q(metadata.database)} FROM ${q(role.rolname)}`);
  for (const item of metadata.acl) {
    assert(['CREATE','CONNECT','TEMPORARY'].includes(item.privilege_type), 'DATABASE_ACL_UNSUPPORTED');
    await client.query(`GRANT ${item.privilege_type} ON DATABASE ${q(metadata.database)} TO ${item.public ? 'PUBLIC' : q(item.role)}${item.is_grantable ? ' WITH GRANT OPTION' : ''}`);
  }
  const restored = (await client.query(checkConstraints)).rows;
  for (const source of metadata.constraints) {
    const found = restored.find(row => row.schema === source.schema && row.table === source.table && row.name === source.name);
    assert(found, 'DATABASE_RESTORED_CONSTRAINT_MISSING');
    if (JSON.stringify(found) !== JSON.stringify(source)) {
      assert(source.local && source.inherited === 0, 'DATABASE_INHERITED_CONSTRAINT_MISMATCH');
      const definition = restoreBetween(source.definition);
      await client.query(`ALTER TABLE ${q(source.schema)}.${q(source.table)} DROP CONSTRAINT ${q(source.name)}`);
      await client.query(`ALTER TABLE ${q(source.schema)}.${q(source.table)} ADD CONSTRAINT ${q(source.name)} ${definition}`);
    }
  }
  assert(JSON.stringify((await client.query(checkConstraints)).rows) === JSON.stringify(metadata.constraints), 'DATABASE_CONSTRAINT_RESTORE_MISMATCH');
  await client.query('COMMIT');
}

// Restore parser-preserved BETWEEN grouping from source metadata only. Any
// unsupported normalization is caught by exact catalog comparison afterwards.
// Reconstruct BETWEEN syntax only from a canonical paired range. Callers must
// re-read pg_get_constraintdef after clone-only DDL and require exact equality.
function restoreBetween(definition) {
  function quoteEnd(s, start) {
    const quote = s[start];
    const escape = quote === "'" && start > 0 && /[eE]/.test(s[start - 1]) && (start < 2 || !/[\w$]/.test(s[start - 2]));
    for (let i = start + 1; i < s.length; i++) {
      if (escape && s[i] === '\\') { i++; continue; }
      if (s[i] !== quote) continue;
      if (s[i + 1] === quote) { i++; continue; }
      return i;
    }
    throw new Error('Unterminated quoted SQL metadata');
  }
  function closing(s, start) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === "'" || s[i] === '"') { i = quoteEnd(s, i); continue; }
      if (s[i] === '(') depth++;
      if (s[i] === ')' && --depth === 0) return i;
    }
    throw new Error('Unbalanced SQL metadata');
  }
  function unwrap(s) {
    s = s.trim();
    while (s[0] === '(' && closing(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
    return s;
  }
  function binary(s, operator) {
    s = unwrap(s);
    let found = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "'" || s[i] === '"') { i = quoteEnd(s, i); continue; }
      if (s[i] === '(') { i = closing(s, i); continue; }
      if (s.slice(i, i + operator.length) !== operator) continue;
      if (/^[A-Z]+$/.test(operator) && ((i && /[\w$]/.test(s[i - 1])) || /[\w$]/.test(s[i + operator.length] || ''))) continue;
      if (found !== -1) return null;
      found = i;
      i += operator.length - 1;
    }
    return found < 0 ? null : [s.slice(0, found).trim(), s.slice(found + operator.length).trim()];
  }
  function range(group) {
    for (const [join, lowOp, highOp, kind] of [['AND', '>=', '<=', 'BETWEEN'], ['OR', '<', '>', 'NOT BETWEEN']]) {
      const parts = binary(group, join);
      if (!parts) continue;
      const lo = binary(parts[0], lowOp), hi = binary(parts[1], highOp);
      if (!lo || !hi || !lo[0] || !lo[1] || !hi[1] || unwrap(lo[0]) !== unwrap(hi[0])) continue;
      // Avoid consuming a prefix of <= / >= or another PostgreSQL operator.
      if (/[<>=!~]$/.test(lo[0]) || /^[<>=!~]/.test(lo[1]) || /[<>=!~]$/.test(hi[0]) || /^[<>=!~]/.test(hi[1])) continue;
      return `(${lo[0]} ${kind} ${lo[1]} AND ${hi[1]})`;
    }
    return group;
  }
  function rewrite(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "'" || s[i] === '"') {
        const end = quoteEnd(s, i); out += s.slice(i, end + 1); i = end;
      } else if (s[i] === '(') {
        const end = closing(s, i); out += range(`(${rewrite(s.slice(i + 1, end))})`); i = end;
      } else out += s[i];
    }
    return out;
  }
  return rewrite(definition);
}

async function migrationReceipt(url, outcome, error, previous = {}) {
  const names=request.target.map(row=>row.name);
  const connection=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:10000,statement_timeout:10000});
  let applied;
  try {
    await connection.connect(); await connection.query('BEGIN READ ONLY');
    applied=(await connection.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row=>row.name);
    await connection.query('COMMIT');
  } finally { await connection.end(); }
  const completedMigrations=names.filter(name=>applied.includes(name));
  const firstPendingMigration=names.find(name=>!applied.includes(name)) ?? null;
  const sqlstate=/^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : previous.sqlstate;
  const receipt={outcome,completedMigrations,firstPendingMigration,
    process:{status:outcome==='complete'?'exited':'unknown',exitCode:outcome==='complete'?0:1,timedOut:false}};
  if(sqlstate) receipt.sqlstate=sqlstate;
  save('migration-result.json',JSON.stringify(receipt));
  return receipt;
}
async function runMigration(url) {
  let error;
  const write=process.stdout.write;
  // The formal entry still executes unchanged. Only its stdout is suppressed;
  // diagnostics come from an allowlisted receipt and the actual migration ledger.
  process.stdout.write=function(_chunk, encoding, callback) {
    if(typeof encoding==='function') encoding();
    else if(typeof callback==='function') callback();
    return true;
  };
  try { await import('./packages/db/src/migrate.js'); } catch(caught) { error=caught; }
  finally { process.stdout.write=write; }
  const receipt=await migrationReceipt(url,error?'unknown':'complete',error);
  if(error || receipt.firstPendingMigration!==null) throw Object.assign(new Error('DATABASE_FORMAL_MIGRATION_FAILED'),{code:receipt.sqlstate});
}
async function verifySessions(url) {
  const metadata=JSON.parse(readFileSync('/work/metadata.json','utf8'));
  for(const [name,connectionString] of [['owner',url.toString()],['runtime',databaseUrl()]]) {
    const connection=new pg.Client({connectionString,connectionTimeoutMillis:10000,query_timeout:10000});
    try {
      await connection.connect(); await connection.query('BEGIN READ ONLY');
      const actual=(await connection.query(sessionQuery)).rows[0];
      assert(actual.timezone===metadata.sessions[name].timezone && actual.search_path===metadata.sessions[name].search_path,
        'DATABASE_REHEARSAL_SESSION_MISMATCH');
      if(name==='owner') {
        const limits=(await connection.query("SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout")).rows[0];
        assert(limits.lock_timeout==='15s' && limits.statement_timeout==='2min','DATABASE_MIGRATION_TIMEOUTS_NOT_ENFORCED');
      }
      await connection.query('COMMIT');
    } finally { await connection.end(); }
  }
  save('session-verification.json',JSON.stringify({owner:metadata.sessions.owner,runtime:metadata.sessions.runtime,verified:true}));
}

let client;
try {
  try { save('helper-failure.json',JSON.stringify({action,code:null,sqlstate:null})); } catch(error) { if(action!=='cancel') throw error; }
  const url = connectionUrl(ownerUrl());
  if(action === 'inspect') assertIdentities(url, connectionUrl(databaseUrl()));
  if (action === 'cancel') url.searchParams.set('application_name', 'greenpms-release-cancel');
  if (action === 'normalize') {
    const metadata = JSON.parse(readFileSync('/work/metadata.json','utf8'));
    url.username = metadata.bootstrap;
    url.password = '';
  }
  if(action==='migrate') {
    await runMigration(url);
  } else if(action==='migration-status') {
    let previous={};
    try { previous=JSON.parse(readFileSync('/work/migration-result.json','utf8')); } catch {}
    await migrationReceipt(url,'unknown',undefined,previous);
  } else if(action==='verify-sessions') {
    await verifySessions(url);
  } else {
  client = new pg.Client({connectionString: url.toString(), connectionTimeoutMillis: 10000, statement_timeout: 30000});
  await client.connect();
  if (action === 'inspect') await inspect(client,url);
  else if (action === 'normalize') await normalize(client);
  else if (action === 'cancel') {
    await client.query(`SELECT pg_terminate_backend(pid, 10000) FROM pg_stat_activity
      WHERE application_name=$1 AND usename=current_user AND pid<>pg_backend_pid()`,[request.applicationName]);
    const remaining=(await client.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND usename=current_user`,[request.applicationName])).rows[0];
    assert(remaining.count===0,'DATABASE_BACKEND_CANCELLATION_UNCONFIRMED');
  } else throw new Error('DATABASE_HELPER_ACTION_INVALID');
  }
} catch (error) {
  const code = /^DATABASE_[A-Z_]+$/.test(error.message || '') ? error.message : 'DATABASE_PG_OPERATION_FAILED';
  const sqlstate = /^[0-9A-Z]{5}$/.test(error.code || '') ? error.code : undefined;
  try { save('helper-failure.json', JSON.stringify({ action, code, sqlstate })); } catch {}
  // Raw PG errors can include SQL/business data or connection credentials.
  console.error('DATABASE_HELPER_FAILED: inspect restricted backup metadata and configuration');
  process.exitCode=1;
} finally { if(client) await client.end(); }
