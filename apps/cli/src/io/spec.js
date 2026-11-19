import { seatAt } from './item/folder/identity.js';
/** Helpers for `pullboard spec`: row reservations, citations and current proof. Split from src/cli.js, which re-exports it [C7]. */
import * as store from '../../../../packages/store/index.js';
import { hookRead } from './support.js';
import { withBoard } from './context.js';
import { gitOut } from '../../../../packages/store/index.js';
import { ID_RE } from '../../../../packages/spec/index.js';
import { correctedCitations } from '../../../../packages/spec/index.js';
import { qualifiedId } from '../../../../packages/spec/index.js';
import { readCitationCorrections } from '../../../../packages/spec/index.js';
import { parseCommitMessage } from '../../../../packages/commits/index.js';
import { committedIds } from '../../../../packages/store/index.js';
import { ordered } from './claim.js';
import { whoAmI } from './join.js';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

export { coordinatorFile } from './coordinator-file.js';
/**
 * Reserve a new row's id on the board in one write transaction before any file names it, so writers
 * that plan the same id at the same moment get distinct ids (#878). written: the caller writes the row
 * into its own file now; otherwise it is a lane draft that spec apply writes. With no board yet there is
 * no other writer, and the planned id stands.
 */
export async function reserveRow(ctx, row, written) {
  if (!fs.exists(ctx.file)) return row;
  return withBoard(ctx, async (board) => ordered(ctx, board, 'draftSpecRow', [{ agentId: seatAt(board, ctx.info.root)?.agent_id ?? whoAmI(ctx, board).id, row, written }]));
}

/**
 * Every spec id something cites (S8): commit headers since the spec's first commit, and every item
 * on the board, open or closed. The connection is read-only: spec lint never migrates a shared board. Each must still be in the spec. The board is shared by every
 * checkout, so at an older commit an item may cite a row a later commit added: that id is not lost
 * here, only not written yet, and it counts once any ref has committed it (S10).
 *
 * @param {any} ctx
 * @param {{ ids: Map<string, string>, since: string | null }} history - this checkout's.
 * @returns {Map<string, string>} Each id, with who cites it.
 */
export function citations(ctx, { ids, since }) {
  const cited = since ? commitCitations(ctx.info.root, since) : new Map();
  if (!fs.exists(ctx.file)) return cited;
  const byItems = new Map();
  for (const item of hookRead(ctx, (board) => store.listItems(board, { all: true }))) {
    for (const id of item.item_spec_ids ? item.item_spec_ids.split(',') : []) {
      if (!cited.has(id) && !byItems.has(id)) byItems.set(id, `item #${item.item_id}`);
    }
  }
  const unseen = [...byItems.keys()].some((id) => !ids.has(id));
  const elsewhere = unseen ? committedIds(ctx.info.root, ctx.config.spec, ['--all']).ids : new Map();
  for (const [id, where] of byItems) if (ids.has(id) || !elsewhere.has(id)) cited.set(id, where);
  return cited;
}

/** Current board evidence, with each item's accepting receipts included once. */
export function specProof(ctx) {
  if (!fs.exists(ctx.file)) return { items: [], verdicts: [] };
  return withBoard(ctx, (board) => {
    const items = store.listItems(board, { all: true });
    return { items, verdicts: items.flatMap((item) => store.verdictsFor(board, item.item_id)) };
  });
}

/**
 * The complete spec citations from `since` (the spec's first commit) to HEAD, each with the newest
 * commit that cites it. Final row trailers take priority over header previews; legacy commits fall
 * back to their named header rows. Commits older than the spec cite nothing it could hold. A commit's
 * recorded correction (.pullboard/citations.jsonl) replaces the bare id it names with its qualified id.
 *
 * @param {string} root
 * @param {string} since
 * @returns {Map<string, string>}
 */
export function commitCitations(root, since) {
  const out = [
    gitOut(root, ['log', '--format=%h%x00%B%x00', `${since}..HEAD`]),
    gitOut(root, ['log', '-1', '--format=%h%x00%B%x00', since]),
  ].join('\n');
  const cited = new Map();
  const { corrections } = readCitationCorrections(root);
  // Git commit messages cannot contain NUL, so body lines and tabs cannot forge record boundaries.
  const records = out.split('\0');
  for (let index = 0; index + 1 < records.length; index += 2) {
    const short = records[index].trim();
    if (!short) continue;
    const parsed = parseCommitMessage(records[index + 1]);
    // A recorded correction reads a bare id as the other board's qualified one it means [S8].
    const ids = correctedCitations(short, (parsed.rows ?? parsed.shown).filter((entry) => ID_RE.test(entry) || qualifiedId(entry)), corrections);
    for (const id of ids) {
      if (!cited.has(id)) cited.set(id, `commit ${short}`);
    }
  }
  return cited;
}

/**
 * Spec check findings about other boards' citations [S8]: a correction record that does not parse is
 * an error; a board pullboard.json specBoards names whose spec is not on this machine is a warning,
 * because its qualified citations cannot be resolved here.
 *
 * @param {string} root
 * @param {{ name: string, boards?: Map<string, { name: string, path: string, spec: any }> }} spec
 * @returns {{ level: string, message: string }[]}
 */
export function citationBoardFindings(root, spec) {
  const errors = readCitationCorrections(root).problems.map((problem) => ({ level: 'error', message: `${spec.name}: error: ${problem}` }));
  const unread = [...(spec.boards?.values() ?? [])].filter((board) => !board.spec)
    .map((board) => ({ level: 'warning', message: `${spec.name}: warning: the ${board.name} board's spec is not at ${board.path}; ${board.name}:<id> citations are not resolved on this machine` }));
  return [...errors, ...unread];
}
