/** The batched landing offer fixture: a real repository and board where items are accepted one at a time and each accept calls the offer [C7,S8]. */
// fixture-subject: addItem
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { closeBoard } from '../../../../../packages/store/index.js';
import * as store from '../../../../../packages/store/index.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { openBoard } from '../../../../lib/index.js';
import { offerPulledLanding } from '../../../src/io/landing/pull.js';
import { repositoryBoardFile } from '../board/submit.js';
import { submitFixture } from '../board/submit.js';
import { temporaryDirectory } from '../board.js';

/**
 * A real repository with one branch per entry of `files` (the item's changed files), a board with the given line settings,
 * and accept(number) that submits and accepts that item, then offers landing as the accept path does.
 * Returns { accept, settle, jobs }: settle(number) closes the open land job and records the item as merged.
 */
export function batchOffer(t, { files, line = {} }) {
  const directory = temporaryDirectory('pullboard-batch-offer-');
  const home = temporaryDirectory('pullboard-batch-offer-home-');
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
  const commits = {};
  files.forEach((names, index) => {
    const number = index + 1;
    git('checkout', '-q', '-b', `item-${number}`, main);
    for (const name of names) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), `${name} ${number}\n`);
    }
    git('add', '-A');
    git('commit', '-q', '-m', `feat: item ${number}`);
    commits[number] = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
  });
  store.register(board, { lane: 'coordinator', path: '/source' });
  process.env.PULLBOARD_MACHINE_HOME = home;
  fixtureMachineSettings(home, { landing: {} });
  for (const [name, value] of Object.entries(line)) store.setLineSetting(board, { agentId: 'coordinator', key: name, value, reason: 'the batch offer fixture sets its line', window: { windowMinutes: null } });
  const policy = { config: { flakes: { rerun: true } }, commit: main };
  const ids = {};
  const offer = () => offerPulledLanding({ io: { say() {} }, file: boardFile }, directory,
    { mainPolicy: () => policy, listItems: store.listItems, checkedLandingCommit: (_board, item) => item.item_commit, pairPrefix: () => 'prefix' },
    { local: async () => ({ running: true }), board });
  const accept = async number => {
    store.register(board, { lane: 'web', path: `/source/web-${number}` });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `batch offer ${number}` });
    ids[number] = id;
    store.claim(board, id, { agentId: `web-${number}`, lane: 'web', leaseMs: 3_600_000, head: main, freeze: item => ({ text: item.item_title, digest: `digest:${item.item_title}` }) });
    submitFixture(board, id, { agentId: `web-${number}`, commit: commits[number], tree: git('rev-parse', `${commits[number]}^{tree}`) });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'accepted for the batch offer test', head: commits[number], digest: `digest:batch offer ${number}`, policy: 'any' });
    return offer();
  };
  // The runner's receipt closes its job and merges its items; trunk itself stays put, so the next offer reads the same base.
  const settle = numbers => {
    board.db.prepare("UPDATE job SET job_step = 'done' WHERE job_kind = 'land'").run();
    for (const number of numbers) board.db.prepare('UPDATE item SET item_merged_commit = ? WHERE item_id = ?').run(commits[number], ids[number]);
  };
  const jobs = () => board.db.prepare("SELECT job_id FROM job WHERE job_kind = 'land' ORDER BY job_created, job_id").all().map(job => {
    const offered = board.db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job.job_id);
    return JSON.parse(offered.payload).payload.items.map(entry => Object.keys(ids).find(number => ids[number] === entry.id));
  });
  return { accept, offer, settle, jobs, ids };
}
