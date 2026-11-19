/** Let a finished `pullboard test` run update the Main red ledger when it ran main's own code [C7,#4635]. */
import { COORDINATOR } from '../../../../../packages/config/index.js';
import { headCommit } from '../../../../../packages/git/light.js';
import { mainCheckout } from '../../../../../packages/git/light.js';
import { gitSpawnSync } from '../../../../../packages/git/index.js';
import { sameTestInputs } from '../../../../../packages/landing/index.js';
import { laneOf } from '../../../../../packages/seats/index.js';
import { mainRedUpdates } from '../../../../../packages/runners/index.js';
import { filesOfMain } from '../../../../../packages/runners/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { ordered } from '../claim.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';

/** Quote one literal file for a stored check command. */
const word = file => "'" + file.replaceAll("'", "'\\''") + "'";

/** The case names a Main red item's criterion lists ("Repair these exact cases on main <sha>: a; b. They fail ..."), empty when it lists none. */
function redCaseNames(criterion) {
  const found = /^Repair these exact cases on main [a-f0-9]+: (.*)\. They fail/su.exec(String(criterion ?? ''));
  return found ? found[1].split('; ').filter(Boolean) : [];
}

/**
 * Tell each open item whose red gate failed on a fixed Main red that the red is fixed, so its holder resubmits at once.
 * Why: the item stayed red until someone noticed the red had been fixed on main; one note per item, written only when the red closes, so a run that closes nothing writes none [C7,#1269].
 * The reader and the matcher load here, at the first close, so a run that closes nothing pays for neither.
 *
 * @param {object} ctx
 * @param {object} board - The board the close loop already holds.
 * @param {{ item: object, file: string, main: string, run: string }} red - The closed Main red item, its file, the main commit and the run that proved it.
 * @param {{ itemReds?: Function }} ports
 */
async function notifyFailedItems(ctx, board, { item, file, main, run }, ports) {
  const names = redCaseNames(item?.item_criterion);
  if (!names.length) return;
  const { itemsFailedOn } = await import('../../../../../packages/items/index.js');
  const itemReds = await (ports.itemReds ?? (await import('../submit/red-progress.js')).openItemReds)(board, ctx.info.root);
  const told = new Set();
  for (const name of names) for (const id of itemsFailedOn({ file, name }, itemReds)) told.add(id);
  for (const id of told) {
    await (ports.ordered ?? ordered)(ctx, board, 'appendFact', [id, { agentId: COORDINATOR, kind: 'note', text: `Main red ${file} is fixed on main ${main.slice(0, 12)} (test run ${run}); your red gate failed on it, so resubmit or rerun the gate` }]);
  }
}

/**
 * Close the open Main red item of each file a green run proved, and file one for each red file no item owns.
 * Why: only the daily census did this, so a run that showed main's state left the ledger stale [C7,#4635]. It never
 * stops the run: a ledger error is said aloud and the test result stands.
 *
 * @param {{ err: Function }} io
 * @param {object} ctx
 * @param {{ green: boolean, files: string[], cases: Array<{file: string, name: string}>, run?: string }} outcome
 * @param {{ itemReds?: Function, withBoard?: Function, withBoardRead?: Function, listItems?: Function, ordered?: Function }} [ports] - The reader of each open item's latest red gate failures and the board seams; tests stand in their own, a run uses the real ones.
 * @returns {Promise<{ closed: number[], filed: number[] }>}
 */
export async function updateMainReds(io, ctx, { green, files, cases, run }, ports = {}) {
  const board$ = ports.withBoard ?? withBoard, read$ = ports.withBoardRead ?? withBoardRead, order = ports.ordered ?? ordered;
  const none = { closed: [], filed: [] };
  try {
    const root = ctx.info.root, main = mainCheckout(root)?.commit, head = headCommit(root);
    if (!main || !head) return none;
    let qualified = filesOfMain(args => gitSpawnSync(args, { cwd: root, encoding: 'utf8' }), { main, head, files });
    // Item code counts only where the file's whole input closure is unchanged, not just the file itself.
    if (head !== main) {
      const same = [];
      for (const file of qualified) if (await sameTestInputs(root, main, head, file).catch(() => false)) same.push(file);
      qualified = same;
    }
    if (!qualified.length) return none;
    const items = read$(ctx, board => (ports.listItems ?? listItems)(board, { all: true }));
    const updates = mainRedUpdates({ items, files, green, failing: cases, qualified, main });
    if (!updates.close.length && !updates.file.length) return none;
    const made = { closed: [], filed: [] };
    await board$(ctx, async board => {
      for (const { item, file } of updates.close) {
        await order(ctx, board, 'appendFact', [item, { agentId: COORDINATOR, kind: 'note', text: `${file} passed on main ${main.slice(0, 12)} in test run ${run ?? head.slice(0, 12)}; closed as fixed on main` }]);
        await order(ctx, board, 'withdraw', [item, { agentId: COORDINATOR, reason: `${file} passes on main ${main.slice(0, 12)} (test run ${run ?? head.slice(0, 12)}); fixed on main, closed without a builder` }]);
        made.closed.push(item);
        await notifyFailedItems(ctx, board, { item: items.find(row => row.item_id === item), file, main, run: run ?? head.slice(0, 12) }, { ...ports, ordered: order });
      }
      for (const { file, names } of updates.file) {
        const lane = laneOf({ lanes: ctx.config.lanes }, file);
        if (!lane || lane === 'coordinator') { io.err(`main red ${file} has no owning lane; the coordinator must file its repair`); continue; }
        made.filed.push(await order(ctx, board, 'addItem', [{ by: COORDINATOR, lane, title: `Main red: ${file}`, route: 'strong', specIds: [], parentId: null, after: [],
          criterion: `Repair these exact cases on main ${main}: ${names.join('; ')}. They fail in a test run at main alone.`,
          brief: `Files: ${file}\nTest: Run the stored exact-file check; every case named in the criterion must pass.\nSource: test run at main ${main}`,
          check: `${String(ctx.config.affectedTests ?? '').trim()} ${word(file)}`.trim() }]));
      }
    });
    return made;
  } catch (error) {
    io.err(`pullboard test: the Main red ledger was not updated (${error.message})`);
    return none;
  }
}
