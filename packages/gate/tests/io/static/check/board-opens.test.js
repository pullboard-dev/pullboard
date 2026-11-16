/** The file-board open ratchet runs in the always-run static registry, only when its setting is on, and costs nothing on an unrelated change [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_CHECKS } from '../../../../heavy.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';

const check = STATIC_CHECKS.find(entry => entry.name === 'board-file-opens');
const OPEN = "import { openBoard } from '../board.js';\nopenBoard('/tmp/x.db');\n";
const NAMED = "// @pullboard-board-file journey: proves the file lock\nopenBoard('/tmp/x.db');\n";

/** A temporary repository root whose pullboard.json holds `config`. */
function repo(t, config) {
  const fixture = privateFixtureFiles('board-opens-');
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fixture.write('pullboard.json', JSON.stringify({ gate: 'true', ...config }));
  return fixture.root;
}

/** Run the class on one changed path whose source is `source`. */
const run = (root, file, source) => check.run({ root, files: [file], read: () => ({ file, source }) });

test('clause 1: with the setting on, a new unannotated board open in a changed test is refused at the always-run static checks [C7]', t => {
  assert.ok(check, 'the always-run static registry lists board-file-opens');
  const root = repo(t, { ratchets: { boardOpens: true } });
  const found = run(root, 'packages/x/tests/new.test.js', OPEN);
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], /^packages\/x\/tests\/new\.test\.js:2: unclassified file board open/u);
  assert.deepEqual(run(root, 'packages/x/tests/new.test.js', NAMED), [], 'a named boundary is not debt');
});

test('clause 1: the setting defaults off, so no repo is refused until it opts in [C7]', t => {
  assert.deepEqual(run(repo(t, {}), 'packages/x/tests/new.test.js', OPEN), []);
  assert.deepEqual(run(repo(t, { ratchets: { boardOpens: false } }), 'packages/x/tests/new.test.js', OPEN), []);
});

test('clause 3: a change with no test file leaves the board-open check silent without reading anything [C7]', t => {
  const root = repo(t, { ratchets: { boardOpens: true } });
  const read = () => { throw new Error('no file may be read'); };
  assert.deepEqual(check.run({ root, files: ['packages/x/src/io/main.js', 'README.md'], read }), []);
});
