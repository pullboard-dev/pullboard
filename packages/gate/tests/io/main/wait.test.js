/** Gate admission keeps its awaited callbacks alive until a recorded outcome [C7,Q1]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChildAsync } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

/** Run an actual SQLite admission in a child whose callbacks hold no event-loop reference. */
async function admissionCase(t, refused) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-admission-await-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', root]);
  const home = join(root, '.machine');
  mkdirSync(home);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { shortSlots: 0 } }));
  const gate = new URL('../../../index.js', import.meta.url).href;
  const resources = new URL('../../../../resources/index.js', import.meta.url).href;
  const runners = new URL('../../../../runners/index.js', import.meta.url).href;
  const landing = new URL('../../../../landing/index.js', import.meta.url).href;
  const source = `import { withGateSlot } from ${JSON.stringify(gate)};
import { takeResource, listResources } from ${JSON.stringify(resources)};
import { runnerExecutionServices } from ${JSON.stringify(runners)};
import { landingExecutionServices } from ${JSON.stringify(landing)};
const holder = await takeResource({ name: 'gate', capacity: 1, root: process.cwd(), agent: 'fixture-holder' });
let waits = 0, actions = 0, receipts = 0, result = null, error = null;
try {
  result = await withGateSlot(process.cwd(), () => { actions++; return 'completed'; }, {
    remote: false, agent: 'fixture-waiter',
    executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() },
    onReceipt: () => { receipts++; },
    onWait: async state => {
      await new Promise(resolve => setImmediate(resolve).unref());
      if (state.admitted) return;
      waits++;
      if (waits === 3) {
        if (${JSON.stringify(refused)}) throw new Error('fixture admission refused');
        holder.release();
      }
    },
  });
} catch (failure) { error = failure.message; }
finally { holder.release(); }
const residual = listResources().reduce((count, entry) => count + entry.holders.length + entry.line.length, 0);
process.stdout.write(JSON.stringify({ waits, actions, receipts, result, error, residual }));`;
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: home };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env });
  assert.equal(result.status, 0, result.context);
  assert.deepEqual(JSON.parse(result.stdout), refused
    ? { waits: 3, actions: 0, receipts: 0, result: null, error: 'fixture admission refused', residual: 0 }
    : { waits: 3, actions: 1, receipts: 1, result: 'completed', error: null, residual: 0 });
}

test('gate.io-main-wait.an-awaited-gate-admission-callback-survives: an awaited gate admission callback survives until its action and receipt complete [C7,Q1]', async t => {
  await admissionCase(t, false);
});

test('gate.io-main-wait.an-awaited-gate-admission-refusal-is: an awaited gate admission refusal is reported without starting its action [C7,Q1]', async t => {
  await admissionCase(t, true);
});
