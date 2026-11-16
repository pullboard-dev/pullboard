/** @pullboard-test-input source-cell apps/cli packages/kernel packages/store packages/state packages/queue packages/seats packages/items packages/spec packages/git packages/verify packages/merge packages/config packages/stats packages/resources packages/transport packages/jobs packages/sandbox packages/doctrine packages/codemap packages/commits packages/person packages/roadmap */
/**
 * The local helpers pullboard status imports (alive, reclaim, disk use) reach no heavy module through their own imports: package names come through light doors,
 * and the one audited exception is the state machine the light store door already reaches [C7,#8649].
 * Why a static walk: the modules a helper loads are the ones its import statements reach, so no process is launched.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const HELPERS = ['apps/cli/src/io/alive.js', 'apps/cli/src/io/reclaim.js', 'apps/cli/src/io/disk/use.js'];
/** Modules a status helper must never load: everything startup-heavy.json audits for a read, bar the state machine the store light door reaches. */
const HEAVY = ['packages/commits/src/io/hooks.js', 'packages/gate/src/io/check/baseline.js', 'packages/gate/src/io/run/shell.js', 'packages/resources/index.js',
  'packages/sandbox/src/io/trusted/policy.js', 'packages/sentinels/src/io/main.js', 'packages/store/index.js', 'packages/store/src/io/board.js',
  'packages/store/src/io/board/event/log.js', 'packages/store/src/logic/board/landing/lease.js'];
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"`;]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gmu;

/** Every repository module a file reaches through static import and re-export statements, as repository-relative paths. */
function staticClosure(entry) {
  const seen = new Set();
  const stack = [resolve(REPO, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) stack.push(resolve(dirname(file), match[1] ?? match[2]));
  }
  return [...seen].map(file => file.slice(REPO.length + 1));
}

test('clause 1: alive, reclaim and disk use load no heavy module through their static imports [C7]', () => {
  for (const helper of HELPERS) {
    const modules = staticClosure(helper);
    assert.ok(modules.length > 5, `${helper} walked ${modules.length} modules`);
    assert.deepEqual(modules.filter(path => HEAVY.includes(path)), [], `${helper} reaches a heavy module`);
  }
});

test('clause 1: the helpers import drive, gate and store only through their light doors [C7]', () => {
  for (const helper of HELPERS) {
    const source = readFileSync(resolve(REPO, helper), 'utf8');
    const barrels = [...source.matchAll(/^import\s[^;]*?from\s*'([^']*packages\/(?:drive|gate|store)\/[^']*)'/gmu)].map(match => match[1]);
    assert.deepEqual(barrels.filter(path => !path.endsWith('/light.js')), [], `${helper} imports a barrel statically`);
  }
});
