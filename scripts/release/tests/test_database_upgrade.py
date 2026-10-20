"""State-machine failures use real filesystem journals, injectable database IO."""
import json
import errno
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from test_server import DeployerFixture, digest, migration, server
from common import ReleaseError
import database_upgrade as upgrade


class UpgradeFixture(DeployerFixture):
    def __init__(self):
        super().__init__()
        self.calls, self.fail, self.ready_result = [], None, True
        self.running = {"app": True, "worker": True}
        self.restart = {"app": "unless-stopped", "worker": "unless-stopped"}
        original_current, original_switch = self.docker.current, self.docker.switch
        self.docker.current = lambda: {**original_current(), "id": "app", "running": self.running["app"]}
        self.docker.worker = lambda: {**original_current(), "id": "worker", "running": self.running["worker"]}
        def stop(name):
            self.calls.append("stop:" + name)
            assert self.deployer.journal.exists(), "stop must have a durable journal"
            self.running[name] = False
            self.restart[name] = "no"
            if self.fail == "stop:" + name:
                raise ReleaseError("stop failed after daemon mutation")
        self.docker.stop_container = stop
        def switch(target, *, maintenance=False):
            self.calls.append("switch:maintenance" if maintenance else "switch:normal")
            self.restart.update(app="no" if maintenance else "unless-stopped",worker="no" if maintenance else "unless-stopped")
            original_switch(target)
            self.running.update(app=True, worker=True)
        self.docker.switch = switch
        def restore_restart_policy(target):
            self.event("restore-restart")
            self.restart.update(app="unless-stopped",worker="unless-stopped")
        self.docker.restore_restart_policy = restore_restart_policy
        self.settings = {"backupDir": str(self.state_dir.parent / "backup"), "ownerEnvFile": str(self.state_dir.parent / "owner.env"),
                         "postgresImage": "sha256:" + "a" * 64, "postgresMajor": 18, "timeoutSeconds": 60}
        Path(self.settings["backupDir"]).mkdir()
        Path(self.settings["ownerEnvFile"]).write_text("MIGRATION_DATABASE_URL=postgres://owner@db/pms\n")
        self.config["databaseUpgrade"] = self.settings
        self.manifest, self.key = self.add_new_release(migrations=[migration(), migration("002_next.sql")], compatibility_mode="forward-only")
        self.sha = digest(self.store.objects[self.key + "manifest.json"])
        self.config_patch = patch("database_upgrade.config", return_value=self.settings)
        self.adapter_patch = patch("database_upgrade.make_adapter", side_effect=lambda *_: self)
        self.config_patch.start(); self.adapter_patch.start()
        self.job, self.clone, self.cancel_job = "job", "clone", "cancel-job"
    def close(self):
        self.adapter_patch.stop(); self.config_patch.stop(); super().close()
    def event(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise ReleaseError("simulated failure " + name)
    def inspect(self, before, target):
        self.event("inspect")
    def backup_rehearse(self, before, target, name):
        self.event("backup:preparation" if name == "preparation" else "backup:final")
    def migrate(self, target):
        self.assert_phase = json.loads(self.deployer.journal.read_text())["phase"]
        assert self.assert_phase == "sql-started"
        self.event("sql")
    def ready(self, target):
        self.event("ready")
        if not self.ready_result:
            raise ReleaseError("DATABASE_TARGET_NOT_READY")
    def cancel(self, target):
        self.event("cancel")
    def remove_owned(self, name):
        self.event("remove:" + name)
    def prepare(self):
        return self.deployer.deploy(self.new_version,self.new_revision,self.key,self.sha,prepare_database=True)
    def deploy(self):
        return self.deployer.deploy(self.new_version,self.new_revision,self.key,self.sha)


class UpgradeTests(unittest.TestCase):
    def test_no_new_migrations_uses_no_owner_or_backup(self):
        with DeployerFixture() as f, patch("database_upgrade.config", side_effect=AssertionError("owner accessed")):
            _, key=f.add_new_release()
            args=(f.new_version,f.new_revision,key,digest(f.store.objects[key+"manifest.json"]))
            self.assertEqual(f.deployer.deploy(*args,prepare_database=True)["status"],"database-not-required")
            self.assertEqual(f.deployer.deploy(*args)["status"],"healthy")
    def test_preparation_does_not_stop_or_write_and_final_backup_is_repeated(self):
        with UpgradeFixture() as f:
            self.assertEqual(f.prepare()["status"],"database-prepared")
            self.assertNotIn("sql",f.calls)
            self.assertTrue(all(f.running.values()))
            result=f.deploy()
            self.assertEqual(result["status"],"healthy")
            self.assertLess(f.calls.index("backup:preparation"),f.calls.index("stop:worker"))
            self.assertLess(f.calls.index("stop:app"),f.calls.index("backup:final"))
            self.assertLess(f.calls.index("backup:final"),f.calls.index("sql"))
            self.assertFalse(f.deployer.journal.exists())
    def test_preparation_failure_keeps_old_service_and_no_transaction(self):
        with UpgradeFixture() as f:
            f.fail="backup:preparation"
            with self.assertRaises(ReleaseError): f.prepare()
            self.assertTrue(all(f.running.values()))
            self.assertFalse(f.deployer.journal.exists())
            self.assertFalse((f.state_dir/"database-prepared.json").exists())
    def test_partial_stop_or_final_backup_failure_restores_old_without_sql(self):
        for event in ("stop:worker","stop:app","backup:final","inspect"):
            with self.subTest(event=event), UpgradeFixture() as f:
                f.prepare(); f.fail=event
                with self.assertRaisesRegex(ReleaseError,"PRE_MIGRATION_FAILED"): f.deploy()
                self.assertTrue(all(f.running.values()))
                self.assertNotIn("sql",f.calls)
                self.assertEqual(f.docker.current_image_id,f.old_image_id)
                self.assertFalse(f.deployer.journal.exists())
    def test_sql_failure_or_post_sql_readiness_failure_never_switches_old(self):
        for event in ("sql","ready"):
            with self.subTest(event=event), UpgradeFixture() as f:
                f.prepare();f.fail=event
                with self.assertRaisesRegex(ReleaseError,"OUTCOME_UNKNOWN"):f.deploy()
                self.assertFalse(any(f.running.values()))
                self.assertTrue(f.deployer.journal.exists())
                self.assertEqual(f.docker.switches,[])
                self.assertIn("cancel",f.calls)
    def test_timer_does_not_replay_sql_or_restart_after_unknown_commit(self):
        with UpgradeFixture() as f:
            f.prepare();f.fail="sql"
            with self.assertRaises(ReleaseError):f.deploy()
            f.fail=None
            with self.assertRaisesRegex(ReleaseError,"OUTCOME_UNKNOWN"):f.deployer.recover()
            self.assertEqual(f.calls.count("sql"),1)
            self.assertEqual(f.docker.switches,[])
            self.assertFalse(any(f.running.values()))
    def test_same_identity_retry_requires_target_ready_and_does_not_replay_sql(self):
        with UpgradeFixture() as f:
            f.prepare();f.fail="sql"
            with self.assertRaises(ReleaseError):f.deploy()
            f.fail=None;f.ready_result=False
            self.assertEqual(f.prepare()["status"],"database-resume-required")
            with self.assertRaisesRegex(ReleaseError,"TARGET_NOT_READY"):f.deploy()
            self.assertEqual(f.calls.count("sql"),1)
            f.ready_result=True
            self.assertEqual(f.deploy()["status"],"healthy")
            self.assertEqual(f.calls.count("sql"),1)
            self.assertEqual(f.docker.switches,[f.new_image_id])
    def test_different_identity_is_rejected_while_maintenance_is_open(self):
        with UpgradeFixture() as f:
            f.prepare();f.fail="sql"
            with self.assertRaises(ReleaseError):f.deploy()
            with self.assertRaisesRegex(ReleaseError,"RELEASE_CONFLICT"):
                f.deployer.deploy(f.new_version,f.new_revision,f.key,"b"*64)
    def test_target_health_failure_stops_new_containers_without_old_switch(self):
        with UpgradeFixture() as f:
            f.prepare();f.health.failures.add(f.new_image_id)
            with self.assertRaises(ReleaseError):f.deploy()
            self.assertEqual(f.docker.switches,[f.new_image_id])
            self.assertFalse(any(f.running.values()))
            self.assertTrue(f.deployer.journal.exists())
    def test_healthy_committed_target_survives_lost_ack_recovery(self):
        with UpgradeFixture() as f:
            f.prepare()
            original=f.deployer.audit
            def audit(event,**kwargs):
                if event=="healthy":raise OSError("lost audit")
                return original(event,**kwargs)
            with patch.object(f.deployer,"audit",side_effect=audit),self.assertRaises(ReleaseError):f.deploy()
            self.assertTrue(all(f.running.values()))
            self.assertTrue(f.deployer.journal.exists())
            f.calls=[]
            f.deployer.recover()
            self.assertTrue(all(f.running.values()))
            self.assertNotIn("stop:app",f.calls)
            self.assertFalse(f.deployer.journal.exists())
    def test_owner_configuration_change_blocks_before_stopping(self):
        with UpgradeFixture() as f:
            f.prepare()
            Path(f.settings["ownerEnvFile"]).write_text("MIGRATION_DATABASE_URL=postgres://changed@db/pms\n")
            with self.assertRaisesRegex(ReleaseError,"CONFIGURATION_CHANGED"):f.deploy()
            self.assertTrue(all(f.running.values()))
            self.assertNotIn("sql",f.calls)
    def test_timeout_cancels_named_daemon_job_not_just_client(self):
        with DeployerFixture() as f:
            a=upgrade.Adapter(f.deployer,{"timeoutSeconds":30},f.state_dir,"a"*32)
            with patch.object(a,"remove_owned") as remove, patch.object(a,"command",side_effect=["",ReleaseError("timeout")]):
                with self.assertRaises(ReleaseError):a.run("image",["node","migrate.js"])
            self.assertEqual(remove.call_count,2)
            self.assertEqual(remove.call_args.args,(a.job,))
    def test_restart_policy_is_disabled_before_service_stop(self):
        with patch("server.command") as command:
            server.Docker({}).stop_container("owned-id")
        self.assertEqual(command.call_args_list[0].args[0],["docker","update","--restart=no","owned-id"])
        self.assertEqual(command.call_args_list[1].args[0][:2],["docker","stop"])

    def test_signal_during_migration_preserves_unknown_commit_journal(self):
        with UpgradeFixture() as f:
            f.prepare()
            with patch.object(f,'migrate',side_effect=KeyboardInterrupt),self.assertRaises(ReleaseError):f.deploy()
            self.assertEqual(json.loads(f.deployer.journal.read_text())['phase'],'sql-started')
            self.assertFalse(any(f.running.values()))
            self.assertEqual(f.docker.switches,[])
            with self.assertRaisesRegex(ReleaseError,'OUTCOME_UNKNOWN'):f.deployer.recover()

    def test_recovery_cancels_preparation_resources_without_switching_service(self):
        with UpgradeFixture() as f:
            f.prepare()
            record=json.loads((f.state_dir/'database-prepared.json').read_text())
            server.atomic_json(f.state_dir/'database-preparing.json',{**record,'target':{'prefix':f.key,'manifestSha256':f.sha}})
            f.calls=[]
            f.deployer.recover()
            self.assertEqual(f.calls,['remove:job','remove:clone','remove:cancel-job'])
            self.assertFalse((f.state_dir/'database-preparing.json').exists())
            self.assertTrue(all(f.running.values()))

    def test_failed_preparation_cleanup_keeps_recoverable_record(self):
        with UpgradeFixture() as f:
            f.fail='remove:clone'
            with self.assertRaises(ReleaseError):f.prepare()
            self.assertTrue((f.state_dir/'database-preparing.json').exists())
            self.assertTrue(all(f.running.values()))

    def test_configuration_rejects_floating_images_and_download_backup_directory(self):
        with DeployerFixture() as f:
            owner=f.state_dir/'owner.env';owner.write_text('MIGRATION_DATABASE_URL=postgres://owner@db/pms\n')
            backup=f.state_dir/'tmp';backup.mkdir(exist_ok=True)
            settings={'backupDir':str(backup),'ownerEnvFile':str(owner),'postgresImage':'postgres:18','postgresMajor':18,'timeoutSeconds':60}
            f.config['databaseUpgrade']=settings
            with patch('server.root_owned'),self.assertRaisesRegex(ReleaseError,'MUST_BE_PINNED'):upgrade.config(f.deployer)
            settings['postgresImage']='sha256:'+'a'*64
            with patch('server.root_owned'),self.assertRaisesRegex(ReleaseError,'MUST_BE_INDEPENDENT'):upgrade.config(f.deployer)

    def test_cancellation_refuses_unowned_container(self):
        with DeployerFixture() as f:
            a=upgrade.Adapter(f.deployer,{'timeoutSeconds':30},f.state_dir,'a'*32)
            result=subprocess.CompletedProcess([],0,stdout=b'another-transaction\n',stderr=b'')
            with patch('database_upgrade.subprocess.run',return_value=result),patch.object(a,'command') as command:
                with self.assertRaisesRegex(ReleaseError,'OWNERSHIP_MISMATCH'):a.remove_owned(a.job)
            command.assert_not_called()

    def test_preparation_receipt_is_bound_to_identity_without_marker_write(self):
        import orchestrate
        expected={'application':'greenpms','status':'database-prepared','prefix':'key','manifestSha256':'a'*64}
        def session(operation,callback,**kwargs):
            self.assertEqual(operation,'prepare-database')
            ack,receipt=callback(expected)
            self.assertEqual(ack,'complete')
            return receipt
        with patch('orchestrate._session',side_effect=session):
            self.assertEqual(orchestrate.prepare_database('version','revision','key','a'*64),expected)
        with patch('orchestrate._session',side_effect=lambda operation,callback,**kw:callback({**expected,'manifestSha256':'b'*64})):
            with self.assertRaisesRegex(ReleaseError,'preparation receipt'):orchestrate.prepare_database('v','r','key','a'*64)

    def test_same_release_recovery_tolerates_missing_container_after_compose_failure(self):
        for missing in ('app','worker'):
            with self.subTest(missing=missing),UpgradeFixture() as f:
                f.prepare();f.fail='sql'
                with self.assertRaises(ReleaseError):f.deploy()
                f.fail=None
                lookup=f.docker.current if missing=='app' else f.docker.worker
                exists=[False]
                def optional_lookup():
                    if not exists[0]:
                        raise server.DeploymentDiagnosticError('APP_CONTAINER_MISSING' if missing=='app' else 'WORKER_CONTAINER_MISSING','missing')
                    return lookup()
                if missing=='app':f.docker.current=optional_lookup
                else:f.docker.worker=optional_lookup
                f.docker.containers=lambda:[]
                switch=f.docker.switch
                def restored(target, **kwargs):
                    exists[0]=True
                    switch(target, **kwargs)
                f.docker.switch=restored
                self.assertEqual(f.deploy()['status'],'healthy')
                self.assertEqual(f.calls.count('sql'),1)
                self.assertEqual(f.docker.switches,[f.new_image_id])

    def test_missing_lookup_cannot_hide_foreign_container(self):
        with UpgradeFixture() as f:
            f.prepare();f.fail='sql'
            with self.assertRaises(ReleaseError):f.deploy()
            f.fail=None
            def foreign():raise server.DeploymentDiagnosticError('APP_CONTAINER_MISSING','ambiguous')
            f.docker.current=foreign
            f.docker.containers=lambda:[{'name':'/qintopia-pms-app','id':'foreign'}]
            with self.assertRaisesRegex(ReleaseError,'STOP_INCOMPLETE'):f.deploy()
            self.assertNotIn('stop:foreign',f.calls)
            self.assertTrue(f.deployer.journal.exists())

    def test_recovery_cancels_sql_even_when_one_service_stop_fails(self):
        with UpgradeFixture() as f:
            f.prepare();f.fail='sql'
            with self.assertRaises(ReleaseError):f.deploy()
            f.fail='stop:worker';f.calls=[]
            with self.assertRaisesRegex(ReleaseError,'STOP_INCOMPLETE'):f.deployer.recover()
            self.assertIn('cancel',f.calls)
            self.assertTrue(f.deployer.journal.exists())

    def test_configuration_drift_does_not_skip_unknown_sql_cancellation(self):
        with UpgradeFixture() as f:
            f.prepare();f.fail='sql'
            with self.assertRaises(ReleaseError):f.deploy()
            f.fail=None;f.calls=[]
            Path(f.settings['ownerEnvFile']).write_text('MIGRATION_DATABASE_URL=postgres://changed@db/pms\n')
            with self.assertRaisesRegex(ReleaseError,'CONFIGURATION_CHANGED'):f.deployer.recover()
            self.assertIn('cancel',f.calls)
            self.assertFalse(any(f.running.values()))
            self.assertTrue(f.deployer.journal.exists())

    def test_backend_cancellation_is_attempted_even_when_docker_removal_fails(self):
        with DeployerFixture() as f:
            a=upgrade.Adapter(f.deployer,{'timeoutSeconds':30},f.state_dir,'a'*32)
            with patch.object(a,'remove_owned',side_effect=ReleaseError('daemon unavailable')) as remove,patch.object(a,'helper') as helper:
                with self.assertRaisesRegex(ReleaseError,'CANCELLATION_UNCONFIRMED'):a.cancel({})
            helper.assert_called_once_with({},'cancel')
            self.assertEqual(remove.call_count,3)

    def test_enospc_state_and_blocked_journal_writes_still_stop_and_cancel(self):
        with UpgradeFixture() as f:
            f.prepare()
            atomic=server.atomic_json
            def full_disk(path,value):
                if Path(path)==f.deployer.state_file or (Path(path)==f.deployer.journal and value.get('phase')=='blocked'):
                    raise OSError(errno.ENOSPC,'synthetic full disk')
                return atomic(path,value)
            with patch('server.atomic_json',side_effect=full_disk),self.assertRaises(ReleaseError):f.deploy()
            self.assertFalse(any(f.running.values()))
            self.assertIn('cancel',f.calls)
            self.assertEqual(json.loads(f.deployer.journal.read_text())['phase'],'opening')
            self.assertEqual(f.docker.switches,[f.new_image_id])
            self.assertEqual(set(f.restart.values()),{'no'})

    def test_enospc_after_possible_sql_keeps_prior_journal_and_cancels(self):
        with UpgradeFixture() as f:
            f.prepare()
            atomic=server.atomic_json
            def full_disk(path,value):
                if Path(path)==f.deployer.journal and value.get('phase') in ('sql-complete','blocked'):
                    raise OSError(errno.ENOSPC,'synthetic full disk')
                return atomic(path,value)
            with patch('server.atomic_json',side_effect=full_disk),self.assertRaises(ReleaseError):f.deploy()
            self.assertEqual(json.loads(f.deployer.journal.read_text())['phase'],'sql-started')
            self.assertFalse(any(f.running.values()))
            self.assertIn('cancel',f.calls)
            self.assertEqual(f.docker.switches,[])

    def test_cancel_stage_record_failure_does_not_skip_any_boundary(self):
        with DeployerFixture() as f:
            a=upgrade.Adapter(f.deployer,{'timeoutSeconds':30},f.state_dir,'a'*32)
            with patch.object(a,'stage_record',side_effect=OSError(errno.ENOSPC,'full')),patch.object(a,'remove_owned') as remove,patch.object(a,'helper') as helper:
                a.cancel({})
            self.assertEqual([call.args[0] for call in remove.call_args_list],[a.job,a.clone,a.cancel_job])
            helper.assert_called_once_with({},'cancel')

    def test_cancel_uses_independent_job_when_migration_job_removal_fails(self):
        with DeployerFixture() as f:
            a=upgrade.Adapter(f.deployer,{'timeoutSeconds':30},f.state_dir,'a'*32)
            def remove(name):
                if name==a.job:raise ReleaseError('migration removal failed')
            target={'runtimeImageId':'sha256:'+'a'*64}
            with patch.object(a,'remove_owned',side_effect=remove),patch.object(a,'command',return_value='') as command:
                with self.assertRaisesRegex(ReleaseError,'CANCELLATION_UNCONFIRMED'):a.cancel(target)
            creates=[call.args[0] for call in command.call_args_list if call.args[0][:2]==['docker','create']]
            self.assertEqual(len(creates),1)
            self.assertEqual(creates[0][creates[0].index('--name')+1],a.cancel_job)
            self.assertEqual(creates[0][-1],'cancel')
            self.assertIn(['docker','start','--attach',a.cancel_job],[call.args[0] for call in command.call_args_list])

    def test_opening_keeps_restart_disabled_and_interruption_does_not_restore_it(self):
        with UpgradeFixture() as f:
            f.prepare();f.health.interruptions.add(f.new_image_id)
            with self.assertRaises(ReleaseError):f.deploy()
            self.assertIn('switch:maintenance',f.calls)
            self.assertNotIn('restore-restart',f.calls)
            self.assertEqual(set(f.restart.values()),{'no'})
            self.assertFalse(any(f.running.values()))
            self.assertTrue(f.deployer.journal.exists())

    def test_committed_restart_restoration_failure_keeps_target_for_recovery(self):
        with UpgradeFixture() as f:
            f.prepare();f.fail='restore-restart'
            with self.assertRaisesRegex(ReleaseError,'COMMITTED_FINALIZATION_FAILED'):f.deploy()
            self.assertTrue(all(f.running.values()))
            self.assertEqual(set(f.restart.values()),{'no'})
            self.assertEqual(json.loads(f.deployer.journal.read_text())['phase'],'committed')
            f.calls=[]
            with self.assertRaises(ReleaseError):f.deployer.recover()
            self.assertTrue(all(f.running.values()))
            self.assertNotIn('stop:app',f.calls)
            f.fail=None;f.deployer.recover()
            self.assertEqual(set(f.restart.values()),{'unless-stopped'})
            self.assertFalse(f.deployer.journal.exists())

    def test_real_docker_switch_uses_durable_maintenance_override(self):
        with UpgradeFixture() as f:
            target={'manifest':f.manifest,'runtimeImageId':f.new_image_id}
            docker=server.Docker(f.config)
            with patch.object(docker,'inspect_image',side_effect=f.docker.inspect_image),patch('server.command') as command:
                docker.switch(target,maintenance=True)
            args=command.call_args.args[0]
            self.assertEqual(args.count('--file'),2)
            override=Path(args[args.index('--file',args.index('--file')+1)+1])
            self.assertEqual(json.loads(override.read_text()),{'services':{'app':{'restart':'no'},'wecom-worker':{'restart':'no'}}})

    def test_each_dump_keeps_immutable_hashed_metadata(self):
        with DeployerFixture() as f:
            a=upgrade.Adapter(f.deployer,{'timeoutSeconds':30},f.state_dir,'a'*32)
            files=('request.json','metadata.json','cluster.sql','pg.env','clone.env','migration.env')
            for name in files:(f.state_dir/name).write_text('first backup '+name)
            first=a.snapshot_metadata('first','a'*64)
            first_bytes=(f.state_dir/first['metadataDirectory']/'metadata.json').read_bytes()
            for name in files:(f.state_dir/name).write_text('final backup '+name)
            second=a.snapshot_metadata('final','b'*64)
            self.assertEqual((f.state_dir/first['metadataDirectory']/'metadata.json').read_bytes(),first_bytes)
            self.assertNotEqual(first['metadataSha256'],second['metadataSha256'])
            a.verify_metadata_snapshot(second,'b'*64)
            with self.assertRaisesRegex(ReleaseError,'METADATA_CHANGED'):a.verify_metadata_snapshot(first,'a'*64)

    def test_metadata_fsync_failure_prevents_sql_start(self):
        with UpgradeFixture() as f:
            f.prepare()
            def backup(*args):raise OSError(errno.ENOSPC,'metadata fsync failed')
            with patch.object(f,'backup_rehearse',side_effect=backup),self.assertRaisesRegex(ReleaseError,'PRE_MIGRATION_FAILED'):f.deploy()
            self.assertNotIn('sql',f.calls)
            self.assertTrue(all(f.running.values()))

    def test_preparation_directory_is_fsynced_before_journal(self):
        with UpgradeFixture() as f:
            events=[];atomic=server.atomic_json
            def record(path,value):
                if Path(path).name=='database-preparing.json':events.append('journal')
                return atomic(path,value)
            with patch('database_upgrade.fsync_directory',side_effect=lambda path:events.append(str(path))),patch('server.atomic_json',side_effect=record):f.prepare()
            self.assertEqual(events[2],'journal')
            self.assertEqual(Path(events[0]).parent,Path(f.settings['backupDir']))
            self.assertEqual(events[1],f.settings['backupDir'])

    def test_prepare_database_rejects_dry_run_before_ssh(self):
        import contextlib
        import io
        import orchestrate
        with patch('orchestrate.prepare_database') as prepare,contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit) as raised:
            orchestrate.main(['prepare-database','--version','v1.0.0','--revision','a'*40,'--key','key','--manifest-sha','b'*64,'--dry-run'])
        self.assertEqual(raised.exception.code,2)
        prepare.assert_not_called()

    def test_migration_timeout_receipt_stays_unknown_and_uses_observed_ledger(self):
        with DeployerFixture() as f:
            a=upgrade.Adapter(f.deployer,{'timeoutSeconds':30},f.state_dir,'a'*32)
            server.atomic_json(f.state_dir/'request.json',{'before':[migration()], 'target':[migration(),migration('002_next.sql')]})
            def helper(target,action,**kwargs):
                if action=='migrate':raise server.DeploymentDiagnosticError('DATABASE_TIMEOUT','safe',details={'timedOut':True})
                server.atomic_json(f.state_dir/'migration-result.json',{'outcome':'unknown','completedMigrations':['001_initial.sql'],'firstPendingMigration':'002_next.sql','sqlstate':'57014'})
            with patch.object(a,'helper',side_effect=helper),self.assertRaises(ReleaseError):a.migrate({})
            receipt=json.loads((f.state_dir/'production-migration.json').read_text())
            self.assertEqual(receipt['outcome'],'unknown')
            self.assertEqual(receipt['process']['status'],'timeout')
            self.assertTrue(receipt['process']['timedOut'])
            self.assertEqual(receipt['firstPendingMigration'],'002_next.sql')
            self.assertEqual(receipt['sqlstate'],'57014')

    def test_migration_nonzero_receipt_cannot_be_promoted_to_complete_by_full_ledger(self):
        with DeployerFixture() as f:
            a=upgrade.Adapter(f.deployer,{'timeoutSeconds':30},f.state_dir,'a'*32)
            server.atomic_json(f.state_dir/'request.json',{'before':[migration()], 'target':[migration(),migration('002_next.sql')]})
            def helper(target,action,**kwargs):
                server.atomic_json(f.state_dir/'migration-result.json',{'outcome':'unknown','completedMigrations':['001_initial.sql','002_next.sql'],'firstPendingMigration':None,'sqlstate':'23514'})
                if action=='migrate':raise server.DeploymentDiagnosticError('DATABASE_FAILED','safe',details={'exitCode':1,'timedOut':False})
            with patch.object(a,'helper',side_effect=helper),self.assertRaises(ReleaseError):a.migrate({})
            receipt=json.loads((f.state_dir/'production-migration.json').read_text())
            self.assertEqual(receipt['outcome'],'unknown')
            self.assertEqual(receipt['process']['status'],'nonzero')
            self.assertEqual(receipt['process']['exitCode'],1)
            self.assertIsNone(receipt['firstPendingMigration'])
            self.assertEqual(receipt['sqlstate'],'23514')

    def test_helper_save_fsyncs_file_before_rename_and_directory_after(self):
        helper=Path(upgrade.__file__).with_name('database-upgrade.mjs')
        script=r"""
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[1],'utf8');const save=source.slice(source.indexOf('const save ='),source.indexOf('\nconst env'));
for(const fail of [false,true]) {
 const events=[];let id=0;
 const context={randomUUID:()=> 'test',openSync:(path,flags,mode)=>{events.push(['open',flags,mode]);return ++id;},
 writeFileSync:()=>events.push(['write']),fsyncSync:fd=>{events.push(['fsync',fd]);if(fail&&fd===1)throw Object.assign(new Error('full'),{code:'ENOSPC'});},
 closeSync:fd=>events.push(['close',fd]),renameSync:()=>events.push(['rename']),unlinkSync:()=>events.push(['unlink'])};
 if(fail) {assert.throws(()=>vm.runInNewContext(save+"save('record','data')",context),/full/);assert.ok(!events.some(e=>e[0]==='rename'));}
 else {vm.runInNewContext(save+"save('record','data')",context);assert.deepEqual(events.map(e=>e[0]),['open','write','fsync','close','rename','open','fsync','close','unlink']);assert.equal(events[0][2],0o600);}
}
"""
        subprocess.run(['node','-e',script,str(helper)],check=True,capture_output=True)
