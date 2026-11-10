/** Real landing controls for automatically tightened doctrine counts [B3,R3,D1,D3]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Configure private tier-one landing with one person-approved, held quality check. */
function configure(box, command, count) {
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
  appendFileSync(join(box.repo, 'DOCTRINE.md'),
    `\n## Q · Quality\n- Q1 [approved, must] The quality count only falls. | gate: check ${command} | count: ${count}\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure held landing quality');
}

/** Parse a successful private command without hiding its actual stdout or stderr. */
function json(box, ...args) {
  const result = box.run(box.repo, ...args, '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Prove a lower count reaches the committed trunk, while interacting green items cannot raise it. */
export function assertLandingDoctrineCounts({ landProject, itemWorktree, submitItem, acceptItem }) {
  const falling = landProject();
  mkdirSync(join(falling.repo, 'web'), { recursive: true });
  writeFileSync(join(falling.repo, 'web/markers.txt'), 'TODO first\nTODO second\n');
  configure(falling, 'grep -n TODO web/markers.txt', 2);
  const improved = itemWorktree(falling, 1, 'web/markers.txt');
  submitItem(falling, improved, 'TODO second\n');
  acceptItem(falling, improved);
  const oldRemote = falling.git(falling.remote, 'rev-parse', 'main');
  const landed = json(falling, 'land');
  assert.deepEqual(landed.landed, [improved.item]);
  const committed = falling.git(falling.repo, 'show', `${landed.batch.tip}:DOCTRINE.md`);
  assert.match(committed, /Q1 .*\| count: 1$/mu, 'the lower count is committed at the exact landed tip');
  assert.match(readFileSync(join(falling.repo, 'DOCTRINE.md'), 'utf8'), /Q1 .*\| count: 1$/mu);
  assert.equal(falling.git(falling.repo, 'rev-parse', 'HEAD'), landed.batch.tip);
  assert.equal(falling.git(falling.remote, 'rev-parse', 'main'), oldRemote, 'tier-one tightening never publishes');
  assert.deepEqual(landed.batch.doctrineCounts, [{ id: 'Q1', before: 2, count: 1 }], 'the durable report names both counts');
  const unchanged = json(falling, 'land');
  assert.deepEqual(unchanged.landed, [], 'a completed tightening is not committed twice');

  const rising = landProject();
  const source = "const fs = require('node:fs'); if (fs.existsSync('web/land-1.test.js') && fs.existsSync('web/land-2.test.js')) console.log('interacting problems');";
  writeFileSync(join(rising.repo, 'quality.cjs'), source);
  configure(rising, 'node quality.cjs', 0);
  const entries = [itemWorktree(rising, 1), itemWorktree(rising, 2)];
  for (const entry of entries) { submitItem(rising, entry); acceptItem(rising, entry); }
  const before = rising.git(rising.repo, 'rev-parse', 'main');
  const result = rising.run(rising.repo, 'land', '--json');
  const report = JSON.parse(result.out);
  assert.equal(rising.git(rising.repo, 'rev-parse', 'main'), before, 'combined higher count holds the trunk');
  assert.deepEqual(report.landed ?? [], [], `${result.err}\n${result.out}`);
  assert.match(`${result.err}\n${result.out}`, /Q1.*(?:rose|1.*0)/su, 'the higher count explains the hold');
  assert.match(rising.git(rising.repo, 'show', 'main:DOCTRINE.md'), /Q1 .*\| count: 0$/mu, 'no count is raised');
  assertNestedDoctrineLease({ landProject, itemWorktree, submitItem, acceptItem });
}

/** A nested native test runner must reuse a real landing lease on a one-slot private machine. */
function assertNestedDoctrineLease({ landProject, itemWorktree, submitItem, acceptItem }) {
  const box = landProject();
  for (const name of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[name];
  json(box, 'settings', 'browserSlots', '1');
  json(box, 'settings', 'gateSlots', '1');
  const armed = join(box.dir, 'nested-doctrine-armed');
  const receipt = join(box.dir, 'nested-doctrine-receipt.jsonl');
  const output = join(box.dir, 'nested-doctrine-output.log');
  const probe = join(box.dir, 'nested-doctrine-probe.test.mjs');
  writeFileSync(probe, [
    "import assert from 'node:assert/strict'; import { test } from 'node:test'; import { appendFileSync } from 'node:fs';",
    "import { DatabaseSync } from 'node:sqlite';",
    "test('nested doctrine inherits the actual landing gate [D1,D3]', () => {",
    "  const pool = process.env.PULLBOARD_GATE_SLOT_POOL; assert.ok(pool, 'the real parent pool marker reaches the probe');",
    "  const db = new DatabaseSync(pool, { readOnly: true }); let holder;",
    "  try { holder = db.prepare(\"SELECT * FROM holder WHERE name = 'gate' AND token = ?\").get(process.env.PULLBOARD_GATE_SLOT_TOKEN);",
    "    assert.equal(db.prepare(\"SELECT capacity FROM resource WHERE name = 'gate'\").get().capacity, 1); } finally { db.close(); }",
    "  assert.equal(holder?.kind, 'doctrine', 'the original landing doctrine lease is still held, not a new test-runner lease');",
    `  appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ probe: true, pool, holderKind: holder.kind }) + '\\n');`,
    '});',
  ].join('\n'));
  const runner = resolve(import.meta.dirname, '../../../../../packages/gate/src/io/run/tests.js');
  writeFileSync(join(box.repo, 'quality.cjs'), [
    "const fs = require('node:fs'); const { spawnSync } = require('node:child_process');",
    `if (fs.existsSync(${JSON.stringify(armed)})) {`,
    `const result = spawnSync(process.execPath, [${JSON.stringify(runner)}, ${JSON.stringify(probe)}], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGTERM' });`,
    `fs.appendFileSync(${JSON.stringify(output)}, (result.stdout || '') + (result.stderr || ''));`,
    `fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ quality: true, childPid: result.pid, parentMarked: process.env.PULLBOARD_GATE_SLOT_HELD === '1', status: result.status, signal: result.signal, error: result.error?.code ?? null }) + '\\n');`,
    'if (result.status !== 0) process.exit(2);',
    '}',
    "for (const line of fs.readFileSync('web/markers.txt', 'utf8').split('\\n')) if (line.includes('TODO')) console.log(line);",
  ].join('\n'));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/markers.txt'), 'TODO first\nTODO second\n');
  configure(box, 'node quality.cjs', 2);
  const improved = itemWorktree(box, 1, 'web/markers.txt');
  submitItem(box, improved, 'TODO second\n');
  acceptItem(box, improved);
  // Arm only after setup: this control isolates landing, not an unrelated submit gate.
  writeFileSync(armed, 'ready');
  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}\nnested receipt: ${existsSync(receipt) ? readFileSync(receipt, 'utf8') : '(absent)'}\nnested output: ${existsSync(output) ? readFileSync(output, 'utf8') : '(absent)'}`);
  const landed = JSON.parse(result.out);
  assert.deepEqual(landed.landed, [improved.item]);
  assert.match(box.git(box.repo, 'show', `${landed.batch.tip}:DOCTRINE.md`), /Q1 .*\| count: 1$/mu);
  assert.deepEqual(landed.batch.doctrineCounts, [{ id: 'Q1', before: 2, count: 1 }]);
  const rows = readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.probe), 'the actual nested native runner executed the probe');
  assert.ok(rows.some(row => row.quality && row.status === 0), readFileSync(output, 'utf8'));
  const db = new DatabaseSync(join(box.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM holder WHERE name IN ('gate','browser')").get().n, 0, 'private resource holders drained');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM waiter WHERE name IN ('gate','browser')").get().n, 0, 'private resource waiters drained');
  } finally { db.close(); }
}
