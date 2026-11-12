/** A genuine main move between preflight and queueing never substitutes gate authority [V4,H16,E18]. */
import { handoffRecord } from '../../../../../packages/store/index.js';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { gateSettled } from '../../../tests/fixtures/submit/handoff.js';
import { removeSandboxes } from '../../../tests/fixtures/submit/handoff.js';

/** Observe only this private CLI fixture's durable job and item state. */
function state(box) {
  // @pullboard-board-file journey: the real CLI owns every queue, proof and submission write.
  const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return { job: handoffRecord(db, box.id) ?? null,
      item: db.prepare('SELECT item_status,item_commit FROM item WHERE item_id=?').get(box.id) };
  } finally { db.close(); }
}

/** Build a real claimed candidate and advance main causally when native preflight reports composition. */
async function fixture(t, rewind, gateMove = null) {
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
  if (gateMove) writeFileSync(join(box.repo, 'test/feature.test.js'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {feature} from '../web/feature.js'; import {execFileSync} from 'node:child_process'; import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const root=${JSON.stringify(box.repo)}, marker=${JSON.stringify(join(box.dir, 'gate-moved'))};
test('feature [G1]',()=>{ if(process.cwd().includes('/submit-handoffs/') && !existsSync(marker)) {
  if (${JSON.stringify(gateMove)} === 'policy') { const f=root+'/pullboard.json'; const c=JSON.parse(readFileSync(f,'utf8')); c.verify={...c.verify,family:'require'}; writeFileSync(f,JSON.stringify(c)); }
  else writeFileSync(root+'/gate-advance.txt','advanced');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
  execFileSync('git',['-C',root,'add','-A'],{env}); execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','core.hooksPath=/dev/null','commit','-qm','chore: advance during gate [G1]'],{env});
  if (${JSON.stringify(gateMove)} === 'twice') { writeFileSync(root+'/second-advance.txt','advanced again'); execFileSync('git',['-C',root,'add','-A'],{env}); execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','core.hooksPath=/dev/null','commit','-qm','chore: advance again [G1]'],{env}); }
  writeFileSync(marker,'done'); } assert.equal(feature,'item'); });\n`);
  writeFileSync(join(box.repo, 'test/other.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {other} from '../web/other.js';test('other [G1]',()=>assert.equal(other,'independent'));\n");
  writeFileSync(join(box.repo, 'bin/run-tests.js'), "import {spawnSync} from 'node:child_process';const env={...process.env};delete env.NODE_TEST_CONTEXT;const run=spawnSync(process.execPath,['--test','--test-reporter=tap',...process.argv.slice(2)],{encoding:'utf8',env});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1;\n");
  const config = join(box.repo, 'pullboard.json');
  // The bar names the runner and its test file; the web lane must own them or claim refuses CROSS_OWNERSHIP.
  const lanes = { ...helpers.CONFIG.lanes, web: { ...helpers.CONFIG.lanes.web, owns: [...helpers.CONFIG.lanes.web.owns, 'bin/run-tests.js', 'test/feature.test.js'] } };
  writeFileSync(config, JSON.stringify({ ...helpers.CONFIG, lanes,
    gate: 'node bin/run-tests.js test/feature.test.js', affectedTests: 'node bin/run-tests.js', submit: { handoff: true } }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: enable private queued gate [G1]');
  const parent = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.repo, 'commit', '--allow-empty', '-qm', 'chore: captured accepted main [G1]');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Main move candidate', '--specs', 'G1',
    '--criterion', 'The feature is item.', '--check', 'node bin/run-tests.js test/feature.test.js', '--wait', '--json');
  assert.equal(added.code, 0, added.out + added.err);
  box.id = JSON.parse(added.out).item.item_id;
  const claimed = await box.runLocal(box.web, 'claim', String(box.id));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const built = helpers.commitFile(box, box.web, 'web/feature.js', "export const feature='item';\n", 'feat(web): private candidate [G1]');
  assert.equal(built.status, 0, built.stderr);
  const ready = await box.runLocal(box.repo, 'bar', 'ready', 'on', '--json');
  assert.equal(ready.code, 0, ready.out + ready.err);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const marker = join(box.dir, 'main-moved.json');
  const preload = join(box.dir, 'advance-main.mjs');
  writeFileSync(preload, `import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const marker=${JSON.stringify(marker)}, root=${JSON.stringify(box.repo)};
const write=process.stdout.write;
process.stdout.write=function(...args) {
  if (!${JSON.stringify(Boolean(gateMove))} && !existsSync(marker) && String(args[0]).includes('submit composition:')) {
    const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
    ${rewind ? `git('reset','--hard',${JSON.stringify(parent)});` : `mkdirSync(root+'/docs',{recursive:true}); writeFileSync(root+'/docs/advanced.md','accepted main advance\\n'); git('add','docs/advanced.md'); git('commit','-qm','docs: advance main during preflight [G1]');`}
    writeFileSync(marker,JSON.stringify({main:git('rev-parse','HEAD')}),{flag:'wx'});
  }
  return Reflect.apply(write,this,args);
};\n`);
  t.after(async () => {
    const job = state(box).job;
    if (job) await helpers.waitFor(() => !['queued', 'running'].includes(state(box).job?.state), // budget: owned worker cleanup hang ceiling; no throughput claim.
      'queued worker finished', 120000); // budget: owned-child hang ceiling, no elapsed-time assertion.
    // The gate driver and dispatcher still write for a moment after the job ends; remove the tree only once they are done.
    await gateSettled(helpers, box, job?.id);
    await removeSandboxes(helpers);
  });
  return { ...box, helpers, main, commit, marker, preload };
}

/** Run the public command with an output observer that moves real Git refs, without replacing a service. */
function submit(box) {
  // Process-level: a preload moves real Git refs inside the submit child.
  return runFixtureChild(process.execPath, ['--import', pathToFileURL(box.preload).href, box.helpers.BIN,
    'submit', String(box.id), '--no-next'], { cwd: box.web, env: box.env, encoding: 'utf8' });
}

test('queued submit accepts a forward main move during native preflight [V4,H16,E18]', async t => {
  const box = await fixture(t, false);
  const result = submit(box);
  assert.ok(existsSync(box.marker), result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /queued gate/u);
  const queued = state(box).job;
  assert.equal(queued.commit, box.commit, 'queue preserves the captured candidate');
  assert.equal(queued.main, box.main, 'queue preserves the accepted preflight policy');
  await box.helpers.waitFor(() => ['green', 'submitted', 'red', 'incomplete'].includes(state(box).job?.state), // budget: actual gate completion hang ceiling; no throughput claim.
    'the actual queued gate result', 120000); // budget: real-worker hang ceiling, no elapsed-time assertion.
  const completed = state(box);
  assert.equal(completed.job.state, 'green', JSON.stringify(completed.job));
  assert.equal(completed.item.item_status, 'submitted');
  assert.equal(completed.item.item_commit, box.commit, 'the queued proof records its captured source; landing composes later main');
});

test('queued submit still refuses a main rewind during native preflight [V4,H16,E18]', async t => {
  const box = await fixture(t, true);
  const result = submit(box);
  assert.ok(existsSync(box.marker), result.stdout + result.stderr);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}\nrepo head ${box.git(box.repo, 'rev-parse', 'HEAD')}; captured main ${box.main}; marker ${readFileSync(box.marker, 'utf8')}; job ${JSON.stringify(state(box).job)}`);
  assert.match(result.stdout + result.stderr, /SUBMIT_HANDOFF_SOURCE/u);
  assert.equal(state(box).job, null, 'a rewound policy grants no queued worker');
});

for (const mode of ['unrelated', 'twice', 'policy']) test(`queued gate handles ${mode} main change [V4,H16,E18]`, async t => {
  const box = await fixture(t, false, mode);
  const result = submit(box);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await box.helpers.waitFor(() => ['green', 'red', 'incomplete'].includes(state(box).job?.state), // budget: real queued worker completion hang ceiling, no elapsed-time assertion.
    'queued gate completion', 120000); // budget: owned-worker hang ceiling, no throughput claim.
  assert.ok(existsSync(join(box.dir, 'gate-moved')), 'main moved while the queued check ran');
  const completed = state(box);
  if (mode !== 'policy') {
    assert.equal(completed.job.state, 'green', JSON.stringify(completed.job));
    assert.equal(completed.item.item_status, 'submitted');
  } else {
    assert.notEqual(completed.job.state, 'green', JSON.stringify(completed.job));
    const refusal = JSON.parse(readFileSync(join(box.repo, '.git/pullboard/submit-handoffs', completed.job.id, 'refusal.json'), 'utf8'));
    assert.match(JSON.stringify(refusal), /UNDECLARED_BUILDER_FAMILY/u);
  }
});
