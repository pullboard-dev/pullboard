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

/**
 * Close the open Main red item of each file a green run proved, and file one for each red file no item owns.
 * Why: only the daily census did this, so a run that showed main's state left the ledger stale [C7,#4635]. It never
 * stops the run: a ledger error is said aloud and the test result stands.
 *
 * @param {{ err: Function }} io
 * @param {object} ctx
 * @param {{ green: boolean, files: string[], cases: Array<{file: string, name: string}>, run?: string }} outcome
 * @returns {Promise<{ closed: number[], filed: number[] }>}
 */
export async function updateMainReds(io, ctx, { green, files, cases, run }) {
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
    const items = withBoardRead(ctx, board => listItems(board, { all: true }));
    const updates = mainRedUpdates({ items, files, green, failing: cases, qualified, main });
    if (!updates.close.length && !updates.file.length) return none;
    const made = { closed: [], filed: [] };
    await withBoard(ctx, async board => {
      for (const { item, file } of updates.close) {
        await ordered(ctx, board, 'appendFact', [item, { agentId: COORDINATOR, kind: 'note', text: `${file} passed on main ${main.slice(0, 12)} in test run ${run ?? head.slice(0, 12)}; closed as fixed on main` }]);
        await ordered(ctx, board, 'withdraw', [item, { agentId: COORDINATOR, reason: `${file} passes on main ${main.slice(0, 12)} (test run ${run ?? head.slice(0, 12)}); fixed on main, closed without a builder` }]);
        made.closed.push(item);
      }
      for (const { file, names } of updates.file) {
        const lane = laneOf({ lanes: ctx.config.lanes }, file);
        if (!lane || lane === 'coordinator') { io.err(`main red ${file} has no owning lane; the coordinator must file its repair`); continue; }
        made.filed.push(await ordered(ctx, board, 'addItem', [{ by: COORDINATOR, lane, title: `Main red: ${file}`, route: 'strong', specIds: [], parentId: null, after: [],
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
