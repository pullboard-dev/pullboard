/** @pullboard-test-input source-cell packages/verify */
/** With verify.hunkFreshness on, a verdict goes stale only when a hunk of the submit's own patch changed [C7,#9438]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryRepository } from '../../../../../store/tests/fixtures/submit.js';
import { composesUnchanged } from '../../../../src/io/verdict/freshness.js';

/** Run git in a directory and return trimmed output. */
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A real repository whose notes file has thirty numbered lines on main. */
function repo(t) {
  const dir = temporaryRepository(t, 'verdict-hunk-');
  const write = edit => writeFileSync(join(dir, 'notes.txt'), `${edit(Array.from({ length: 30 }, (_, index) => `line ${index}`)).join('\n')}\n`);
  write(lines => lines);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  /** Commit an edit on a new branch from the base and return its head, leaving main checked out. */
  const branch = (name, edit) => {
    git(dir, 'checkout', '-q', '-b', name, base);
    write(edit);
    git(dir, 'commit', '-q', '-am', name);
    const head = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    return head;
  };
  return { dir, base, branch, tip: () => git(dir, 'rev-parse', 'main') };
}

test('clause 1: with verify.hunkFreshness on, a verdict stays fresh when only hunks outside the submit\'s own patch changed and goes stale when an own hunk changed [C7,#9438]', t => {
  const far = repo(t);
  const checked = far.branch('item', lines => { lines[4] = 'item five'; return lines; });
  git(far.dir, 'merge', '-q', '--ff-only', far.branch('landed', lines => { lines.splice(25, 0, 'main added'); return lines; }));
  assert.equal(composesUnchanged(far.dir, { base: far.base, checked, tip: far.tip(), paths: ['notes.txt'] }, { hunkKeyed: true }), true, 'a far hunk and shifted line numbers leave the own patch whole');

  const clash = repo(t);
  const clashed = clash.branch('item', lines => { lines[4] = 'item five'; return lines; });
  git(clash.dir, 'merge', '-q', '--ff-only', clash.branch('landed', lines => { lines[4] = 'main five'; return lines; }));
  assert.equal(composesUnchanged(clash.dir, { base: clash.base, checked: clashed, tip: clash.tip(), paths: ['notes.txt'] }, { hunkKeyed: true }), false, 'an edit to the own hunk is stale');

  const taken = repo(t);
  const both = taken.branch('item', lines => { lines[4] = 'item five'; lines[20] = 'item twenty-one'; return lines; });
  git(taken.dir, 'merge', '-q', '--ff-only', taken.branch('landed', lines => { lines[20] = 'item twenty-one'; return lines; }));
  assert.equal(composesUnchanged(taken.dir, { base: taken.base, checked: both, tip: taken.tip(), paths: ['notes.txt'] }, { hunkKeyed: true }), false, 'a removed own hunk is stale');
});

test('clause 2: with the setting off the whole-patch comparison runs as before and gives the same answers on the same histories [C7,#9438]', t => {
  const far = repo(t);
  const checked = far.branch('item', lines => { lines[4] = 'item five'; return lines; });
  git(far.dir, 'merge', '-q', '--ff-only', far.branch('landed', lines => { lines.splice(25, 0, 'main added'); return lines; }));
  const input = { base: far.base, checked, tip: far.tip(), paths: ['notes.txt'] };
  assert.equal(composesUnchanged(far.dir, input, { hunkKeyed: false }), true);
  assert.equal(composesUnchanged(far.dir, input), composesUnchanged(far.dir, input, { hunkKeyed: false }), 'the default is off');
});
