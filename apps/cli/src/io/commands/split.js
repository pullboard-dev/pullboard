/** The pullboard split command: one child item per numbered clause of a parent, each carrying its clause and the parent's check, each filed --after the one before [C7,#8916]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import * as store from '../../../../../packages/store/index.js';
import { context } from '../entry.js';
import { idArg } from '../entry.js';
import { ordered } from '../entry.js';
import { actOn } from '../entry.js';
import { withBoardRead } from '../board/read.js';
import { run as add } from './add.js';

/**
 * A criterion's numbered clauses, in order; text before the first number is a preamble and is not a clause.
 *
 * @param {string} criterion - The parent's whole criterion.
 * @returns {string[]}
 */
export function numberedClauses(criterion) {
  const text = String(criterion ?? '');
  const marks = [...text.matchAll(/(?:^|\s)\d+\.\s/gu)];
  return marks.map((mark, at) => text.slice(mark.index + mark[0].length, at + 1 < marks.length ? marks[at + 1].index : undefined).trim()).filter(Boolean);
}

/** Run `pullboard split <id>` and return its exit code. */
export async function run(io, args) {
  const { first, second } = args;
  if (first === undefined || second !== undefined) throw new Refused('USAGE', 'pullboard split takes one parent item id', 'run: pullboard split <id>');
  const parentId = idArg(first, 'a parent item id');
  const parent = await withBoardRead(context(io), board => {
    const item = store.getItem(board, parentId);
    return { ...item, clauses: numberedClauses(item.item_criterion) };
  });
  if (parent.clauses.length < 2) throw new Refused('SPLIT_ONE_CLAUSE', `#${parentId} has ${parent.clauses.length} numbered clause${parent.clauses.length === 1 ? '' : 's'}, so there is nothing to split`, 'a bar splits into one child per numbered clause: edit the bar to number its clauses 1. 2. ... first');
  const ids = [];
  const lines = [];
  const say = io.say, result = io.result;
  try {
    for (const [at, clause] of parent.clauses.entries()) {
      io.say = line => { const found = /^#(\d+)$/u.exec(String(line)); if (found) ids.push(Number(found[1])); };
      io.result = undefined;
      const values = { criterion: `1. ${clause}`, ...(parent.item_check ? { check: parent.item_check } : {}), brief: parent.item_brief ?? '',
        parent: String(parentId), ...(ids.length ? { after: String(ids.at(-1)) } : {}), ...(parent.item_spec_ids ? { specs: parent.item_spec_ids } : {}), route: parent.item_route };
      const before = ids.length;
      const code = await add(io, { first: parent.item_lane, second: `${parent.item_title} (clause ${at + 1} of ${parent.clauses.length})`, rest: [], values });
      if (code !== 0 || ids.length === before) throw new Refused('SPLIT_ADD_FAILED', `filing the child for clause ${at + 1} of #${parentId} did not complete`, `children filed so far: ${ids.map(id => `#${id}`).join(', ') || 'none'}; fix what add said, then file the rest by hand with pullboard add --parent ${parentId} --after <previous>`);
      lines.push(`#${ids.at(-1)} clause ${at + 1}${ids.length > 1 ? `, after #${ids.at(-2)}` : ''}`);
    }
  } finally { io.say = say; io.result = result; }
  // The parent keeps the split on its own thread, so a reader of the parent finds every child without searching [C7,#8917].
  const noted = await actOn(io, async (ctx, board, me) => {
    await ordered(ctx, board, 'appendFact', [parentId, { agentId: me.id, kind: 'note', text: `split into ${ids.map(id => `#${id}`).join(', ')}` }]);
    return 0;
  });
  if (noted !== 0) return noted;
  io.result?.({ parent: parentId, children: ids });
  for (const line of lines) io.say(line);
  return 0;
}
