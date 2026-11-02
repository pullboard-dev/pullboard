/** A genuine main move between preflight and queueing never substitutes gate authority [V4,H16,E18]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

/** Observe only this private CLI fixture's durable job and item state. */
function state(box) {
  // @pullboard-board-file journey: the real CLI owns every queue, proof and submission write.
  const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`submit_handoff:${box.id}`);
    return { job: row ? JSON.parse(row.meta_value) : null,
      item: db.prepare('SELECT item_status,item_commit FROM item WHERE item_id=?').get(box.id) };
  } finally { db.close(); }
}

/** Build a real claimed candidate and advance main causally when native preflight reports composition. */
function fixture(t, rewind) {
  const helpers = createE2eHelpers();
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Fixture Model';
  // Keep detached tooling inside the canonical private fixture, including on macOS's /var alias.
  sandbox.env.TMPDIR = sandbox.dir;
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete sandbox.env[key];
  const box = helpers.project('true', sandbox);
  for (const folder of ['bin', 'test', 'web']) mkdirSync(join(box.repo, folder), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/feature.js'), "export const feature='base';\n");
  writeFileSync(join(box.repo, 'web/other.js'), "export const other='independent';\n");
  writeFileSync(join(box.repo, 'test/feature.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {feature} from '../web/feature.js';test('feature [G1]',()=>assert.equal(feature,'item'));\n");
  writeFileSync(join(box.repo, 'test/other.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {other} from '../web/other.js';test('other [G1]',()=>assert.equal(other,'independent'));\n");
  writeFileSync(join(box.repo, 'bin/run-tests.js'), "import {spawnSync} from 'node:child_process';const env={...process.env};delete env.NODE_TEST_CONTEXT;const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(2)],{encoding:'utf8',env});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1;\n");
  const config = join(box.repo, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')),
    gate: 'node bin/run-tests.js test/feature.test.js', affectedTests: 'node bin/run-tests.js', submit: { handoff: true } }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: enable private queued gate [G1]');
  const parent = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.repo, 'commit', '--allow-empty', '-qm', 'chore: captured accepted main [G1]');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = box.run(box.repo, 'add', 'web', 'Main move candidate', '--specs', 'G1',
    '--criterion', 'The feature is item.', '--check', 'node bin/run-tests.js test/feature.test.js', '--wait', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  box.id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(box.id)).code, 0);
  const built = helpers.commitFile(box, box.web, 'web/feature.js', "export const feature='item';\n", 'feat(web): private candidate [G1]');
  assert.equal(built.status, 0, built.stderr);
  const ready = box.run(box.repo, 'bar', 'ready', 'on', '--json');
  assert.equal(ready.code, 0, ready.out + ready.err);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const marker = join(box.dir, 'main-moved.json');
  const preload = join(box.dir, 'advance-main.mjs');
  writeFileSync(preload, `import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const marker=${JSON.stringify(marker)}, root=${JSON.stringify(box.repo)};
const write=process.stdout.write;
process.stdout.write=function(...args) {
  if (!existsSync(marker) && String(args[0]).includes('submit composition:')) {
    const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
    ${rewind ? `git('reset','--hard',${JSON.stringify(parent)});` : `mkdirSync(root+'/docs',{recursive:true}); writeFileSync(root+'/docs/advanced.md','accepted main advance\\n'); git('add','docs/advanced.md'); git('commit','-qm','docs: advance main during preflight [G1]');`}
    writeFileSync(marker,JSON.stringify({main:git('rev-parse','HEAD')}),{flag:'wx'});
  }
  return Reflect.apply(write,this,args);
};\n`);
  t.after(async () => {
    const job = state(box).job;
    if (job) await helpers.waitFor(() => {
      const directory = join(box.repo, '.git/pullboard/submit-handoffs', job.id);
      const request = join(directory, 'request.json');
      return existsSync(request) && !existsSync(JSON.parse(readFileSync(request, 'utf8')).tools)
        && !existsSync(join(directory, 'source'));
    }, 'owned queued worker and tooling cleanup', 120000); // budget: owned-child hang ceiling, no elapsed-time assertion.
    helpers.cleanup();
  });
  return { ...box, helpers, main, commit, marker, preload };
}

/** Run the public command with an output observer that moves real Git refs, without replacing a service. */
function submit(box) {
  return runFixtureChild(process.execPath, ['--import', pathToFileURL(box.preload).href, box.helpers.BIN,
    'submit', String(box.id), '--no-next'], { cwd: box.web, env: box.env, encoding: 'utf8' });
}

test('queued submit accepts a forward main move during native preflight [V4,H16,E18]', async t => {
  const box = fixture(t, false);
  const result = submit(box);
  assert.ok(existsSync(box.marker), result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /queued gate/u);
  const queued = state(box).job;
  assert.equal(queued.commit, box.commit, 'queue preserves the captured candidate');
  assert.equal(queued.main, box.main, 'queue preserves the accepted preflight policy');
  await box.helpers.waitFor(() => ['green', 'submitted', 'red', 'incomplete'].includes(state(box).job?.state),
    'the actual queued gate result', 120000); // budget: real-worker hang ceiling, no elapsed-time assertion.
  const completed = state(box);
  assert.equal(completed.job.state, 'green', JSON.stringify(completed.job));
  assert.equal(completed.item.item_status, 'submitted');
  const advanced = JSON.parse(readFileSync(box.marker, 'utf8')).main;
  box.git(box.repo, 'merge-base', '--is-ancestor', advanced, completed.item.item_commit);
  box.git(box.repo, 'merge-base', '--is-ancestor', box.commit, completed.item.item_commit);
});

test('queued submit still refuses a main rewind during native preflight [V4,H16,E18]', t => {
  const box = fixture(t, true);
  const result = submit(box);
  assert.ok(existsSync(box.marker), result.stdout + result.stderr);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /SUBMIT_HANDOFF_SOURCE/u);
  assert.equal(state(box).job, null, 'a rewound policy grants no queued worker');
});
