/** A new numbered move-history file is staged, then placed as an engine stay, never into the state cell [C7,D3,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { Refused } from '../packages/kernel/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { placeLandingHistory } from '../packages/landing/index.js';

test('a new src/move-history file is placed as a stay [C7,D3]', () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-history-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/cells-plan.json'), '{}\n');
  writeFileSync(join(root, 'bin/cells-plan.js'), "import { appendFileSync } from 'node:fs'; appendFileSync('placed.log', JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']]) {
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '));
  }
  placeLandingHistory(root, ['src/move-history/187.json', 'src/other.js']);
  const calls = readFileSync(join(root, 'placed.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [['--place', 'src/move-history/187.json', '--stay']]);
});

test('a generated history is staged before placement, so the placer sees a tracked file [C7,D3]', () => {
  const root = mkdtempSync(join(tmpdir(), 'landing-history-'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'src/move-history'), { recursive: true });
  writeFileSync(join(root, 'bin/cells-plan.json'), '{}\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']]) {
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '));
  }
  // The history appears after the base commit, as a merge's regenerated file does: untracked until the lander adds it.
  writeFileSync(join(root, 'src/move-history/233.json'), '{}\n');
  const seen = [];
  const place = (cwd, file) => {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd });
    seen.push({ file, tracked: tracked.status === 0 });
    return tracked.status === 0 ? { status: 0 } : { status: 1, stderr: `[CELLS_UNPLACED] stage a regular source file before placing it: ${file}\n` };
  };
  placeLandingHistory(root, ['src/move-history/233.json'], { place });
  assert.deepEqual(seen, [{ file: 'src/move-history/233.json', tracked: true }]);
  // A placer refusal still surfaces as LAND_MERGE, now carrying the placer's own refusal line.
  const failing = () => ({ status: 1, stderr: 'noise\n[CELLS_UNPLACED] stage a regular source file before placing it: src/move-history/233.json\n' });
  assert.throws(() => placeLandingHistory(root, ['src/move-history/233.json'], { place: failing }), error =>
    error instanceof Refused && error.code === 'LAND_MERGE' && error.message.includes('[CELLS_UNPLACED]') && error.message.includes('retry landing'));
});
