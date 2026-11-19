/** The static import closure of the status command loads no more heavy startup modules than today's 10 [C7,#6480]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  relative,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const entry = resolve(root, 'apps/cli/src/io/commands/status.js');
const heavyPath = resolve(root, 'apps/cli/journeys/list/startup-heavy.json');

/** The heavy modules status is allowed to load today; later slices shrink this list, never grow it. */
const ALLOWED = [
  'packages/commits/src/io/hooks.js',
  'packages/gate/src/io/check/baseline.js',
  'packages/gate/src/io/run/shell.js',
  'packages/resources/index.js',
  'packages/sentinels/src/io/main.js',
  'packages/state/src/io/machine.js',
  'packages/store/index.js',
  'packages/store/src/io/board.js',
  'packages/store/src/io/board/event/log.js',
  'packages/store/src/logic/board/landing/lease.js',
];

const STATIC_IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/gu;

/** Resolve a relative specifier to a file, trying the path itself then its index.js. */
function resolveSpecifier(from, specifier) {
  const target = resolve(dirname(from), specifier);
  if (existsSync(target) && statSync(target).isFile()) return target;
  const index = resolve(target, 'index.js');
  return existsSync(index) ? index : null;
}

/** Every file reachable from the entry through static import and re-export statements (dynamic import() is not followed). */
function staticClosure(start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop();
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const next = resolveSpecifier(file, match[1]);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

const heavyInClosure = () => {
  const heavy = new Set(Object.values(JSON.parse(readFileSync(heavyPath, 'utf8'))).flat());
  return [...staticClosure(entry)].map((file) => relative(root, file)).filter((file) => heavy.has(file)).sort();
};

test('cli.io-commands-status-closure.the-allow-list-matches-the-11-recorded: clause 1: the allow-list matches the 10 recorded status heavy modules and every closure member is on it [C7,#6480]', () => {
  const recorded = JSON.parse(readFileSync(heavyPath, 'utf8')).status;
  assert.equal(ALLOWED.length, 10, 'the allow-list holds today\'s 10');
  assert.deepEqual([...ALLOWED].sort(), [...recorded].sort(), 'the allow-list names the same modules as startup-heavy.json');
  const extra = heavyInClosure().filter((file) => !ALLOWED.includes(file));
  assert.deepEqual(extra, [], `status now loads heavy modules beyond the allow-list: ${extra.join(', ')}`);
});

test('cli.io-commands-status-closure.a-twelfth-heavy-module-in-the-closure: clause 1: a twelfth heavy module in the closure would be caught [C7,#6480]', () => {
  const inClosure = heavyInClosure();
  assert.ok(inClosure.length > 0, 'the walker finds at least one heavy module, so an empty result cannot pass the check');
  assert.ok(inClosure.length <= ALLOWED.length, `closure holds ${inClosure.length} heavy modules, over ${ALLOWED.length}`);
  const withTwelfth = [...inClosure, 'packages/extra/index.js'].filter((file) => !ALLOWED.includes(file));
  assert.deepEqual(withTwelfth, ['packages/extra/index.js'], 'a module outside the list is reported');
});

/** The 5 board-read modules every board command needs; no other heavy module may stay in status's static closure [#7084]. */
const BOARD_READ = [
  'packages/state/src/io/machine.js',
  'packages/store/index.js',
  'packages/store/src/io/board.js',
  'packages/store/src/io/board/event/log.js',
  'packages/store/src/logic/board/landing/lease.js',
];

test('cli.io-commands-status-closure.status-reaches-no-heavy-module-beyond: clause 1: the static closure of status reaches no module of the startup-heavy status row beyond the 5 board-read modules [C7,#7084]', () => {
  const inClosure = heavyInClosure();
  const extra = inClosure.filter((file) => !BOARD_READ.includes(file));
  assert.deepEqual(extra, [], `status still reaches heavy modules beyond the board-read five: ${extra.join(', ')}`);
});
