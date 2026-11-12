/** A file moved in the same change keeps its load-bearing ceiling; a raise is only a number above the old path's [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../../../apps/cli/tests/fixtures/testkit.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { LOAD_BEARING_CEILINGS } from '../../../index.js';
import { changedStaticFailures } from '../../../index.js';
import { loadBearingRaised } from '../../../index.js';

const OLD = 'apps/lib/src/shell/sender.js';
const MOVED = 'apps/cli/src/shell/sender.js';
const SENDER = [
  "import { spawn } from 'node:child_process';",
  "export function launch() {",
  "  const child = spawn('sh', ['-c', 'sleep 9'], { detached: true, stdio: 'ignore' });",
  '  child.unref();',
  '}',
  '',
].join('\n');

/** Run git in a project with a fixed identity. */
function git(scratch, ...args) {
  return runFixtureGit(['-C', scratch.root, ...args]);
}

/** A real repo whose main holds one sender with a ceiling of one detached child and one unref. */
function project() {
  const scratch = fixtureCommittedGraph('load-bearing-rename-');
  scratch.put(OLD, SENDER);
  scratch.put(LOAD_BEARING_CEILINGS, JSON.stringify({ [OLD]: { detached: 1, unref: 1 } }));
  scratch.commit();
  git(scratch, 'checkout', '-q', '-b', 'work');
  return scratch;
}

/** Stage a move of the sender with its ceilings and judge the index with the load-bearing check. */
function judgeMove(scratch, { source = SENDER, ceilings }) {
  git(scratch, 'rm', '-q', OLD);
  scratch.put(MOVED, source);
  scratch.put(LOAD_BEARING_CEILINGS, JSON.stringify(ceilings));
  git(scratch, 'add', '-A');
  return changedStaticFailures(scratch.root, [LOAD_BEARING_CEILINGS, MOVED], { staged: true, only: ['load-bearing'] });
}

test('a path moved in the same change inherits the old ceiling; a new path starts from zero [C7]', () => {
  const accepted = { [OLD]: { detached: 1, unref: 1 } };
  assert.deepEqual(loadBearingRaised(accepted, { [MOVED]: { detached: 1, unref: 1 } }), [{ path: MOVED, kind: 'detached', from: 0, to: 1 }, { path: MOVED, kind: 'unref', from: 0, to: 1 }]);
  assert.deepEqual(loadBearingRaised(accepted, { [MOVED]: { detached: 1, unref: 1 } }, { [MOVED]: OLD }), []);
  assert.deepEqual(loadBearingRaised(accepted, { [MOVED]: { detached: 2, unref: 1 } }, { [MOVED]: OLD }), [{ path: MOVED, kind: 'detached', from: 1, to: 2 }]);
  assert.equal(loadBearingRaised(accepted, { [OLD]: accepted[OLD], [MOVED]: { detached: 1 } }, { [MOVED]: OLD }).length, 1, 'a copied ceiling, with the old path still listed, is a raise');
});

test('a renamed file keeps its ceiling in the staged check [C7]', () => {
  const scratch = project();
  assert.deepEqual(judgeMove(scratch, { ceilings: { [MOVED]: { detached: 1, unref: 1 } } }), []);
});

test('a rename plus an increase is refused [C7]', () => {
  const scratch = project();
  const grown = judgeMove(scratch, { source: SENDER.replace('  child.unref();', '  child.unref();\n  child.unref();'), ceilings: { [MOVED]: { detached: 1, unref: 2 } } });
  assert.equal(grown.length, 1, grown.join('\n'));
  assert.match(grown[0], /load-bearing ceiling for apps\/cli\/src\/shell\/sender\.js unref rose from 1 to 2/u);
});

test('a new file that starts at one is refused [C7]', () => {
  const scratch = project();
  const fresh = 'apps/cli/src/shell/fresh.js';
  scratch.put(fresh, SENDER);
  scratch.put(LOAD_BEARING_CEILINGS, JSON.stringify({ [OLD]: { detached: 1, unref: 1 }, [fresh]: { detached: 1, unref: 1 } }));
  git(scratch, 'add', '-A');
  const refused = changedStaticFailures(scratch.root, [LOAD_BEARING_CEILINGS, fresh], { staged: true, only: ['load-bearing'] });
  assert.match(refused.join('\n'), /fresh\.js detached rose from 0 to 1/u);
});
