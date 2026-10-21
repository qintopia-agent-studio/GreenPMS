"""A compiled migration entry must ship without adding seeds or reset tools."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[3]

class RuntimeTests(unittest.TestCase):
    def test_formal_migration_compiles_with_js_imports_and_operational_tools_stay_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'source'; out=Path(tmp)/'runtime'
            for path in ('apps/api/src','packages/contracts/src','packages/domain/src','packages/db/src/migrations','packages/db/catalog','apps/web/dist'):
                (root/path).mkdir(parents=True,exist_ok=True)
            for path in ('package.json','apps/api/package.json','apps/web/package.json','packages/contracts/package.json','packages/domain/package.json','packages/db/package.json'):
                (root/path).write_text(json.dumps({'name':'fixture','version':'1.0.0','type':'module','scripts':{'migrate':'tsx src/migrate.ts'},'exports':'./src/database.ts'}))
            (root/'package-lock.json').write_text('{}')
            # Use the actual formal migration source, including all real import paths.
            for name in ('migrate.ts','database.ts','staff-profile-manifest.ts','seed.ts','reset.ts','ready.ts'):
                (root/'packages/db/src'/name).write_bytes((ROOT/'packages/db/src'/name).read_bytes())
            # Release validation checks out the harness beside the immutable source checkout.
            # Resolve build dependencies from source when that split exists; CI checks use the
            # current checkout, where the dependency is available at the harness root.
            dependency_root = ROOT.parent/'source'
            if not (dependency_root/'node_modules/esbuild').is_dir():
                dependency_root = ROOT
            subprocess.run(['node',str(ROOT/'scripts/build-runtime.mjs'),'--source-root',str(root),'--dependency-root',str(dependency_root),'--output',str(out)],check=True,capture_output=True)
            entry=out/'packages/db/src/migrate.js'
            self.assertTrue(entry.is_file())
            self.assertIn('"./database.js"',entry.read_text())
            self.assertIn('"./staff-profile-manifest.js"',entry.read_text())
            subprocess.run(['node','--check',str(entry)],check=True,capture_output=True)
            for name in ('seed.js','reset.js','ready.js'):
                self.assertFalse((out/'packages/db/src'/name).exists())
            self.assertEqual(json.loads((out/'package.json').read_text())['scripts'],{'start':'node apps/api/src/main.js'})
