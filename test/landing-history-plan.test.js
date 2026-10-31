/** A new numbered move-history file is placed as an engine stay, never into the state cell [C7,D3,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { placeLandingHistory } from '../src/landing-history-plan.js';

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
