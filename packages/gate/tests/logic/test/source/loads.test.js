/** Explicit source-loader declarations preserve conservative committed selection [V4,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';
import { selectAffectedTests } from '../../../../index.js';

/** Make a real committed ES-module graph without executing any candidate source. */
function graph(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-doc-selection-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1',
    GIT_AUTHOR_NAME:'Test Agent', GIT_AUTHOR_EMAIL:'agent@example.com',
    GIT_COMMITTER_NAME:'Test Agent', GIT_COMMITTER_EMAIL:'agent@example.com' };
  /** Run Git with the fixture's own identity and configuration. */
  const git = (...args) => runFixtureGit(args, { cwd:root, env });
  /** Write a fixture module or document, creating its parent directories. */
  const put = (path, body) => { mkdirSync(dirname(join(root,path)), { recursive:true }); writeFileSync(join(root,path),body); };
  /** Snapshot real Git objects so selection cannot read uncommitted working-tree bytes. */
  const commit = () => { git('add','-A'); git('commit','-qm','chore: selection fixture'); return git('rev-parse','HEAD').trim(); };
  git('init','-q','-b','main');
  put('package.json','{"type":"module"}\n');
  put('src/api.js','export const version = 1;\n');
  put('apps/cli/journeys/milestone/api.test.js',"import '../../../../src/api.js';\n");
  put('src/labels.js',"import {readFileSync} from 'node:fs'; export const types=['feat','fix','docs','test']; export const config=()=>readFileSync('config.json'); export const isDoc=path=>path.startsWith('docs/');\n");
  put('test/unrelated.test.js',"import '../src/labels.js'; import assert from 'node:assert/strict'; assert.ok(true);\n");
  put('docs/api.md','# API\n');
  put('docs/other.md','# Other\n');
  put('docs/api.test.js',"import {readFileSync} from 'node:fs'; readFileSync(new URL('./api.md',import.meta.url),'utf8');\n");
  return { root,git,put,commit };
}

test('source loader declarations resolve committed targets and reject unknown boundaries [V4,C7]', (t) => {
  const headers = [
    '/** @pullboard-module-loads src/api.js */',
    '/** @pullboard-module-loads src/missing.js */',
    '/** @pullboard-module-loads missing/*.js */',
    '/** @pullboard-module-loads src/{api,labels}.js */',
    '/** @pullboard-module-loads */',
    '/** @pullboard-module-loads ../outside.js */',
    "const fake = '/** @pullboard-module-loads src/api.js */';",
  ];
  for (const [index, header] of headers.entries()) {
    const box = graph(t);
    box.put('src/loader.js', header + "\nimport './api.js'; export const load = () => import(process.env.TARGET);\n");
    box.put('test/loader.test.js', "import '../src/loader.js';\n");
    const base = box.commit();
    box.put('src/api.js', 'export const version = 2;\n');
    const commit = box.commit();
    const selection = selectAffectedTests(box.root, { base, commit });
    if (index === 0) {
      assert.equal(selection.full, false, selection.reason);
      assert.deepEqual(selection.files, ['apps/cli/journeys/milestone/api.test.js', 'test/loader.test.js']);
    } else {
      // clause 1: reaching a file with unknown reads selects its importers and unknown roots, never the whole suite.
      assert.equal(selection.full, false, header);
      assert.ok(selection.files.includes('test/loader.test.js'), 'clause 2: the test reaching the unknown file is still selected');
      assert.match(selection.reason, /non-literal dynamic import in reached file src\/loader\.js/u);
    }
    box.put('apps/cli/src/io/run/tests.js', 'export const runner = true;\n');
    const runnerChange = box.commit();
    const global = selectAffectedTests(box.root, { base: commit, commit: runnerChange });
    assert.equal(global.full, true);
    assert.match(global.reason, /apps\/cli\/src\/io\/run\/tests\.js controls the gate or dependency selection/u);
  }
});
