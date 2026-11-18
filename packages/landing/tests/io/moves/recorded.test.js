/** Landing refuses a candidate that renames a tracked file with no path-map entry, and lands it once the entry is added [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { requireRecordedMoves } from '../../../src/io/guards.js';

const BODY = Array.from({ length: 40 }, (_, line) => `export const row${line} = ${line};`).join('\n') + '\n';

/** Run real Git in a fixture repository. */
function sh(root, ...args) { return runFixtureGit(args, { cwd: root }); }

/** A repository whose main tracks one file, and a candidate branch that renames it. */
function fixture() {
  const { root } = privateFixtureFiles('landing-recorded-moves-');
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@example.com');
  sh(root, 'config', 'user.name', 't');
  put('src/old-name.js', BODY);
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'main');
  const base = sh(root, 'rev-parse', 'HEAD');
  sh(root, 'switch', '-q', '-c', 'candidate');
  mkdirSync(join(root, 'packages/config/src'), { recursive: true });
  sh(root, 'mv', 'src/old-name.js', 'packages/config/src/new-name.js');
  sh(root, 'commit', '-qm', 'rename');
  return { root, base, put, rename: sh(root, 'rev-parse', 'HEAD') };
}

test('landing.recorded.a-rename-of-a-tracked-file: a rename of a tracked file with no path-map entry is refused, naming the file and the shard to add [C7]', () => {
  const box = fixture();
  assert.throws(() => requireRecordedMoves(box.root, box.base, box.rename),
    error => error.code === 'LAND_MOVE_UNRECORDED' && error.message.includes('src/old-name.js -> packages/config/src/new-name.js')
      && error.message.includes('packages/codemap/data/plan/path-map/config.json'));
});

test('landing.recorded.the-same-rename-lands-once-a: the same rename lands once a path-map shard records old to new [C7]', () => {
  const box = fixture();
  box.put('packages/codemap/data/plan/path-map/config.json', JSON.stringify({ 'src/old-name.js': 'packages/config/src/new-name.js' }) + '\n');
  sh(box.root, 'add', '.');
  sh(box.root, 'commit', '-qm', 'record the move');
  assert.doesNotThrow(() => requireRecordedMoves(box.root, box.base, sh(box.root, 'rev-parse', 'HEAD')));
});

test('landing.recorded.a-candidate-with-no-rename-or: a candidate with no rename, or whose rename main already made, is not refused [C7]', () => {
  const box = fixture();
  assert.doesNotThrow(() => requireRecordedMoves(box.root, box.base, box.base));
  assert.doesNotThrow(() => requireRecordedMoves(box.root, box.rename, box.rename));
});
