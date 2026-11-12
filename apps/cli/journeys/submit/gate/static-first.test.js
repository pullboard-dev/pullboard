/** @pullboard-test-input source-tree */
/**
 * The static style checks run first and a red gate queues its flake diagnostics: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  startDiagnostics,
} from '../../../../../packages/gate/index.js';
import {
  coordinatorLocal,
  runLocal,
} from './local.js';
import {
  SPEC,
  privateRepo,
  builderRepo,
  put,
  commitAll,
} from '../../../tests/fixtures/submit/gate.js';
import {
  test,
} from 'node:test';

test('clause 1: a submit runs the static style checks first [C7]', async (t) => {
  // Source under src/, packages/ and apps/ has its multi-binding imports split at commit (776212f0fc), so the violation lives in a .jsx file the splitter skips.
  let box = privateRepo(t);
  const marker = join(box.dir, 'item-check-ran');
  box.env.ITEM_CHECK_MARKER = marker;
  const check = 'node -e "require(\'node:fs\').writeFileSync(process.env.ITEM_CHECK_MARKER, \'ran\')"';
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node -e "process.exit(0)"',
    affectedTests: 'node --test', submitGate: 'landing', staticChecks: 'node test/static-style-check.mjs',
    spec: 'SPEC.md', verify: 'any', lease: '2h', shared: ['pullboard.json'] }));
  put(box.root, 'src/cli.jsx', "import { join } from 'node:path';\nexport const fixture = join;\n");
  const oracle = new URL('../../../tests/fixtures/style.js', import.meta.url).href;
  put(box.root, 'test/static-style-check.mjs', [
    "import { readFileSync } from 'node:fs';",
    `import { importStyleViolations } from ${JSON.stringify(oracle)};`,
    "const file = 'src/cli.jsx';",
    "const errors = importStyleViolations([{ file, source: readFileSync(file, 'utf8') }]);",
    "for (const row of errors) console.error(`${row.file}:${row.line}: one import binding per line`);",
    'process.exit(errors.length ? 1 : 0);',
  ].join('\n'));
  commitAll(box);
  box = builderRepo(box);
  const added = await coordinatorLocal(box, 'add', 'build', 'Static style before proof', '--check', check);
  assert.equal(added.code, 0, added.err);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  const candidateConfig = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  candidateConfig.staticChecks = '';
  put(box.root, 'pullboard.json', JSON.stringify(candidateConfig));
  put(box.root, 'src/cli.jsx', "import { join, resolve } from 'node:path';\nexport const fixture = join;\n");
  commitAll(box, 'feat(core): expose the missed static guard [G1]');
  rmSync(marker, { force: true });
  const submitted = await runLocal(box, 'submit', '1', '--json', '--infra', 'the static guard fixture edits its pullboard.json');
  assert.notEqual(submitted.code, 0, 'submit must refuse a static import violation before any item proof');
  assert.match(submitted.out + submitted.err, /src\/cli\.jsx:1: one import binding per line/u);
  assert.equal(existsSync(marker), false, 'the frozen item check must not run after an early static refusal');
  assert.equal(JSON.parse((await runLocal(box, 'show', '1', '--json')).out).item_status, 'claimed');
  const checked = await runLocal(box, 'check', '1', '--yes', '--json');
  assert.notEqual(checked.code, 0, 'an explicit check must run the same accepted project guard first');
  assert.match(checked.out + checked.err, /src\/cli\.jsx:1: one import binding per line/u);
  assert.equal(existsSync(marker), false, 'neither a submit nor a check bypasses the failed static guard');
});

test('clause 1: a red gate queues its flake diagnostics before it asks for a slot, and returns without waiting for one [C7,V4]', async () => {
  const events = [];
  const onFailure = Object.assign(async () => { events.push('observed'); }, { queue: async run => { events.push(`queued ${run.name}`); } });
  // A slot provider that never grants: the diagnostics wait for it, the verdict does not.
  const withSlot = () => { events.push('slot asked'); return new Promise(() => {}); };
  const started = await startDiagnostics('/unused', onFailure, [[{ name: 'red-run' }, { root: '/unused', command: 'true', lease: {} }]], {}, { withSlot });
  assert.deepEqual(events, ['queued red-run', 'slot asked'], 'the job is queued first, then the slot is asked for');
  assert.ok(started.done instanceof Promise, 'the pending diagnostics are handed back, not awaited');
});

test('clause 2: diagnostics run in the granted slot and leave the verdict untouched when the slot fails [C7,V4]', async () => {
  const seen = [];
  const run = { isGreen: false, name: 'red-run' };
  const onFailure = Object.assign(async (observed, context) => { seen.push([observed.name, context.lease.timingOperation]); }, { queue: async () => {} });
  const granted = { proof: null };
  const withSlot = async (_root, work) => { await work(granted); };
  await (await startDiagnostics('/unused', onFailure, [[run, { root: '/unused', command: 'true', lease: { proof: 'p' } }]], {}, { withSlot })).done;
  assert.deepEqual(seen, [['red-run', 'submit']], 'the observer ran once, in the granted slot');
  const failing = async (_root, _work) => { throw Object.assign(new Error('no slot'), { code: 'GATE_INFRA_EXHAUSTED' }); };
  await (await startDiagnostics('/unused', onFailure, [[run, { root: '/unused', command: 'true', lease: {} }]], {}, { withSlot: failing })).done;
  assert.equal(run.isGreen, false, 'a failed diagnostics slot never changes the red verdict');
});
