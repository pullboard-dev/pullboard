/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/codemap/src/io/cells/scripts/plan.js */
/** A builder's new source may carry exactly its own canonical placement across lane boundaries [L3,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  readPlan,
  writePlan,
  placePath,
} from '../../../../packages/codemap/index.js';
import { planRowChange } from '../../../../packages/commits/light.js';
import { requirePlannedSource } from '../../../../packages/items/index.js';
import { plannedProject } from '../../tests/fixtures/placement.js';
import { success } from '../../tests/fixtures/placement.js';
import {
  runFixtureChild,
  runFixtureChildAsync,
} from '../../tests/fixtures/child.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { awaitNestedRun } from '../../../../packages/gate/index.js';

/** Complete the placement rule's trial with native gates and their actual receipts. */
async function completePlacementTrial(t, box) {
  const probe = join(box.dir, 'placement-trial-probe');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', probe, 'main');
  success(box, probe, 'join', 'view', '--route', 'strong');
  const seat = success(box, probe, 'whoami').id;
  const id = success(box, box.repo, 'add', 'view', 'Cells move 1/1: placement trial probe', '--specs', 'G1',
    '--criterion', 'The placement trial observes an unplaced source.', '--check', 'node check.cjs', '--wait').item.item_id;
  const claim = success(box, probe, 'claim', String(id));
  const file = 'src/view/placement-trial-probe.js';
  mkdirSync(join(probe, 'src/view'), { recursive: true });
  writeFileSync(join(probe, file), 'export const probe = true;\n');
  box.git(probe, 'add', file);
  box.git(probe, 'commit', '-q', '-m', 'feat(view): observe placement trial [G1]');
  assert.equal(success(box, probe, 'submit', String(id), '--wait').gate.green, true);
  const head = box.git(probe, 'rev-parse', 'HEAD');
  const main = box.git(box.repo, 'rev-parse', 'main');
  const tool = relative => pathToFileURL(resolve(import.meta.dirname, '../../../..', relative)).href;
  const gate = tool('packages/gate/index.js');
  const driver = join(box.dir, 'placement-trial-gates.mjs');
  writeFileSync(driver, `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSubmitGate, refusalTrialFile, readGateReceipt, receiptStore } from ${JSON.stringify(gate)};
import { loadConfig } from ${JSON.stringify(tool('packages/config/index.js'))};
${executionServicesSource(gate)}
const root=${JSON.stringify(probe)},head=${JSON.stringify(head)},main=${JSON.stringify(main)},item=${id},seat=${JSON.stringify(seat)};
const ledger=()=>JSON.parse(readFileSync(refusalTrialFile(root),'utf8'));
const entry=Object.entries(ledger().codes).find(([key])=>key.startsWith('CELLS_PLAN_UNPLACED@'));
assert.ok(entry, 'the real submit observed the placement rule');
const [key,row]=entry, ids=[];
while(ledger().gates-row.start<20){
  const before=ledger().gates;
  const proof=await runSubmitGate(root,loadConfig(root),{executionServices,base:head,trunk:main,check:'node check.cjs',agent:seat,item:String(item),
    proofContext:{item,seat,frozenDigest:${JSON.stringify(claim.digest)}}});
  assert.equal(proof.isGreen,true);
  assert.ok(proof.proofReceiptIds.length>0);
  for(const receiptId of proof.proofReceiptIds){
    const receipt=readGateReceipt(receiptStore(root),receiptId);
    assert.equal(receipt.head,head); assert.equal(receipt.green,true); ids.push(receiptId);
  }
  assert.equal(ledger().gates,before+1);
  assert.ok(ledger().codes[key]);
}
assert.equal(new Set(ids).size,ids.length);
`);
  const env = Object.fromEntries(Object.entries(box.env).filter(([key]) => !key.startsWith('PULLBOARD_') && !['NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(key)));
  Object.assign(env, { PULLBOARD_HOME: box.env.PULLBOARD_HOME, PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME });
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [driver], { cwd: probe, env, encoding: 'utf8', signal: t.signal }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

/** Join a real view seat and claim a completed-baseline item through the native CLI. */
async function ownPlacementFixture(t) {
  const box = await plannedProject(t, { companionLanes: true });
  const view = join(box.dir, 'own-placement-view');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', view, 'main');
  success(box, view, 'join', 'view', '--route', 'strong');
  const id = success(box, box.repo, 'add', 'view', 'Place an owned new file', '--specs', 'G1',
    '--criterion', 'The builder owns the new file and only adds its canonical row.', '--check', 'node check.cjs', '--wait').item.item_id;
  success(box, view, 'claim', String(id));
  const file = 'src/view/own-placement-added.js';
  mkdirSync(join(view, 'src/view'), { recursive: true });
  writeFileSync(join(view, file), 'export const placed = true;\n');
  box.git(view, 'add', file);
  placePath(view, file, { cell: 'app:view' });
  box.git(view, 'add', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan');
  return { ...box, view, id, file };
}

test('a view commit creating its own file and one plan row passes the hook and native submit [L3,C7]', async t => {
  const box = await ownPlacementFixture(t);
  box.git(box.view, 'commit', '-q', '-m', 'feat(view): add source and its own placement [G1]');
  rmSync(box.marker, { force: true });
  const submitted = success(box, box.view, 'submit', String(box.id));
  assert.equal(submitted.gate.green, true);
  assert.equal(existsSync(box.marker), true, 'the native gate ran after the committed placement passed');
  assert.equal(box.git(box.view, 'status', '--porcelain'), '');
});

test('adding an owned new-file row cannot lend authority to editing an existing row [L3,C7]', async t => {
  const box = await ownPlacementFixture(t);
  const plan = readPlan(box.view);
  const cell = plan.cells.find(cell => cell.name === 'app:view');
  const original = structuredClone(cell.paths[0]);
  cell.paths[0][1] = cell.paths[0][1].replace('/io/', '/logic/');
  assert.notEqual(cell.paths[0][1], original[1]);
  writePlan(box.view, plan);
  box.git(box.view, 'add', 'packages/codemap/data/plan');
  const before = box.git(box.view, 'rev-parse', 'HEAD');
  const refused = runFixtureChild('git', ['commit', '-m', 'feat(view): alter a foreign row [G1]'],
    { cwd: box.view, env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /existing plan row/);
  assert.ok((refused.stdout + refused.stderr).includes(original[0]), 'refusal names the existing source row');
  assert.equal(box.git(box.view, 'rev-parse', 'HEAD'), before, 'the refused hook creates no commit');
  assert.ok(box.git(box.view, 'status', '--porcelain').includes(box.file), 'the original staged work remains available');
});

test('native view submit validates its core companion placement on the composed source [C7,V4]', async t => {
  const box = await plannedProject(t, { companionLanes: true });
  await completePlacementTrial(t, box);
  const view = join(box.dir, 'placement-view'), core = join(box.dir, 'placement-core');
  for (const [path, lane] of [[view, 'view'], [core, 'core']]) {
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    success(box, path, 'join', lane, '--route', 'strong');
  }
  const author = success(box, core, 'whoami').id;
  const id = success(box, box.repo, 'add', 'view', 'Cells move 1/1: place through a core companion', '--specs', 'G1',
    '--criterion', 'The new view source is placed by its core companion.', '--check', 'node check.cjs', '--wait').item.item_id;
  success(box, view, 'claim', String(id));
  const file = 'src/view/plan-companion-added.js';
  mkdirSync(join(view, 'src/view'), { recursive: true });
  writeFileSync(join(view, file), 'export const companionPlaced = true;\n');
  box.git(view, 'add', file);
  box.git(view, 'commit', '-q', '-m', 'feat(view): add the companion-placed source [G1]');
  const source = box.git(view, 'rev-parse', 'HEAD');
  rmSync(box.marker, { force: true });
  const refused = box.run(view, 'submit', String(id), '--wait', '--no-next', '--json');
  const trials = join(box.repo, '.git', 'pullboard', 'refusal-trials.json');
  assert.equal(refused.code, 1, refused.out + refused.err + (existsSync(trials) ? readFileSync(trials, 'utf8') : ''));
  assert.equal(JSON.parse(refused.out).error.code, 'CELLS_PLAN_UNPLACED', refused.out + refused.err);
  assert.match(refused.out, /src\/view\/plan-companion-added\.js/);
  assert.equal(existsSync(box.marker), false, 'the unplaced bare source never runs its check');
  placePath(view, file, { cell: 'app:view' });
  const patch = join(box.dir, 'core-placement.patch');
  writeFileSync(patch, box.git(view, 'diff', '--', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan') + '\n');
  box.git(view, 'restore', '--', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan');
  assert.equal(box.git(view, 'status', '--porcelain'), '', 'the builder keeps its clean original source');
  success(box, box.repo, 'patch', 'attach', String(id), patch, '--key', 'core-placement', '--author', author, '--source', source);
  const submitted = success(box, view, 'submit', String(id), '--wait');
  assert.equal(submitted.gate.green, true);
  assert.equal(submitted.gate.companion.source, source);
  assert.notEqual(submitted.gate.companion.commit, source, 'the actual gate proves the composed source');
  assert.equal(existsSync(box.marker), true, 'the composed source now reaches its real check');
  assert.throws(() => requirePlannedSource(view, box.git(box.repo, 'rev-parse', 'HEAD'), source), /plan-companion-added\.js/,
    'the companion never lends its placement to the bare builder source');
});


/** Keep the pure authority boundary explicit; native journeys above supply real Git/index reads. */
function syntheticPlanChange(change = value => value, ownNewFile = path => path === 'src/view/new.css') {
  const path = 'packages/codemap/data/plan/45-app-view.json';
  const index = { cells: [{ name: 'app:view', order: 39, file: path }], stays: [] };
  const cell = { name: 'app:view', order: 39, root: 'apps/view', paths: [
    ['src/view/old.css', 'apps/view/src/io/view/old.css', 'seed'],
  ] };
  const before = { 'packages/codemap/data/plan/cells.json': index, [path]: cell };
  const after = structuredClone(before);
  after[path].paths.push(['src/view/new.css', 'apps/view/src/io/view/new.css', 'rule']);
  change(after, path);
  const read = data => file => data[file] && ({ mode: '100644', bytes: Buffer.from(JSON.stringify(data[file])) });
  return planRowChange(path, { before: read(before), after: read(after), ownNewFile });
}

test('synthetic plan metadata cannot authorize existing files, foreign files, duplicate targets or other plan edits [L3,C7]', () => {
  assert.equal(syntheticPlanChange().allowed, true);
  assert.equal(syntheticPlanChange(value => value, () => false).allowed, false, 'Git creation and lane ownership are both required');
  const mutations = [
    (data, path) => { data[path].paths[0][1] += '-changed'; },
    (data, path) => { data[path].root = 'apps/other'; },
    data => { data['packages/codemap/data/plan/cells.json'].stays.push({ path: 'src/view/new.css' }); },
    (data, path) => { data[path].paths.at(-1)[1] = 'apps/view/src/io/wrong.css'; },
    (data, path) => { data[path].paths.at(-1)[2] = 'seed'; },
    (data, path) => { data[path].paths.push([...data[path].paths.at(-1)]); },
    (data, path) => { data[path].paths.at(-1)[0] = 'src/view/../escape.css'; },
  ];
  for (const mutate of mutations) assert.equal(syntheticPlanChange(mutate).allowed, false);
});
