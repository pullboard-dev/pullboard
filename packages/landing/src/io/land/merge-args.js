/** The landing merge's git arguments, kept apart from the runner job so landing by hand reaches no gate or CLI code [C7,#3775]. */
import { tryGit } from '../../../../git/index.js';

/** The git identity a landing merge commits under. */
export const IDENTITY = ['-c', 'user.name=Pullboard', '-c', 'user.email=landing@pullboard.invalid', '-c', 'core.hooksPath=/dev/null'];

/** The spec ids an item's own subject cites: the merge's fallback for a job offered without a landing message. */
export function citedIds(root, commit) {
  const subject = tryGit(root, ['log', '-1', '--format=%s', commit]).stdout;
  return /\[([A-Z][0-9A-Za-z.,\s]*)\]\s*$/u.exec(subject)?.[1] ?? 'P7';
}

/**
 * The git merge arguments that land one item with its message: the offered header and Pullboard trailers as the body,
 * with merge.log off so no shortlog joins them. Why: the board builds the message from the item's frozen rows, as the
 * Mac landing engine does, and spec coverage reads those trailers; a runner has no board to build it [B3,R3,C7].
 */
export function landingMergeArgs(root, entry) {
  const message = typeof entry.header === 'string' && typeof entry.trailers === 'string'
    ? ['-m', entry.header, '-m', entry.trailers] : ['-m', `Merge #${entry.id} onto main [${citedIds(root, entry.commit)}]`];
  return [...IDENTITY, '-c', 'merge.log=false', 'merge', '--no-ff', '--no-edit', '--no-log', '-q', ...message, entry.commit];
}
