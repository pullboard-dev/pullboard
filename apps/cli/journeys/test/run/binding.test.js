/** A claimed focused test carries its actual item into the isolated native resource queue [C7,Q1,Q2]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';
import { test } from 'node:test';
import { listResources } from '../../../../../packages/resources/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { startFixtureChild } from '../../../tests/fixtures/child.js';
import { waitForFixtureProgress } from '../../../tests/fixtures/progress.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const BIN = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
const RESOURCES = pathToFileURL(fileURLToPath(new URL('../../../../../packages/resources/index.js', import.meta.url))).href;

/** Observe only this fixture machine's public resource projection, without lending it the outer runner's lease. */
function resources(box) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  try { return listResources({ root: box.repo }).find(row => row.name === 'gate'); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/** Launch one owned fixture process and retain its real exit and output for bounded handshakes. */
function child(box, args, cwd, extra = {}) {
  const started = startFixtureChild(process.execPath, args, { cwd, env: { ...box.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  started.output = ''; started.errors = '';
  started.stdout.setEncoding('utf8').on('data', part => { started.output += part; });
  started.stderr.setEncoding('utf8').on('data', part => { started.errors += part; });
  started.finished = new Promise(resolve => started.once('close', (code, signal) => resolve({ code, signal })));
  return started;
}

/** Wait for actual queue or process evidence; a continuing native child is never judged by a speed threshold. */
async function observed(started, ready, description) {
  await waitForFixtureProgress({ child: started, ready, progress: () => started.output.length + started.errors.length, description });
}

test('a claimed pinned main-red test names its item and precedes an unclaimed other run in the native queue [C7,Q1,Q2]', async t => {
  const helpers = createE2eHelpers(), box = helpers.project('true');
  const children = [];
  t.after(async () => {
    for (const started of children) if (started.exitCode === null && started.signalCode === null) started.kill('SIGTERM');
    await Promise.all(children.map(started => started.finished));
    helpers.cleanup();
  });
  // These are private machine settings; no test process inherits admission to the outer real machine.
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    gate: { queue: { reviewsFirst: true, currentReleaseFirst: true } } }));
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, affectedTests: 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap' }));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/ready.test.js'), "import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('private fixture body', () => appendFileSync(process.env.BINDING_LOG, process.env.BINDING_LABEL+'\\n'));\n");
  box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'test(web): configure focused runner [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Main red: synthetic item binding', '--criterion', 'The actual queue retains the claimed item.', '--json');
  assert.equal(added.code, 0, added.err);
  const item = JSON.parse(added.out).item.item_id;
  for (const args of [['milestone', 'add', 'Now', '--items', String(item), '--reason', 'Arrange fixture release'], ['milestone', 'pin', 'Now', String(item), '--reason', 'Synthetic release blocker'], ['claim', String(item)]]) {
    const run = box.run(args[0] === 'claim' ? box.web : box.repo, ...args);
    assert.equal(run.code, 0, run.err);
  }
  const seat = JSON.parse(box.run(box.web, 'whoami', '--json').out).id;
  const holder = child(box, ['--input-type=module', '-e', `import {takeResource} from ${JSON.stringify(RESOURCES)}; const lease=await takeResource({name:'gate',capacity:1,scope:'machine',root:process.cwd(),agent:'fixture-holder'}); console.log('held'); for await (const line of process.stdin) if(String(line).trim()==='release')break; lease.release();`], box.repo);
  children.push(holder);
  await observed(holder, () => holder.output.includes('held'), 'private gate holder');
  const log = join(box.dir, 'execution-order');
  const unclaimed = child(box, [BIN, 'test', 'test/ready.test.js', '--json'], box.repo, { BINDING_LOG: log, BINDING_LABEL: 'unclaimed' });
  children.push(unclaimed);
  await observed(unclaimed, () => resources(box)?.line.some(row => row.agent === 'coordinator'), 'unclaimed focused waiter');
  const claimed = child(box, [BIN, 'test', 'test/ready.test.js', '--json'], box.web, { BINDING_LOG: log, BINDING_LABEL: 'claimed' });
  children.push(claimed);
  await observed(claimed, () => resources(box)?.line.some(row => row.agent === seat), 'claimed focused waiter');
  const line = resources(box).line;
  const owned = line.find(row => row.agent === seat), other = line.find(row => row.agent === 'coordinator');
  assert.equal(owned.item, String(item));
  assert.equal(owned.queueClass, 'submit', 'an actual claimed test takes the native item-check class');
  assert.equal(Object.hasOwn(other, 'item'), false, 'the public unclaimed row has no item field');
  assert.equal(other.queueClass, 'other', 'an unclaimed run receives no item priority');
  assert.ok(line.indexOf(owned) < line.indexOf(other), 'the claimed current pinned item precedes the earlier unclaimed run');
  holder.stdin.end('release\n');
  for (const started of [holder, claimed, unclaimed]) assert.equal((await started.finished).code, 0, started.errors + started.output);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['claimed', 'unclaimed'], 'actual test execution follows native queue order');
});
