/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-world-pin clause 1 reads the stats command source to prove it names no history file literal [C7]. */
/** The stats command reaches the history file through statsHistoryFile, the path appendTimeCheckpoint writes [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { statsHistoryFile } from '../../../../../packages/stats/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const source = readFileSync(new URL('../../../src/io/commands/stats.js', import.meta.url), 'utf8');

test('cli.io-commands-stats-history-path.the-stats-command-builds-the-history-path: clause 1: the stats command builds the history path through statsHistoryFile and names stats-history.jsonl nowhere [C7]', () => {
  assert.match(source, /statsHistoryFile\(ctx\.info\.commonDir\)/u);
  assert.doesNotMatch(source, /stats-history\.jsonl/u);
  assert.doesNotMatch(source, /STATS_HISTORY_FILE/u);
});

test('cli.io-commands-stats-history-path.stats-time-checkpoint-release-writes-the-file: clause 2: stats time --checkpoint release writes the file statsHistoryFile names [C7]', async () => {
  const box = e2e.project();
  const common = (box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
  const file = statsHistoryFile(common);
  assert.equal(existsSync(file), false, 'no history before the checkpoint');
  const result = await box.runLocal(box.repo, 'stats', 'time', '--checkpoint', 'release', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  assert.equal(existsSync(file), true, 'the checkpoint landed at the shared path');
  assert.equal(JSON.parse(result.out).checkpoint, file);
});
