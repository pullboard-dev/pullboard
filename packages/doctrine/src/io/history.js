/** Doctrine row history across the conventional filename change; the only doctrine read that needs the store [C7,D1]. */
import { committedIds } from '../../../store/index.js';
import { doctrineFileNames } from './main.js';

/** Retain committed row ids across the conventional filename change at the requested revisions. */
export function doctrineHistory(root, name, revs = ['HEAD']) {
  const [current, legacy] = doctrineFileNames();
  const history = committedIds(root, name, revs);
  if (![current, legacy].includes(name)) return history;
  const other = committedIds(root, name === current ? legacy : current, revs);
  for (const [id, commit] of other.ids) if (!history.ids.has(id)) history.ids.set(id, commit);
  return { ...history, since: history.since ?? other.since };
}
