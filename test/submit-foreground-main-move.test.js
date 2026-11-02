/** A foreground submit survives an unrelated main move during its check and refuses a real policy change [V4,H16,C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

/** Read the fixture item's durable status and submitted commit. */
function item(box) {
  // @pullboard-board-file journey: the real CLI owns every submission write.
  const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return db.prepare('SELECT item_status,item_commit FROM item WHERE item_id=?').get(box.id);
  } finally { db.close(); }
}

/**
 * Build a claimed candidate whose frozen check commits to main once while it runs, the way a landing
 * does during a builder's long foreground check (#2181, #2326).
 */
function fixture(t, mode) {
  const helpers = createE2eHelpers();
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Fixture Model';
  sandbox.env.TMPDIR = sandbox.dir;
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete sandbox.env[key];
  const box = helpers.project('true', sandbox);
  t.after(() => helpers.cleanup());
  for (const folder of ['bin', 'test', 'web']) mkdirSync(join(box.repo, folder), { recursive: true });
  const marker = join(box.dir, 'main-moved');
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/feature.js'), "export const feature='base';\n");
  writeFileSync(join(box.repo, 'test/feature.test.js'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {feature} from '../web/feature.js'; import {execFileSync} from 'node:child_process'; import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const root=${JSON.stringify(box.repo)}, marker=${JSON.stringify(marker)};
test('feature [G1]',()=>{ if(feature==='item' && !existsSync(marker)) {
  if (${JSON.stringify(mode)} === 'policy') { const f=root+'/pullboard.json'; const c=JSON.parse(readFileSync(f,'utf8')); c.verify={...c.verify,family:'require'}; writeFileSync(f,JSON.stringify(c)); }
  else writeFileSync(root+'/landed.txt','an unrelated landing\\n');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
  execFileSync('git',['-C',root,'add','-A'],{env}); execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','core.hooksPath=/dev/null','commit','-qm','chore: land during the check [G1]'],{env});
  writeFileSync(marker,'done'); } assert.equal(feature,'item'); });\n`);
  writeFileSync(join(box.repo, 'bin/run-tests.js'), "import {spawnSync} from 'node:child_process';const env={...process.env};delete env.NODE_TEST_CONTEXT;const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(2)],{encoding:'utf8',env});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1;\n");
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...helpers.CONFIG,
    gate: 'node bin/run-tests.js test/feature.test.js', affectedTests: 'node bin/run-tests.js', submit: { handoff: false } }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: foreground submit policy [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = box.run(box.repo, 'add', 'web', 'Foreground main move', '--specs', 'G1',
    '--criterion', 'The feature is item.', '--check', 'node bin/run-tests.js test/feature.test.js', '--wait', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  box.id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(box.id)).code, 0);
  const built = helpers.commitFile(box, box.web, 'web/feature.js', "export const feature='item';\n", 'feat(web): foreground candidate [G1]');
  assert.equal(built.status, 0, built.stderr);
  const ready = box.run(box.repo, 'bar', 'ready', 'on', '--json');
  assert.equal(ready.code, 0, ready.out + ready.err);
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  const result = runFixtureChild(process.execPath, [helpers.BIN, 'submit', String(box.id), '--no-next'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  return { box, main, marker, result, output: result.stdout + result.stderr };
}

test('foreground submit lands green when unrelated main moves during its check [V4,H16,C7]', t => {
  const { box, main, marker, result, output } = fixture(t, 'unrelated');
  assert.ok(existsSync(marker), output);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD'), main, 'main moved while the check ran');
  assert.doesNotMatch(output, /accepted main changed|NO_POLICY/u);
  assert.equal(result.status, 0, output);
  assert.equal(item(box).item_status, 'submitted', output);
});

test('foreground submit still refuses when pullboard.json policy changes during its check [V4,H16,C7]', t => {
  const { box, marker, result, output } = fixture(t, 'policy');
  assert.ok(existsSync(marker), output);
  assert.notEqual(result.status, 0, output);
  assert.match(output, /NO_POLICY/u);
  assert.match(output, /verify\.family/u);
  assert.notEqual(item(box).item_status, 'submitted', output);
});
