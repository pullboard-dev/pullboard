/** @pullboard-test-input source-cell landing */
/** With landing.asyncFetch on, a land job's git fetches run without blocking the event loop; off, they run as today [C7,#9516]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runLandingJob } from '../../../index.js';

const ITEM = 53;

/** A bare trunk remote holding main and one accepted item commit, plus a git on PATH whose item fetch takes 3 s. */
function landFixture(t) {
  const files = privateFixtureFiles('pullboard-async-fetch-');
  const dir = files.root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { root: work, put } = fixture(t);
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  git(work, 'checkout', '-q', '-b', 'item');
  put('item.txt', 'item\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'feat: item [C7]');
  const commit = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'push', '-q', remote, 'main:refs/heads/main', `item:refs/heads/item-${ITEM}`);
  const payload = { remote, trunk: 'refs/heads/main', expect: git(dir, '--git-dir', remote, 'rev-parse', 'refs/heads/main').trim(), publish: 'separate',
    items: [{ id: ITEM, commit, ref: `refs/heads/item-${ITEM}` }] };
  const real = process.env.PATH.split(delimiter).map(folder => join(folder, 'git')).find(path => existsSync(path));
  files.write('bin/git', `#!/bin/sh\ncase "$*" in *fetch*refs/pullboard/landing/item/*) echo slow >> "${dir}/slow.log"; sleep 3;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(dir, 'bin/git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = join(dir, 'bin') + delimiter + path;
  t.after(() => { process.env.PATH = path; });
  return { payload, workdir: join(dir, 'runner'), slowLog: join(dir, 'slow.log') };
}

/** Run the job beside a loop that yields to the event loop, and report the longest time the loop went without a turn. */
async function landTiming(t, asyncFetch) {
  const box = landFixture(t);
  let gap = 0, running = true;
  const watch = (async () => {
    let last = Date.now();
    while (running) { await new Promise(resolve => setImmediate(resolve)); gap = Math.max(gap, Date.now() - last); last = Date.now(); }
  })();
  try {
    const receipt = await runLandingJob(box.payload, { workdir: box.workdir, checks: () => ({ ok: true }), asyncFetch });
    return { receipt, gap, slow: existsSync(box.slowLog) };
  } finally { running = false; await watch; }
}

test('landing.async-fetch.with-landing-asyncfetch-on-the-event: clause 1: with landing.asyncFetch on, the event loop takes a turn at least every 500 ms through a 3 s fetch [C7,#9516]', async t => {
  const { receipt, gap, slow } = await landTiming(t, true);
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.equal(slow, true, 'the slow fetch ran');
  assert.ok(gap < 500, `the event loop went ${gap} ms without a turn`);
});

test('landing.async-fetch.with-the-setting-off-the-fetches: clause 2: with the setting off the fetches block the event loop as today [C7,#9516]', async t => {
  const { receipt, slow } = await landTiming(t, false);
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.equal(slow, true, 'the same slow fetch ran, synchronously');
});
