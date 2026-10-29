import * as store from '../board.js';
/** The pullboard roadmap command, in its own module so an item adding another command never edits these lines. */
import {
  Refused,
} from '../refused.js';
import * as roadmapView from '../roadmap.js';
import {
  context,
  withBoard,
} from '../cli.js';

/** Run `pullboard roadmap` and return its exit code. */
export function run(io, { first, second, rest }) {
  if (first || second || rest.length) throw new Refused('USAGE', 'pullboard roadmap takes no arguments');
  const ctx = context(io);
  const milestones = withBoard(ctx, (board) => roadmapView.milestoneRoadmap(ctx.info.root, board, { ports: store }));
  io.result?.({ milestones });
  if (!milestones.length) io.say('no milestones yet; the coordinator can add one with pullboard milestone add');
  for (const milestone of milestones) {
    const when = milestone.shipped ? ` · shipped at ${milestone.shipped.commit.slice(0, 12)} on ${milestone.shipped.at}`
      : milestone.target ? ` · target ${milestone.target}${milestone.pastTarget ? ', past target' : ''}` : '';
    io.say(`${milestone.name}: ${milestone.landed}/${milestone.total} landed${milestone.limit == null ? '' : ` · ${milestone.count}/${milestone.limit} items`}${when}`);
    if (!milestone.shipped) {
      const summary = milestone.summary;
      const estimate = roadmapView.roadmapEstimate(summary);
      io.say(`  ${summary.left} left of ${summary.total}: ${summary.landed} landed, ${summary.landing} landing, ${summary.review} in review, ${summary.building} building, ${summary.waiting} waiting, ${summary.held} held${estimate}`);
    }
    if (milestone.note) io.say(`  ${milestone.note}`);
    for (const item of milestone.items) {
      const id = typeof item.id === 'number' ? `#${item.id}` : item.id;
      io.say(`  ${item.position ? `${item.position}. ` : ''}${id} ${item.title} — ${item.state}`);
    }
  }
  return 0;
}
