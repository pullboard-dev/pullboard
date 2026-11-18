import { workQueue } from '../../../../../packages/items/index.js';
import * as store from '../../../../../packages/store/index.js';
import { roadmap } from '../../../../../packages/store/index.js';
/** The pullboard roadmap command, in its own module so an item adding another command never edits these lines. */
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import * as roadmapView from '../../../../../packages/roadmap/index.js';
import { listApiProjects } from '../../../../../packages/seats/index.js';
import { typedFieldsEnabled } from '../../../../../packages/config/index.js';
import { fieldIndex } from '../../../../../packages/store/index.js';
import { filterByField } from '../../../../../packages/items/index.js';
import {
  context,
  withBoard,
} from '../entry.js';

/**
 * A predicate over item ids for one --field filter, read from the board's field tables once.
 * Why ids: the roadmap holds numbered entries, and the shared pure filter already judges names, types and operators.
 */
function fieldMatcher(board, text) {
  const index = fieldIndex(board, { enabled: true });
  const kept = new Set(filterByField([...new Set([...index.values.keys()])].map(id => ({ id })), text, index).map(item => item.id));
  return id => kept.has(id);
}

/** Run `pullboard roadmap` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  if (first || second || rest.length) throw new Refused('USAGE', 'pullboard roadmap takes no arguments');
  const ctx = context(io);
  // --field keeps only the items whose typed field matches; without it nothing here differs from before [C7,#9354].
  if (values?.field !== undefined && !typedFieldsEnabled()) throw new Refused('FIELDS_OFF', 'typed item fields are off', 'turn on items.typedFields in the machine settings first');
  const milestones = withBoard(ctx, (board) => roadmapView.milestoneRoadmap(ctx.info.root, board, {
    ...(values?.field === undefined ? {} : { itemFilter: fieldMatcher(board, values.field) }), landedFromMain: ctx.config.landing?.landedFromMain === true, ports: { ...store, roadmap, openBoard: ctx.nativeBoard.openBoard, workQueue, listApiProjects } }));
  io.result?.({ milestones });
  if (!milestones.length) io.say('no milestones yet; the coordinator can add one with pullboard milestone add');
  for (const milestone of milestones) {
    const when = milestone.shipped ? ` · shipped at ${milestone.shipped.commit.slice(0, 12)} on ${milestone.shipped.at}`
      : milestone.target ? ` · target ${milestone.target}${milestone.pastTarget ? ', past target' : ''}` : '';
    io.say(`${milestone.name}: ${milestone.landed}/${milestone.total} landed${milestone.limit == null ? '' : ` · ${milestone.count}/${milestone.limit} items`}${milestone.mode === 'explicit' ? ' · explicit' : ''}${when}`);
    if (!milestone.shipped) {
      const summary = milestone.summary;
      const estimate = roadmapView.roadmapEstimate(summary);
      io.say(`  ${summary.left} left of ${summary.total}: ${summary.landed} landed, ${summary.landing} landing, ${summary.review} in review, ${summary.building} building, ${summary.waiting} waiting, ${summary.held} held${estimate}`);
    }
    io.say(`  holders: ${milestone.progress.holders.join(', ') || 'none'}; waits: ${milestone.progress.waits.join(', ') || 'none'}; idle: ${milestone.progress.idleMinutes ?? 'unknown'}m (${milestone.progress.idleBasis})`);
    if (milestone.note) io.say(`  ${milestone.note}`);
    for (const item of milestone.items) {
      const id = typeof item.id === 'number' ? `#${item.id}` : item.id;
      if (item.progress) io.say(`    ${roadmapView.progressLine(item.progress)}`);
      io.say(`  ${item.position ? `${item.position}. ` : ''}${id} ${item.title} — ${item.state}`);
    }
  }
  return 0;
}
