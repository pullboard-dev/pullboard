/** Ship staged work through ordinary hooks, claim guards, submission and verdict waiting [V4,B3,C7]. */
import { buildCommitMessage } from '../../../../../packages/commits/index.js';
import { landingMessage } from '../../../../../packages/landing/index.js';
import { loadSpec } from '../../../../../packages/spec/index.js';
import { firstRefusal } from '../../../../../packages/store/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { context } from '../entry.js';
import { withBoard } from '../entry.js';
import { whoAmI } from '../entry.js';
import { ordered } from '../entry.js';
import { idArg } from '../entry.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { untracked } from '../../../../../packages/git/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import { cleanGitEnvironment } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { run as claim } from './claim.js';
import { run as submit } from './submit.js';
import { withBoardRead } from '../context.js';
import { retrySync } from '../sync.js';
import { events } from '../../../../../packages/store/index.js';
import { verdictsFor } from '../../../../../packages/store/index.js';
import { newestGateJob } from './show.js';
import { queuedAcknowledgment } from '../submit/pulled.js';
import { waitForPulledGate } from '../submit/pulled.js';
import { waitForSubmissionVerdict } from '../../../../../packages/items/index.js';

/** Resolve only this seat's claim or its explicit returned-work reservation before any Git mutation. */
function shippingItem(ctx, requested) {
  return withBoard(ctx, board => {
    const me = whoAmI(ctx, board);
    const rows = requested ? [getItem(board, idArg(requested))] : listItems(board, { all: true }).filter(item =>
      item.item_status === 'claimed' && item.item_owner === me.id
      || item.item_status === 'open' && item.item_built_by === me.id && firstRefusal(board, item.item_id)?.builder === me.id);
    if (rows.length !== 1) throw new Refused('USAGE', 'ship needs exactly one owned item; use pullboard ship <id> after claiming your work');
    const item = rows[0];
    const live = item.item_status === 'claimed' && item.item_owner === me.id && item.item_lease_until > board.clock.now().toISOString();
    const window = firstRefusal(board, item.item_id);
    if (!live && !(window?.builder === me.id && (item.item_status === 'open' || item.item_owner === me.id))) {
      throw new Refused('NOT_YOURS', `ship cannot reclaim #${item.item_id}: this seat has neither a live claim nor its first-refusal window`,
        `claim #${item.item_id} normally before shipping; never take another builder's reserved work`);
    }
    return { item, reclaim: !live, me };
  });
}

/** Run real Git hooks and retain their original refusal and all resulting files. */
function gitStep(root, args, phase, next) {
  const result = tryGit(root, args, { env: cleanGitEnvironment() });
  if (result.status !== 0) throw new Refused(phase === 'merge' ? 'MERGE_CONFLICT' : 'USAGE',
    `ship stopped at ${phase}: ${result.stderr || result.stdout || `git exited ${result.status}`}`, next);
  return result.stdout;
}

/** Commit only the staged input, merge accepted main, then invoke ordinary submit exactly once. */
export async function run(io, { first, second, rest, values }) {
  if (second || rest.length) throw new Refused('USAGE', 'pullboard ship [id] [--note text] [--infra text]');
  if (values.note !== undefined && (typeof values.note !== 'string' || !values.note.trim())) throw new Refused('USAGE', '--note needs nonempty text');
  const ctx = context(io);
  const { item, reclaim, me } = shippingItem(ctx, first);
  const root = ctx.info.root;
  const unstaged = tryGit(root, ['diff', '--quiet'], { env: cleanGitEnvironment() });
  if (unstaged.status !== 0) throw new Refused('DIRTY', 'ship leaves unstaged tracked changes alone; stage exactly the work to ship', 'stage or restore the unstaged changes, then run pullboard ship again');
  const stray = untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `ship leaves untracked files alone, including ${stray[0]}`, 'stage or ignore the intended files, then run pullboard ship again');
  const originalResult = io.result;
  let result;
  io.result = value => { result = value; };
  try {
    if (reclaim) {
      const code = await claim(io, { first: String(item.item_id), values: {}, rest: [] });
      if (code !== 0) return code;
    }
    const staged = tryGit(root, ['diff', '--cached', '--quiet'], { env: cleanGitEnvironment() });
    if (![0, 1].includes(staged.status)) throw new Refused('USAGE', `ship cannot read the staged input: ${staged.stderr}`, 'repair the Git index, then run pullboard ship again');
    if (staged.status === 1) {
      const current = withBoard(context(io), board => getItem(board, item.item_id));
      const spec = loadSpec(root, ctx.config);
      const rows = landingMessage(current, { spec }).rows;
      const message = buildCommitMessage({ type: 'feat', scope: current.item_lane, title: current.item_title, item: current.item_id, rows, preferRows: true }).message;
      gitStep(root, ['commit', '-m', message], 'commit', 'fix the hook refusal without bypassing it, then run pullboard ship again');
    }
    const main = mainCheckout(root);
    if (!main?.commit) throw new Refused('USAGE', 'ship cannot find committed main', 'restore the main checkout, then run pullboard ship again');
    gitStep(root, ['merge', '--no-edit', main.commit], 'merge', 'resolve the preserved merge conflict and commit normally, then run pullboard ship again');
    const code = await submit(io, { first: String(item.item_id), values: { ...values, wait: true, 'no-next': true }, rest: [] });
    if (code !== 0) { originalResult?.(result); return code; }
    const waitContext = context(io);
    let gateResult = result ?? queuedAcknowledgment(waitContext, item.item_id, gitStep(root, ['rev-parse', 'HEAD'], 'commit', 'rerun ship').trim(), { withBoardRead, getItem, newestGateJob });
    // A pulled submit returns queued, and the claiming seat never blocks on its own gate: wait for the job's receipt here [C7,#7736].
    if (gateResult?.queued) {
      const gate = await waitForPulledGate(waitContext, item.item_id, gateResult, { withBoardRead, retrySync, getItem, newestGateJob });
      gateResult = { ...gateResult, queued: false, gate };
    }
    const receipt = withBoardRead(waitContext, board => events(board, { itemId: item.item_id })
      .findLast(event => event.event_kind === 'submit'
        && JSON.parse(event.event_detail).commit === gateResult.commit));
    const reviewCode = await waitForSubmissionVerdict(waitContext, item.item_id, gateResult, receipt,
      { withBoardRead, retrySync, events, verdictsFor, getItem });
    if (reviewCode !== 0) { originalResult?.(result); return reviewCode; }
    const submission = result;
    if (values.note !== undefined) {
      // The seat was resolved before the work moved: an item folder names its seat only while the item is claimed, and the verdict has landed it by now [C7,#7752].
      await withBoard(context(io), async board => {
        await ordered(context(io), board, 'appendFact', [item.item_id, { agentId: me.id, kind: 'note', text: values.note }]);
      });
    }
    originalResult?.(submission);
    return 0;
  } finally { io.result = originalResult; }
}
