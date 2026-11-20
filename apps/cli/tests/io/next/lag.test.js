/** A seat whose worktree is behind main is told once per command, in one line [N2,B3]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { lagLine } from '../../../src/io/lag.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { policyRepository } from '../../../../../packages/store/tests/fixtures/submit.js';
import { main } from '../../fixtures/native.js';
import { fixture } from '../../fixtures/next/take.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];

/** Run the real command parser in plain text mode, since the lag line is a text line that --json mode does not print. */
async function cli(box, cwd, args) {
  let out = '', err = '';
  const code = await main(args, { cwd, clock: box.clock, stdout: { isTTY: false, write: part => { out += part; } }, stderr: { write: part => { err += part; } } });
  return { code, out, err };
}

/** Land `count` commits on the fixture's main, so a seat checkout cut earlier falls behind. */
function landOnMain(box, count) {
  for (let n = 1; n <= count; n += 1) {
    writeFileSync(join(box.root, `web/landed-${n}.txt`), `landed ${n}\n`);
    box.git(box.root, 'add', `web/landed-${n}.txt`);
    box.git(box.root, 'commit', '-q', '-m', `chore(web): landing ${n} [G1]`);
  }
}

test('cli.io-next-lag.cli-next-lag-next-claim-and-inbox: cli.next.lag.next-claim-and-inbox-print-one: clause 1: next, claim and inbox print one line naming the commits behind and the base age when the seat is behind main [N2,B3]', async t => {
  const box = await fixture(t, { files: { 'web/shared.txt': 'base\n' } });
  const id = box.add('Work a lagging seat claims');
  const seat = box.seats.actor.path;

  landOnMain(box, 3);
  const lag = /this checkout is 3 commits behind main, its base is \d+ (min|h|days) old/u;
  for (const args of [['inbox'], ['claim', String(id)]]) {
    const result = await cli(box, seat, args);
    const text = result.out + result.err;
    assert.match(text, lag, `${args[0]} names the lag: ${text}`);
    assert.equal(text.match(/commits behind/gu).length, 1, `${args[0]} prints the lag once`);
  }
});

test('cli.io-next-lag.item-folder-silent: clause 2: a next that hands out an item in its own item folder prints no lag line for the seat checkout, and a next that hands out nothing still prints it [C7,U159]', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const file = join(box.dir, 'machine-home', 'settings.json');
  mkdirSync(join(box.dir, 'machine-home'), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false } }));
  for (let n = 1; n <= 3; n += 1) {
    writeFileSync(join(box.repo, `landed-${n}.txt`), `landed ${n}\n`);
    box.git(box.repo, 'add', `landed-${n}.txt`);
    box.git(box.repo, 'commit', '-q', '-m', `chore(web): landing ${n} [G1]`);
  }
  const quiet = await box.runLocal(box.web, 'next');
  assert.match(quiet.out + quiet.err, /this checkout is 3 commits behind main/u, 'a next that hands out no item names the lag');
  await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  const handed = await box.runLocal(box.web, "next");
  const text = handed.out + handed.err;
  assert.match(text, /^item folder: /mu, `next hands out an item folder: ${text}`);
  assert.doesNotMatch(text, /behind/u, 'a next that hands out an item folder prints no lag line');
});

test('cli.io-next-lag.cli-next-lag-a-seat-level-with: cli.next.lag.a-seat-level-with-main-prints: clause 2: a seat level with main prints no lag line [N2,B3]', async t => {
  const box = await fixture(t, { files: { 'web/shared.txt': 'base\n' } });
  box.add('Work a level seat claims');
  const seat = box.seats.actor.path;
  for (const args of [['inbox'], ['next', '--take']]) {
    const level = await cli(box, seat, args);
    assert.equal(level.code, 0, level.out + level.err);
    assert.doesNotMatch(level.out + level.err, /behind/u, `${args[0]} on a level seat prints no lag line`);
  }
});

/** Run `work` while every git child this process starts is noted; the number of git launches comes back with the result. */
function countingGit(work) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  let launches = 0;
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      const command = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '';
      if (command.endsWith('git')) launches++;
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try { return { launches, result: work() }; } finally {
    for (const api of APIS) childProcess[api] = real[api];
    syncBuiltinESMExports();
  }
}

/** A repository on main with a seat that is a detached linked worktree of its tip; `land` adds commits to main after the seat was cut. */
function seatedRepository(t) {
  const root = privateFixtureFiles('pullboard-lag-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, 'primary');
  mkdirSync(primary);
  policyRepository(primary);
  const seat = join(root, 'seat');
  runFixtureGit(['worktree', 'add', '-q', '--detach', seat, 'main'], { cwd: primary });
  const land = count => {
    for (let n = 1; n <= count; n += 1) {
      writeFileSync(join(primary, `landed-${n}.txt`), `landed ${n}\n`);
      runFixtureGit(['add', '.'], { cwd: primary });
      runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', `chore: landing ${n}`], { cwd: primary });
    }
  };
  return { primary, seat, land };
}

test('cli.io-next-lag.level-checkout-launches-no-git: clause 1: lagLine for a checkout whose HEAD equals the trunk tip returns null and launches no git process, with trunk loose and packed [C7,#5329]', t => {
  const { primary, seat } = seatedRepository(t);
  const level = countingGit(() => lagLine(seat, Date.now()));
  assert.equal(level.result, null);
  assert.equal(level.launches, 0, `a level checkout with a loose trunk launched ${level.launches} git processes`);
  runFixtureGit(['pack-refs', '--all'], { cwd: primary });
  const packed = countingGit(() => lagLine(seat, Date.now()));
  assert.equal(packed.result, null);
  assert.equal(packed.launches, 0, `a level checkout with a packed trunk launched ${packed.launches} git processes`);
});

test('cli.io-next-lag.no-merge-instruction: clause 1: lagLine for a checkout behind main names the commits behind and the base age and says submit composes current main; the words merge main before you build are gone [C7,U159]', t => {
  const { seat, land } = seatedRepository(t);
  const base = runFixtureGit(['show', '-s', '--format=%ct', 'HEAD'], { cwd: seat });
  land(2);
  const line = lagLine(seat, (Number(base) + 3 * 3600) * 1000);
  assert.equal(line, 'this checkout is 2 commits behind main, its base is 3 h old; submit composes current main');
  assert.doesNotMatch(line, /merge main before you build/u);
});

test('cli.io-next-lag.three-behind-same-line: clause 2: a checkout 3 commits behind main prints the line git\'s own count and base age give [C7,#5329]', t => {
  const { primary, seat, land } = seatedRepository(t);
  const base = runFixtureGit(['show', '-s', '--format=%ct', 'HEAD'], { cwd: seat });
  land(3);
  assert.equal(runFixtureGit(['rev-list', '--count', 'HEAD..main'], { cwd: seat }), '3');
  const line = lagLine(seat, (Number(base) + 5 * 60) * 1000);
  assert.equal(line, 'this checkout is 3 commits behind main, its base is 5 min old; submit composes current main');
  runFixtureGit(['pack-refs', '--all'], { cwd: primary });
  assert.equal(lagLine(seat, (Number(base) + 5 * 60) * 1000), line, 'a packed trunk reads the same');
});
