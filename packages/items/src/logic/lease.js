import { briefFiles } from './brief.js';
import { itemFiles } from './files.js';
import { Refused } from '../../../kernel/light.js';

/** A path-like token ending in a file extension, as a bar or plan names a file. */
const BAR_FILE = /(?<![\w./-])(?:[\w.-]+\/)*[\w.-]+\.[a-z][a-z0-9]*(?![\w/-])/giu;

/**
 * The files an item is predicted to change: those its brief names and those its bar names with a file extension.
 * Why not folders: a bar saying "a new test in apps/cli/journeys/next" names a folder many items share, and a lease on
 * it would refuse every neighbour for no real collision.
 *
 * @param {any} item
 * @returns {string[]}
 */
export function predictedFiles(item) {
  const named = [...(item.item_frozen ?? item.item_criterion ?? '').matchAll(BAR_FILE)].map(match => match[0])
    .filter(token => !/^[\d.]+$/u.test(token) && !/^[a-z]+:\/\//iu.test(token) && !/^(?:e\.g|i\.e)\.?$/iu.test(token));
  return [...new Set([...briefFiles(item.item_brief ?? ''), ...named])];
}

/**
 * Refuse a claim whose predicted files a live claim of another seat already leases (claims.fileLease).
 *
 * @param {{ prepare(sql: string): any }} db
 * @param {any} item the item being claimed
 * @param {string} actor the claiming seat
 * @param {{ hubs: string[] }} lease the setting: hub files are shared by design and never leased
 * @param {string} now ISO time; a lapsed lease holds nothing
 * @returns {void}
 */
export function requireFileLease(db, item, actor, lease, now) {
  const hubs = new Set(lease.hubs);
  const mine = predictedFiles(item).filter(file => !hubs.has(file));
  if (!mine.length) return;
  for (const holder of db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_id<>? AND item_owner IS NOT NULL AND item_owner<>? AND item_lease_until>? ORDER BY item_id").all(item.item_id, actor, now)) {
    const leased = new Set([...predictedFiles(holder), ...itemFiles(holder)]);
    const file = mine.find(path => leased.has(path));
    if (file) throw new Refused('FILE_LEASED', `#${item.item_id} predicts ${file}, which #${holder.item_id} held by ${holder.item_owner} leases until ${holder.item_lease_until}`,
      `take other work with pullboard next, or retry once #${holder.item_id} is submitted; a file many items share belongs in claims.fileLeaseHubs`);
  }
}

/**
 * Where a submission's changed files part from the files the item was predicted to change.
 * Why: a prediction is only worth leasing on once its misses are on record; hub files are shared by design, so neither side counts them.
 *
 * @param {any} item the submitted item, as the board holds it
 * @param {string[]} changed the files this submission changed
 * @param {string[]} [hubs] files many items share
 * @returns {{ predicted: string[], changed: string[], missed: string[], unpredicted: string[] } | null} null when nothing was predicted or the two agree
 */
export function fileMiss(item, changed, hubs = []) {
  const skip = new Set(hubs);
  const predicted = predictedFiles(item).filter(file => !skip.has(file));
  const actual = [...new Set(changed)].filter(file => !skip.has(file));
  if (!predicted.length) return null;
  const missed = predicted.filter(file => !actual.includes(file));
  const unpredicted = actual.filter(file => !predicted.includes(file));
  return missed.length || unpredicted.length ? { predicted, changed: actual, missed, unpredicted } : null;
}
