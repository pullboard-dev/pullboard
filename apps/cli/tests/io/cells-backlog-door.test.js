/** @pullboard-test-input source-cell apps/cli packages/codemap */
/** @pullboard-world-pin: clause 1 reads the apps/cli and codemap sources themselves to prove no file imports the old backlog path [C7,#9465]. */
/** The cells audit backlog lives in apps/cli behind its door, and its importers use the door [C7,#9465]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cellsAuditBacklog } from '../../src/io/cells/backlog.js';
import { cellsBacklogCollector } from '../../src/io/cells/backlog.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OLD = 'packages/codemap/src/io/cells/backlog.js';

/** Every source file under a folder, skipping dependency folders. */
function sources(folder) {
  const found = [];
  for (const entry of readdirSync(join(ROOT, folder), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sources(path));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

test('clause 1: the cells audit backlog exists in the apps/cli cells folder, not at its old codemap path, and no file imports the old path [C7,#9465]', () => {
  assert.ok(existsSync(join(ROOT, 'apps/cli/src/io/cells/backlog.js')), 'the new home exists');
  assert.equal(typeof cellsBacklogCollector, 'function');
  assert.equal(typeof cellsAuditBacklog, 'function');
  assert.equal(existsSync(join(ROOT, OLD)), false, 'the old codemap path is gone');
  const importers = [...sources('apps/cli'), ...sources('packages/codemap')]
    .filter(file => /from '[^']*cells\/backlog\.js'/u.test(readFileSync(join(ROOT, file), 'utf8')));
  assert.deepEqual(importers.filter(file => readFileSync(join(ROOT, file), 'utf8').includes('codemap/src/io/cells/backlog.js')), [], 'nothing imports the old path');
  assert.ok(importers.includes('apps/cli/src/io/landing/audit.js'), 'the landing audit imports the new home');
  assert.doesNotMatch(readFileSync(join(ROOT, 'packages/codemap/index.js'), 'utf8'), /cellsBacklogCollector/u, 'codemap no longer exports the collector');
});
