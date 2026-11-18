/** @pullboard-test-input source-cell packages/runners */
/** A child commit's history scan reads only the commits after its nearest scanned ancestor, and a cold one reads all [C7,#9858]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaults } from '../../../../config/index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { protectHistory } from '../../../index.js';

const HISTORY = 100;

/** A repository of 100 single-file commits, with an own machine home so no other run's verdicts are reused. */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-scan-delta-');
  const home = privateFixtureFiles('pullboard-scan-delta-home-');
  const root = files.root;
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home.root;
  t.after(() => {
    if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before;
    rmSync(root, { recursive: true, force: true });
    rmSync(home.root, { recursive: true, force: true });
  });
  const git = (...args) => {
    const options = typeof args.at(-1) === 'object' ? args.pop() : {};
    return runFixtureGit(args, { cwd: root, encoding: 'utf8', ...options });
  };
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  let started = false;
  let clock = 1_700_000_000;
  /**
   * Append single-file commits to main with one `git fast-import` child, returning their ids in order.
   * Why: a commit through add, commit and rev-parse cost three git processes each, and the file builds 100 commits per case.
   * The unpack limit keeps the objects loose, because poison drops one object file.
   */
  const importCommits = entries => {
    const marks = join(home.root, 'marks');
    const chunks = [];
    entries.forEach(([path, body], index) => {
      const message = path;
      chunks.push(`commit refs/heads/main\nmark :${index + 1}\ncommitter Fixture <fixture@example.invalid> ${clock += 1} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`);
      if (started || index > 0) chunks.push(index > 0 ? `from :${index}\n` : 'from refs/heads/main^0\n');
      chunks.push(`M 100644 inline ${path}\ndata ${Buffer.byteLength(body)}\n${body}\n`);
    });
    git('-c', 'fastimport.unpackLimit=1000000', 'fast-import', '--quiet', `--export-marks=${marks}`, { input: chunks.join('') });
    started = true;
    const ids = new Map(readFileSync(marks, 'utf8').trim().split('\n').map(line => line.split(' ').slice(0, 2)));
    return entries.map((_, index) => ids.get(`:${index + 1}`));
  };
  const addPath = (path, body) => importCommits([[path, body]])[0];
  const add = n => addPath(`src/file-${n}.txt`, `${n}\n`);
  const commits = importCommits(Array.from({ length: HISTORY }, (_, index) => [`src/file-${index}.txt`, `${index}\n`]));
  /** Make any history walk that reaches this commit fail, by dropping its tree object. */
  const poison = commit => {
    const tree = git('rev-parse', `${commit}^{tree}`);
    rmSync(join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  };
  return { root, commits, add, addPath, poison };
}

test('runners.scan-delta.after-one-scan-of-a-100: clause 1: after one scan of a 100-commit history, a child scans only the commits after it and gives a full scan\'s verdict [C7,#9858]', t => {
  const policies = [defaults().protect];
  const { root, commits, add, addPath, poison } = fixture(t);
  assert.equal(commits.length, HISTORY);
  protectHistory(root, { commit: commits[HISTORY - 1] }, policies);
  const child = add(HISTORY);
  poison(commits[0]);
  poison(commits[HISTORY / 2]);
  // The scanned ancestor's range starts after it: reaching the old, dropped commits would fail the walk.
  assert.doesNotThrow(() => protectHistory(root, { commit: child }, policies), 'only the child commit past the scanned ancestor is read');
  // The same child, with no scanned ancestor, walks the whole history and meets the dropped objects.
  assert.throws(() => protectHistory(root, { commit: child }, [{ ...defaults().protect, cold: true }]), { code: 'RUNNER_SOURCE' }, 'a full walk reaches the dropped commits');
  // The verdict matches a full scan: a clean history is clean either way, and a blocked path in the new range is refused.
  const blocked = addPath('data/board.sqlite', 'private\n');
  assert.throws(() => protectHistory(root, { commit: blocked }, policies), { code: 'RUNNER_SECRET' }, 'a blocked path past the ancestor is refused as a full scan refuses it');
});

test('runners.scan-delta.a-commit-with-no-scanned-ancestor: clause 2: a commit with no scanned ancestor is scanned in full as today [C7,#9858]', t => {
  const policies = [defaults().protect];
  const { root, commits, poison } = fixture(t);
  poison(commits[0]);
  assert.throws(() => protectHistory(root, { commit: commits[HISTORY - 1] }, policies), { code: 'RUNNER_SOURCE' }, 'with nothing scanned before it, the walk starts at the root');
});

test('runners.scan-delta.a-clean-100-commit-history-with: clause 2: a clean 100-commit history with no scanned ancestor passes as a full scan [C7,#9858]', t => {
  const { root, commits } = fixture(t);
  assert.doesNotThrow(() => protectHistory(root, { commit: commits[HISTORY - 1] }, [defaults().protect]));
});
