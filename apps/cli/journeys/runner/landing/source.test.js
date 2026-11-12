/** An automatic batch commits landing amendments before runner-only gate admission [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  HOST,
  installSshStandIn,
} from '../../../tests/fixtures/runner/ssh.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ ...e2e,
  sandbox(...args) { const box = e2e.sandbox(...args); box.env.PULLBOARD_MODEL = 'landing-source-fixture'; return box; } });

/** Return an unnumbered engine whose landing amendment must be part of the runner's source commit. */
function unlandedEngine(name) {
  return `import { unassignedEngine } from './engine-next.js';\nexport const ${name.toUpperCase()}_ENGINE = unassignedEngine();\n`;
}

test('a real landing runner receives the clean committed engine amendment [C7]', { timeout: 180_000 }, async () => {
  const box = landProject();
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.gate = 'node runner-source.cjs';
  config.practice = 'DOCTRINE.md';
  config.lanes.web.owns = [...new Set([...config.lanes.web.owns, 'src/', 'docs/', 'packages/state/src/logic/engines/'])];
  delete config.affectedTests;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(box.repo, 'runner-source.cjs'), [
    "const { execFileSync } = require('node:child_process');",
    "const run = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();",
    "const dirty = run('status', '--porcelain');",
    "console.log('BATCH_SOURCE ' + run('rev-parse', 'HEAD') + ' ' + run('rev-parse', 'HEAD^{tree}') + ' ' + (dirty ? 'dirty' : 'clean'));",
    'if (dirty) process.exitCode = 1;',
  ].join('\n') + '\n');
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/state/src/logic/engines'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/state/src/logic/engines/base-engine.js'), '/** The landed base engine. */\nexport const BASE_ENGINE = 80;\n');
  writeFileSync(join(box.repo, 'docs/formats.md'), '| Format | Version |\n| --- | --- |\n| `move engine` | `80` | the fixture |\n');
  writeFileSync(join(box.repo, 'web/markers.txt'), 'TODO first\nTODO second\n');
  writeFileSync(join(box.repo, 'DOCTRINE.md'), '# Doctrine\n\n## Q · Quality\n- Q1 [approved, must] The quality count only falls. | gate: grep -n TODO web/markers.txt | count: 2\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure runner source fixture');
  box.git(box.repo, 'push', '-q', 'origin', 'main');

  const entry = itemWorktree(box, 1, 'web/markers.txt');
  writeFileSync(join(entry.path, entry.file), 'TODO second\n');
  mkdirSync(join(entry.path, 'packages/state/src/logic/engines'), { recursive: true });
  writeFileSync(join(entry.path, 'packages/state/src/logic/engines/alpha-engine.js'), unlandedEngine('alpha'));
  submitItem(box, entry);
  acceptItem(box, entry);

  const worker = join(box.dir, 'runner-worker');
  const sshBin = join(box.dir, 'runner-bin');
  const remoteHome = join(box.dir, 'runner-home');
  const remoteMachine = join(remoteHome, '.pullboard');
  const requests = join(box.dir, 'runner-requests.jsonl');
  const stderrLog = join(box.dir, 'runner-stderr.log');
  for (const path of [worker, sshBin, remoteHome, remoteMachine]) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin: sshBin, worker, home: remoteHome, machineHome: remoteMachine, requests, stderrLog });
  box.env.PATH = `${sshBin}:${box.env.PATH}`;
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    runners: [{ host: HOST, slots: 1, browser: 1 }], gate: { runnersOnly: true, memoryFloorMB: 0 } }));

  const result = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const landed = JSON.parse(result.out);
  assert.deepEqual(landed.landed, [entry.item]);
  const merged = JSON.parse((await box.runLocal(box.repo, 'show', String(entry.item), '--json')).out);
  assert.equal(box.git(box.repo, 'rev-list', '--parents', '-n', '1', merged.item_merged_commit).split(' ').length, 3,
    'the engine numbering amendment remains inside the landed item merge');
  assert.match(box.git(box.repo, 'show', `${merged.item_merged_commit}:packages/state/src/logic/engines/alpha-engine.js`), /ALPHA_ENGINE = \d+;/u);

  const gateLog = readFileSync(landed.batch.logPath, 'utf8');
  const source = /^BATCH_SOURCE ([a-f0-9]+) ([a-f0-9]+) (clean|dirty)$/mu.exec(gateLog);
  assert.ok(source, `the gate ran on the registered runner and reported its source\n${gateLog}`);
  assert.equal(source[1], landed.batch.tip, 'the runner checked out the fully amended batch tip');
  assert.equal(source[2], box.git(box.repo, 'rev-parse', `${landed.batch.tip}^{tree}`), 'the runner tree matches the batch tree');
  assert.equal(source[3], 'clean', 'runner admission received committed, clean source');
  assert.ok(readFileSync(requests, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .some(request => request.workerStarted && request.code === 0), 'the real runner stand-in completed the native worker request');
});
