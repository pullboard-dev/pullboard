/** @pullboard-test-input source-cell packages/spec */
/** Row origins are blamed once per main tip, HEAD and spec file, then reused by later processes [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../../gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../gate/tests/fixtures/testkit.js';

const APPROVAL = pathToFileURL(join(import.meta.dirname, '../../src/io/approval.js')).href;
let processes = 0;

/** A real repository with a committed two-line spec, plus a reader that acts as a fresh process and reports whether it ran git blame. */
function specRepo(t) {
  const repo = fixtureCommittedGraph('pullboard-spec-origins-');
  const traces = privateFixtureFiles('pullboard-spec-origins-trace-').root;
  t.after(() => { rmSync(repo.root, { recursive: true, force: true }); rmSync(traces, { recursive: true, force: true }); });
  const trace = join(traces, 'trace.log');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const git = (...args) => runFixtureGit(args, { cwd: repo.root, env, encoding: 'utf8', stdio: 'pipe' });
  repo.put('rows.md', 'one\ntwo\n');
  repo.commit();
  /** Load a new copy of the module, so its in-process cache is empty as in a new command process; the trace names every Git command launched. */
  const read = async () => {
    rmSync(trace, { force: true });
    processes += 1;
    const { rowOrigins } = await import(`${APPROVAL}?process=${processes}`);
    const before = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    let origins;
    try { origins = [...rowOrigins(repo.root, 'rows.md', [1, 2])]; }
    finally { if (before === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = before; }
    const launched = existsSync(trace) ? readFileSync(trace, 'utf8') : '';
    return { origins, blamed: /\bgit blame\b|\bblame --line-porcelain\b/u.test(launched) };
  };
  return { ...repo, git, read };
}

test('spec.io-approval.repeat-read-no-blame: clause 1: [C7] a second process at the same main tip and HEAD runs no git blame and returns the same origins', async (t) => {
  const { read } = specRepo(t);
  const first = await read();
  assert.equal(first.blamed, true, 'the first process blames the rows');
  assert.equal(first.origins.length, 2);
  const second = await read();
  assert.equal(second.blamed, false, 'the second process reuses the first one\'s origins');
  assert.deepEqual(second.origins, first.origins);
});

test('spec.io-approval.tip-moves-reblames: clause 2: [C7] a moved main or HEAD, an edited spec file or a new .mailmap makes the next read run git blame again', async (t) => {
  const { put, commit, git, read } = specRepo(t);
  await read();
  assert.equal((await read()).blamed, false, 'control: unchanged inputs hit the cache');
  put('rows.md', 'one\ntwo\nthree\n');
  commit();
  assert.equal((await read()).blamed, true, 'main and HEAD moved');
  assert.equal((await read()).blamed, false, 'control: the new tip is cached');
  git('switch', '-q', '-c', 'side');
  git('commit', '-q', '--allow-empty', '-m', 'head moves alone');
  assert.equal((await read()).blamed, true, 'HEAD moved while main stayed');
  assert.equal((await read()).blamed, false, 'control: the new HEAD is cached');
  put('rows.md', 'one\ntwo\nthree\nfour\n');
  assert.equal((await read()).blamed, true, 'the spec file changed');
  assert.equal((await read()).blamed, false, 'control: the edited file is cached');
  put('.mailmap', 'Other Name <agent@example.com>\n');
  assert.equal((await read()).blamed, true, 'the .mailmap appeared');
});
