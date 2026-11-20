/** The landing offer fixture: a real repository, board and git-start log for offerPulledLanding tests [C7,#11105]. */
// fixture-subject: addItem
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import * as store from '../../../../../packages/store/index.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { realGitAdapter } from '../../../../../packages/git/index.js';
import { withGitContractAdapter } from '../../../../../packages/git/index.js';
import { openBoard } from '../../../../lib/index.js';
import { landingItemRef } from '../../../src/io/landing/pull.js';
import { offerPulledLanding } from '../../../src/io/landing/pull.js';
import { underBoardWriteLock } from '../../../src/io/landing/pull.js';
import { repositoryBoardFile } from '../board/submit.js';
import { submitFixture } from '../board/submit.js';
import { temporaryDirectory } from '../board.js';

/**
 * A real repository with trunk and two accepted items (#1 adds a.js and tests/a.test.js, #2 adds b.js and tests/b.test.js, so they are disjoint),
 * a git adapter wrapper that logs each git start, and the offer's logged lock seam. Returns what the offer did.
 */
export async function offerWithLog(t, { concurrentOffer = false } = {}) {
  const directory = temporaryDirectory('pullboard-offer-outside-');
  const home = temporaryDirectory('pullboard-offer-outside-home-');
  const savedHome = process.env.PULLBOARD_MACHINE_HOME;
  t.after(() => {
    if (savedHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = savedHome;
    rmSync(directory, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const boardFile = repositoryBoardFile(directory);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: directory, encoding: 'utf8' }).trim();
  const main = git('rev-parse', 'HEAD');
  const board = openBoard(boardFile);
  t.after(() => closeBoard(board));
  const FREEZE = item => ({ text: item.item_title, digest: `digest:${item.item_title}` });
  const commits = {};
  for (const [number, name] of [[1, 'a'], [2, 'b']]) {
    git('checkout', '-q', '-b', `item-${number}`, main);
    mkdirSync(join(directory, 'tests'), { recursive: true });
    writeFileSync(join(directory, `${name}.js`), `export const ${name} = ${number};\n`);
    writeFileSync(join(directory, 'tests', `${name}.test.js`), `// ${name}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `feat: item ${number}`);
    commits[number] = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
  }
  store.register(board, { lane: 'coordinator', path: '/source' });
  for (const number of [1, 2]) {
    store.register(board, { lane: 'web', path: `/source/web-${number}` });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `offer outside lock ${number}` });
    store.claim(board, id, { agentId: `web-${number}`, lane: 'web', leaseMs: 3_600_000, head: main, freeze: FREEZE });
    submitFixture(board, id, { agentId: `web-${number}`, commit: commits[number], tree: git('rev-parse', `${commits[number]}^{tree}`) });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'accepted for the offer test', head: commits[number], digest: `digest:offer outside lock ${number}`, policy: 'any' });
  }
  // The offer reads machine settings from this private home: parallel gates on, so each entry's changed files are read.
  process.env.PULLBOARD_MACHINE_HOME = home;
  fixtureMachineSettings(home, { landing: { parallelGates: true } });
  // The git adapter seam logs each git start (the real adapter spawns an absolute binary, so a PATH shim sees nothing); the lock seam logs where the lock is held, so the log orders git against the lock.
  const log = join(home, 'git-and-lock.log');
  const mark = line => appendFileSync(log, `${line}\n`);
  const lock = (target, work) => {
    mark('LOCK_ENTER');
    try {
      // A concurrent accept offered #2 first: its job is on the board by the time this offer holds the lock.
      if (concurrentOffer) offerLandingJob(target.db, { items: [{ id: 2, commit: commits[2], ref: landingItemRef(2) }], expect: main, config: { trunk: { remote: directory } }, trunk: 'refs/heads/main' });
      return underBoardWriteLock(target, work);
    } finally { mark('LOCK_EXIT'); }
  };
  const policy = { config: { flakes: { rerun: true } }, commit: main };
  const logged = { spawnSync: (args, options) => { mark(`git ${args[0]}`); return realGitAdapter.spawnSync(args, options); },
    execFileSync: (args, options) => { mark(`git ${args[0]}`); return realGitAdapter.execFileSync(args, options); },
    spawn: (args, options) => { mark(`git ${args[0]}`); return realGitAdapter.spawn(args, options); } };
  const result = await withGitContractAdapter(logged, () => offerPulledLanding({ io: { say() {} }, file: boardFile }, directory,
    { mainPolicy: () => policy, listItems: store.listItems, checkedLandingCommit: (_board, item) => item.item_commit, pairPrefix: () => 'prefix' },
    { local: async () => ({ running: true }), board, lock }));
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  const jobs = board.db.prepare("SELECT job_id, job_created FROM job WHERE job_kind = 'land' ORDER BY job_created, job_id").all().map(job => {
    const offered = board.db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job.job_id);
    return JSON.parse(offered.payload).payload;
  });
  return { result, lines, jobs };
}

