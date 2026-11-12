/** A new numbered engine history file is data: landing never places it through the cells plan [C7,D3,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { Refused } from '../../../kernel/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { placeLandingHistory } from '../../index.js';

test('a new packages/state/data/history file is skipped, not placed [C7,D3]', () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-history-'));
  for (const folder of ['packages/codemap/data/plan', 'packages/codemap/src/io/cells/scripts']) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, 'packages/codemap/data/plan/cells.json'), '{}\n');
  writeFileSync(join(root, 'packages/codemap/src/io/cells/scripts/plan.js'), "import { appendFileSync } from 'node:fs'; appendFileSync('placed.log', JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']]) {
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '));
  }
  placeLandingHistory(root, ['packages/state/data/history/187.json', 'src/other.js']);
  const calls = existsSync(join(root, 'placed.log')) ? readFileSync(join(root, 'placed.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  assert.deepEqual(calls, [], 'history is data, so the plan placer is never asked to place it');
});

test('a generated history is not handed to the placer, so no refusal can fail the landing [C7,D3]', () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-history-'));
  mkdirSync(join(root, 'packages/codemap/data/plan'), { recursive: true });
  mkdirSync(join(root, 'packages/state/data/history'), { recursive: true });
  writeFileSync(join(root, 'packages/codemap/data/plan/cells.json'), '{}\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']]) {
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '));
  }
  writeFileSync(join(root, 'packages/state/data/history/233.json'), '{}\n');
  const seen = [];
  const failing = (cwd, file) => { seen.push(file); return { status: 1, stderr: `[CELLS_UNPLACED] use --place <in-scope path>: ${file}\n` }; };
  assert.deepEqual(placeLandingHistory(root, ['packages/state/data/history/233.json'], { place: failing }), []);
  assert.deepEqual(seen, [], 'the placer that would have refused was never called');
});
