/** The pulled landing offer over one accepted item whose reviewed file main has since changed, on a real repository and board [C7,#3064]. */
// fixture-subject: addItem
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { closeBoard } from '../../../../../packages/store/index.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { offerPulledLanding } from '../../../src/io/landing/pull.js';
import { context } from '../../../src/io/read.js';
import { submitFixture } from '../board/submit.js';

/**
 * Accept one item whose head sits on `repo.base`, then offer a landing onto `repo.main`.
 * Why: the offer's freshness check is what a mechanical-only conflict must pass and a real one must not [C7].
 *
 * @param {object} t - The test context, for cleanup.
 * @param {{ root: string, base: string, main: string, head: string, file: string }} repo - A repository from conflict-repos.js.
 * @returns {Promise<{ result: object | null, said: string[], item: object }>} What the offer returned, what it said, and the item afterwards.
 */
export async function offerOverConflict(t, repo) {
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: repo.root, encoding: 'utf8' }).trim();
  mkdirSync(join(repo.root, '.git', 'pullboard'), { recursive: true });
  const boardFile = join(repo.root, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(boardFile);
  t.after(() => closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/source' });
  store.register(board, { lane: 'web', path: '/source/web' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Reviewed change' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head: repo.base, freeze: item => ({ text: item.item_title, digest: `digest:${item.item_title}` }) });
  const tree = git('rev-parse', `${repo.head}^{tree}`);
  submitFixture(board, id, { agentId: 'web-1', commit: repo.head, tree, files: [repo.file], gateGreen: true, policyCommit: repo.base });
  store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'accepted before main moved', head: repo.head, digest: 'digest:Reviewed change', policy: 'any',
    review: { commit: repo.head, head: repo.head, trunk: repo.base, paths: [repo.file] } });
  const said = [];
  const policy = { config: {}, commit: repo.main };
  const result = await offerPulledLanding(context({ cwd: repo.root, say: line => said.push(line) }), repo.root,
    { mainPolicy: () => policy, listItems: store.listItems, checkedLandingCommit: (_board, item) => item.item_commit, pairPrefix: () => 'prefix' },
    { local: async () => ({ running: true }), board });
  return { result, said, item: store.getItem(board, id) };
}
