"""Explicit local-only synthetic verification of the production Adapter.

Run manually with Docker available. Creates only UUID-named fixture resources;
never reads production credentials or touches existing application containers.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import uuid
import time
from urllib.parse import urlencode
from unittest.mock import patch

from database_upgrade import Adapter
from common import ReleaseError
from server import Deployer, Docker, command


def verify(postgres_image, source_image, target_image, directory):
    directory = Path(directory).resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    source = 'greenpms-adapter-source-' + token
    port = '56543'
    other = 'greenpms-adapter-other-' + token
    other_port = '56544'
    active_queries=[]
    def run(args):
        result=subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode:
            (directory/'fixture-setup-failure.log').write_text(result.stderr)
            raise RuntimeError('synthetic fixture command failed; inspect fixture-setup-failure.log')
        return result.stdout
    def sql(text, *, container=None, database='postgres'):
        return subprocess.run(['docker','exec','-i',container or source,'psql','-U','postgres','-d',database,'-At','-v','ON_ERROR_STOP=1'],input=text,
                              check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout
    adapter = None
    try:
        run(['docker','run','--detach','--name',source,'--label','org.greenpms.adapter-fixture='+token,
             '--publish','127.0.0.1:'+port+':5432','--env','POSTGRES_HOST_AUTH_METHOD=trust',postgres_image])
        run(['docker','exec',source,'sh','-c','i=0; until pg_isready -h 127.0.0.1 -U postgres >/dev/null; do i=$((i+1)); [ $i -lt 30 ] || exit 1; sleep 1; done'])
        sql("CREATE DATABASE adapter_synthetic OWNER postgres TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'; ALTER DATABASE adapter_synthetic SET timezone TO 'Asia/Shanghai';")
        app=directory/'app.env'; owner=directory/'owner.env'
        owner_url='postgres://postgres@127.0.0.1:'+port+'/adapter_synthetic?'+urlencode({'options':'-c TimeZone=UTC -c search_path=public,pg_catalog -c statement_timeout=500000'})
        runtime_url='postgres://qintopia_runtime@127.0.0.1:'+port+'/adapter_synthetic?'+urlencode({'options':'-c TimeZone=Asia/Shanghai -c search_path=public'})
        app_text='DATABASE_URL='+runtime_url+'\nSTAFF_PROFILE_MANIFEST_NAME=demo\n'
        app.write_text(app_text)
        owner_text='MIGRATION_DATABASE_URL='+owner_url+'\n'
        owner.write_text('MIGRATION_DATABASE_URL='+owner_url.split('?')[0]+'\n')
        app.chmod(0o600);owner.chmod(0o600)
        run(['docker','run','--rm','--network','host','--env-file',str(app),'--env-file',str(owner),
             '--env','STAFF_PROFILE_MANIFEST_NAME=unconfigured','--entrypoint','node',source_image,'/app/packages/db/src/migrate.js'])
        owner.write_text(owner_text)
        sql(r"""ALTER ROLE qintopia_runtime LOGIN;
ALTER ROLE postgres SET timezone TO 'Europe/London';
\connect adapter_synthetic
INSERT INTO properties(id,code,name,timezone,currency) VALUES('prop_qintopia_demo','ADAPTER-ISO','synthetic adapter test','Asia/Shanghai','CNY');
INSERT INTO subjects(id,username,display_name,password_salt,password_hash,status) VALUES
 ('subject_demo_operator','adapter-operator','synthetic operator','synthetic','not-login','ACTIVE'),
 ('subject_demo_agent','adapter-agent','synthetic agent','synthetic','not-login','ACTIVE'),
 ('subject_demo_administrator','adapter-admin','synthetic admin','synthetic','not-login','ACTIVE');
INSERT INTO subject_property_grants(subject_id,property_id,access_level) SELECT id,'prop_qintopia_demo','WRITE' FROM subjects;
""")
        run(['docker','run','--rm','--network','host','--env-file',str(app),'--env-file',str(owner),
             '--entrypoint','node',source_image,'/app/packages/db/src/migrate.js'])
        baseline_script="import{readFileSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';console.log(JSON.stringify(readdirSync('/app/packages/db/src/migrations').filter(n=>/^\\d+.*\\.sql$/.test(n)).sort().map(name=>({name,sha256:createHash('sha256').update(readFileSync('/app/packages/db/src/migrations/'+name)).digest('hex')}))));"
        def baseline(image):
            return json.loads(run(['docker','run','--rm','--network','none','--entrypoint','node',image,'--input-type=module','-e',baseline_script]))
        old={'runtimeImageId':source_image,'manifest':{'imageId':source_image,'requiredMigrations':baseline(source_image)}}
        target={'runtimeImageId':target_image,'manifest':{'imageId':target_image,'requiredMigrations':baseline(target_image)}}
        state=directory/'state';state.mkdir(exist_ok=True)
        cfg={'stateDir':str(state),'envFile':str(app)}
        deployer=Deployer(cfg,Docker(cfg),None,None)
        settings={'timeoutSeconds':900,'ownerEnvFile':str(owner),'postgresImage':postgres_image,'postgresMajor':18}
        adapter=Adapter(deployer,settings,directory,token)
        run(['docker','run','--detach','--name',other,'--label','org.greenpms.adapter-fixture='+token,
             '--publish','127.0.0.1:'+other_port+':5432','--env','POSTGRES_HOST_AUTH_METHOD=trust',postgres_image])
        run(['docker','exec',other,'sh','-c','i=0; until pg_isready -h 127.0.0.1 -U postgres >/dev/null; do i=$((i+1)); [ $i -lt 30 ] || exit 1; sleep 1; done'])
        sql('CREATE DATABASE adapter_other;')
        sql("CREATE TABLE sentinel(value text); INSERT INTO sentinel VALUES ('unchanged');",database='adapter_other')
        sql('CREATE DATABASE adapter_synthetic;',container=other)
        sql("CREATE TABLE sentinel(value text); INSERT INTO sentinel VALUES ('other-instance');",container=other,database='adapter_synthetic')
        def fingerprints():
            return [sql("SELECT json_build_object('ledger',(SELECT json_agg(name ORDER BY name) FROM schema_migrations),'subjects',(SELECT json_agg(id ORDER BY id) FROM subjects),'properties',(SELECT json_agg(id ORDER BY id) FROM properties))::text",database='adapter_synthetic'),
                    sql('SELECT value FROM sentinel',database='adapter_other'),
                    sql('SELECT value FROM sentinel',container=other,database='adapter_synthetic')]
        before_negative=fingerprints()
        negatives=[]
        cases=[('wrong-database',runtime_url.replace('/adapter_synthetic?','/adapter_other?'),'DATABASE_IDENTITIES_MISMATCH'),
               ('same-user-encoded',runtime_url.replace('qintopia_runtime@','%70ostgres@'),'DATABASE_IDENTITIES_MISMATCH'),
               ('different-instance',runtime_url.replace(':'+port+'/',':'+other_port+'/'),'DATABASE_IDENTITIES_MISMATCH'),
               ('tls-file',runtime_url+'&sslrootcert=%2Fnot-mounted.pem','DATABASE_TLS_FILES_UNSUPPORTED'),
               ('unsupported-session-option',runtime_url.split('?')[0]+'?'+urlencode({'options':'-c role=postgres'}),'DATABASE_SESSION_OPTIONS_UNSUPPORTED')]
        for name,bad_runtime,expected in cases:
            app.write_text('DATABASE_URL='+bad_runtime+'\nSTAFF_PROFILE_MANIFEST_NAME=demo\n')
            try:
                adapter.inspect({'current':old},target)
                raise AssertionError('negative connection was accepted')
            except ReleaseError:
                failure=json.loads((directory/'helper-failure.json').read_text())
                assert failure['code']==expected,(name,failure)
            assert fingerprints()==before_negative
            negatives.append({'case':name,'code':expected,'unchanged':True})
        app.write_text(app_text)
        (directory/'negative-verification.json').write_text(json.dumps(negatives,indent=2)+'\n')
        real_run = subprocess.run
        def record_run(*args, **kwargs):
            result = real_run(*args, **kwargs)
            if result.returncode and result.stderr:
                with (directory/'synthetic-command-diagnostics.log').open('ab') as stream:
                    stream.write(result.stderr.encode() if isinstance(result.stderr,str) else result.stderr)
            return result
        diagnostic="import{createDatabase,databaseReady}from'./packages/db/src/database.js';const db=createDatabase();const traced=db.withPlugin({transformQuery:a=>a.node,transformResult:async a=>{console.log(JSON.stringify(a.result.rows));return a.result}});try{console.log(JSON.stringify({ready:await databaseReady(traced)}));}finally{await db.destroy()}"
        (directory/'source-readiness.jsonl').write_text(run(['docker','run','--rm','--network','host','--env-file',str(app),'--entrypoint','node',source_image,'--input-type=module','-e',diagnostic]))
        adapter.ready(old)
        with patch('server.subprocess.run', side_effect=record_run):
            adapter.backup_rehearse({'current':old},target,'preparation')
        adapter.backup_rehearse({'current':old},target,'final')
        metadata=json.loads((directory/'metadata.json').read_text())
        assert metadata['sessions']['owner']['timezone']=='UTC'
        assert metadata['sessions']['runtime']['timezone']=='Asia/Shanghai'
        assert metadata['sessions']['owner']['search_path']=='public,pg_catalog'
        assert metadata['sessions']['runtime']['search_path']=='public'
        cluster=(directory/'cluster.sql').read_text()
        assert '''ALTER DATABASE "adapter_synthetic" SET "TimeZone" TO 'Asia/Shanghai';''' in cluster
        assert '''ALTER DATABASE "adapter_synthetic" SET timezone TO 'UTC';''' not in cluster
        sql("""CREATE FUNCTION adapter_fail_create_table() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
          IF tg_tag='CREATE TABLE' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='PRIVATE_SYNTHETIC_SENTINEL'; END IF;
          END$$; CREATE EVENT TRIGGER adapter_fail_ddl ON ddl_command_start EXECUTE FUNCTION adapter_fail_create_table();""",database='adapter_synthetic')
        try:
            adapter.migrate(target)
            raise AssertionError('injected formal migration failure was accepted')
        except ReleaseError:
            failure=json.loads((directory/'production-migration.json').read_text())
            assert failure['outcome']=='unknown' and failure['sqlstate']=='P0001'
            assert failure['firstPendingMigration']==target['manifest']['requiredMigrations'][-1]['name']
            assert failure['process']['status']=='nonzero'
            assert 'PRIVATE_SYNTHETIC_SENTINEL' not in json.dumps(failure)
            (directory/'expected-migration-failure.json').write_text(json.dumps(failure,indent=2)+'\n')
        finally:
            sql('DROP EVENT TRIGGER adapter_fail_ddl; DROP FUNCTION adapter_fail_create_table();',database='adapter_synthetic')
        adapter.migrate(target)
        adapter.ready(target)
        receipt=json.loads((directory/'production-migration.json').read_text())
        assert receipt['outcome']=='complete' and receipt['firstPendingMigration'] is None
        activity=[]
        def spawn_query(application):
            process=subprocess.Popen(['docker','exec','--env','PGAPPNAME='+application,source,'psql','-U','postgres','-d','adapter_synthetic','-c','SELECT pg_sleep(90)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            active_queries.append(process)
            for _ in range(50):
                pid=sql("SELECT pid FROM pg_stat_activity WHERE application_name='"+application+"' AND state='active'",database='adapter_synthetic').strip()
                if pid:return int(pid),process
                time.sleep(0.1)
            raise AssertionError('long query did not start')
        def live(pid):
            return sql('SELECT count(*) FROM pg_stat_activity WHERE pid='+str(pid),database='adapter_synthetic').strip()=='1'
        unrelated_pid,unrelated=spawn_query('greenpms-unrelated-'+token)
        for failure in (False,True):
            target_pid,process=spawn_query(adapter.job)
            removal=adapter.remove_owned
            def remove(name):
                if failure and name==adapter.job:raise ReleaseError('synthetic Docker removal failure')
                return removal(name)
            try:
                with patch.object(adapter,'remove_owned',side_effect=remove):adapter.cancel(target)
                assert not failure
            except ReleaseError as error:
                assert failure and 'CANCELLATION_UNCONFIRMED' in str(error)
            assert not live(target_pid) and live(unrelated_pid)
            process.communicate(timeout=5)
            activity.append({'jobRemovalFailed':failure,'targetPidGone':True,'unrelatedPidAlive':True})
        sql('SELECT pg_terminate_backend('+str(unrelated_pid)+')',database='adapter_synthetic')
        unrelated.communicate(timeout=5)
        (directory/'active-cancellation.json').write_text(json.dumps(activity,indent=2)+'\n')
        result={'synthetic':True,'preparationRestored':True,'finalRestored':True,'formalMigration':True,'targetReady':True,
                'activeBackendCancellation':True,'independentCancellationAfterRemovalFailure':True,'identityNegatives':len(negatives),'differentSessionTimezones':True,'safeMigrationFailureReceipt':True,'sourceMigrationCount':len(old['manifest']['requiredMigrations']),'targetMigrationCount':len(target['manifest']['requiredMigrations'])}
        (directory/'result.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result))
    finally:
        if adapter:
            adapter.remove_owned(adapter.job);adapter.remove_owned(adapter.clone);adapter.remove_owned(adapter.cancel_job)
        for name in (source,other):
            subprocess.run(['docker','rm','--force','--volumes',name],stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False)
        for process in active_queries:
            try:process.communicate(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.communicate(timeout=5)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('postgres-image','source-image','target-image','directory'):p.add_argument('--'+name,required=True)
    a=p.parse_args()
    verify(a.postgres_image,a.source_image,a.target_image,a.directory)
