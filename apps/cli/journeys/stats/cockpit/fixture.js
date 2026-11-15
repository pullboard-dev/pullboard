/** Shared setup for the split stats cockpit journeys [N26]. */
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { join } from 'node:path';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { accept } from '../../../tests/fixtures/cockpit/harness.js';
import { earlier } from '../../../tests/fixtures/cockpit/harness.js';

/** Add a real joined worktree to the shared test board.
 * @param {ReturnType<typeof machine>} box
 * @param {{ repo: string }} p
 * @param {string} name
 * @returns {string}
 */
export function joinedAgent(box, p, name) {
  const web = join(box.dir, `${name}-web`);
  box.git(p.repo, 'worktree', 'add', '-q', web, '-b', `web/${name}`);
  box.run(web, 'join', 'web');
  return web;
}

/** Leave twenty real accepted items waiting long enough to exercise a long API recommendation. */
export function stageAcceptedQueue(box, alpha, store) {
  const base = Date.now() - 120 * 60_000;
  const commit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}');
  const digest = 'a'.repeat(64);
  for (let id = 6; id <= 26; id += 1) {
    earlier(alpha.repo, base, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Waiting accepted item ' + id, specIds: ['G1'], criterion: 'Known accepted queue' }));
    earlier(alpha.repo, base + 60_000, board => store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 24 * 60 * 60_000, head: commit, freeze: () => ({ text: '{}', digest }) }));
    earlier(alpha.repo, base + 2 * 60_000, board => submitFixture(board, id, { agentId: 'web-1', commit, tree }));
    earlier(alpha.repo, base + 3 * 60_000, board => store.reserveReview(board, id, { agentId: 'tests-1', leaseMs: 24 * 60 * 60_000, policy: 'any' }));
    earlier(alpha.repo, base + 4 * 60_000, board => store.verify(board, id, { agentId: 'tests-1', decision: 'ACCEPT', note: 'Private accepted queue', head: commit, digest, policy: 'any' }));
    if (id === 26) earlier(alpha.repo, base + 104 * 60_000, board => store.merged(board, id, { agentId: 'coordinator', commit }));
  }
}

/** Stage a fully measured cycle and every live queue through native writers on a private clock. */
export function stageFlowBoard(box, alpha, store) {
  const base = Date.now() - 120 * 60_000;
  const commit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}');
  const digest = 'a'.repeat(64);
  /** Apply one native move at a known minute offset in this fixture's private board. */
  const at = (minute, write) => earlier(alpha.repo, base + minute * 60_000, write);
  for (const n of [2, 3]) box.git(alpha.repo, 'worktree', 'add', '-q', join(box.dir, 'flow-builder-' + n), '-b', 'web/flow-builder-' + n);
  at(0, board => store.register(board, { lane: 'tests', path: join(box.dir, 'flow-reviewer') }));
  for (const n of [2, 3]) at(0, board => store.register(board, { lane: 'web', path: join(box.dir, 'flow-builder-' + n) }));
  at(0, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Flow item 1', specIds: ['G1'], criterion: 'Known flow' }));
  /** Assign live queues to distinct private builders so every claim remains valid. */
  const builder = id => id === 5 ? 'web-2' : id === 3 ? 'web-3' : 'web-1';
  /** Claim one item with a private frozen criterion and a lease that outlasts the observation. */
  const claim = (id, minute) => at(minute, board => store.claim(board, id, { agentId: builder(id), lane: 'web', leaseMs: 24 * 60 * 60_000, head: commit, freeze: () => ({ text: '{}', digest }) }));
  /** Record the submitted fixture commit through the actual lifecycle writer. */
  const submit = (id, minute) => at(minute, board => submitFixture(board, id, { agentId: builder(id), commit, tree }));
  /** Reserve and accept with the private verifier so the review interval is measured. */
  const review = (id, start, end) => {
    at(start, board => store.reserveReview(board, id, { agentId: 'tests-1', leaseMs: 24 * 60 * 60_000, policy: 'any' }));
    at(end, board => store.verify(board, id, { agentId: 'tests-1', decision: 'ACCEPT', note: 'Private timed fixture', head: commit, digest, policy: 'any' }));
  };
  claim(1, 10); submit(1, 30); review(1, 70, 80);
  at(90, board => store.merged(board, 1, { agentId: 'coordinator', commit }));
  for (const id of [2, 3, 4, 5]) at(100, board => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Flow item ' + id, specIds: ['G1'], criterion: 'Known flow' }));
  claim(3, 110); claim(4, 110); claim(5, 110);
  submit(4, 115); submit(5, 115); review(5, 117, 119);
  // One recent shout gives the Shouts feed a run of rows to name Today, which the unchanged-refresh criterion renames at midnight.
  at(119, board => store.shout(board, { from: 'web-1', to: 'all', text: 'Flow fixture is live.', lanes: ['web'] }));
  for (const n of [2, 3]) box.run(join(box.dir, 'flow-builder-' + n), 'heartbeat');
}
