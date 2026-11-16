/** After a train batch lands, one full suite compares with the previous batch's result and files each new red as a Main red [C7,H16]. */
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultItemRoute } from '../../../../items/index.js';
import { criterionCells } from '../../../../items/index.js';
import { mainRedRootCause } from '../../../../items/index.js';
import { mainRedKeyLines } from '../../../../items/index.js';
import { mainRedEvidenceLines } from '../../../../items/index.js';
import { fileMainRed } from '../../../../items/index.js';
import { typedRequests } from '../../../../store/index.js';
import { getItem } from '../../../../store/index.js';

/** One case is its file and its exact test name. */
const keyOf = (file, name) => JSON.stringify([file, name]);

/** Quote one literal file for the stored check command. */
function word(file) { return "'" + file.replaceAll("'", "'\\''") + "'"; }

/** Cases red now that the previous result did not have, grouped by file; no previous result means no new reds. */
export function newRedCases(previous, failures) {
  if (!previous) return [];
  const before = new Set(previous.failures.map(row => keyOf(row.file, row.name)));
  const fresh = failures.filter(row => !before.has(keyOf(row.file, row.name)));
  return fresh;
}

const rootCause = mainRedRootCause;

/** Read the previous result; an absent or unreadable file is no baseline, said loudly by the caller. */
function readPrevious(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value?.version === 1 && Array.isArray(value.failures) ? value : null;
  } catch { return null; }
}

/** Replace the stored result atomically so a crash never leaves half a baseline. */
function writePrevious(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/** The replacement a request names: "superseded by #N" or "duplicate of #N", with the phrase kept as the withdrawal reason. */
const REPLACEMENT = /\b(superseded by|duplicate of) #(\d+)\b/iu;

/**
 * Withdraw each item that an open withdraw request says is superseded by, or a duplicate of, an item this batch landed,
 * with that phrase as the reason, then answer the request done. Why: a replacement landing left its duplicate open
 * until the coordinator noticed, and a builder could claim work that no longer mattered [C7].
 */
export async function withdrawSuperseded(state) {
  const landed = new Set(state.batch.items.map(entry => entry.id));
  const withdrawn = [];
  for (const request of typedRequests(state.board)) {
    if (request.verb !== 'withdraw') continue;
    const named = REPLACEMENT.exec(request.note);
    if (!named || !landed.has(Number(named[2]))) continue;
    if (!['open', 'claimed', 'submitted', 'verified'].includes(getItem(state.board, request.item).item_status)) continue;
    const reason = `${named[1].toLowerCase()} #${named[2]}, which landed in batch ${state.batch.id}`;
    await state.write('withdraw', [request.item, { agentId: 'coordinator', reason }]);
    const event = state.board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE event_kind = 'withdraw' AND item_id = ?").get(request.item);
    await state.write('answerTypedRequests', [{ agentId: 'coordinator', answers: [{ requestId: request.id, outcome: 'done', note: reason, eventId: event.id }] }]);
    withdrawn.push({ item: request.item, by: Number(named[2]) });
  }
  if (withdrawn.length) state.say(`withdrew ${withdrawn.map(row => `#${row.item} (replaced by #${row.by})`).join(', ')}`);
  return withdrawn;
}

/** The post-land suite record's file name under the board's private folder; this module writes it, so it owns the store. */
export const POST_LAND_SUITE_FILE = 'post-land-suite.json';

/**
 * Compare this landed batch's full-suite result with the previous batch's and file one Main red per file that newly
 * fails, through the coordinator's ordinary addItem move. Every outside capability arrives as a port; off unless
 * the ports say the machine setting is on; it never refuses, so
 * the train keeps landing, and every outcome is a greppable line.
 */
export async function postLandSuite(state, ports) {
  // A closed replacement never blocks the train: this step reports and the landing goes on.
  try { await withdrawSuperseded(state); } catch (error) { state.say(`superseded withdrawals failed: ${error.message}`); }
  if (!ports?.enabled()) return { ran: false };
  const { runSuite, readItems, laneOf, unownedMainReds, storePath } = ports;
  const batch = state.batch;
  const names = batch.items.map(entry => `#${entry.id}`).join(', ');
  const label = `post-land suite for batch ${batch.id} (${names}) at ${batch.tip}`;
  try {
    const path = storePath(batch.root);
    const result = await runSuite(batch.root);
    if (result.unavailable) { state.say(`${label}: not run: ${result.unavailable}`); return { ran: false, unavailable: result.unavailable }; }
    if (!result.green && !result.failures) {
      state.say(`${label}: red, but its failures cannot be accounted for case by case; the previous result is kept and nothing was filed`);
      return { ran: true, accounted: false };
    }
    const previous = readPrevious(path);
    const fresh = newRedCases(previous, result.failures);
    const filed = [];
    if (fresh.length) {
      const items = readItems(state.board);
      const missing = unownedMainReds({ failures: fresh }, items, null, true);
      if (missing === null) throw new Error('a new red case already has several open owners; ask the coordinator to settle which repair owns it');
      const groups = new Map();
      for (const { file, names: cases } of missing) {
        const lane = laneOf({ lanes: state.config.lanes }, file);
        if (!lane || lane === 'coordinator') {
          state.say(`${label}: ${file} newly fails (${cases.join('; ')}) but no lane owns it; the coordinator must file its repair`);
          continue;
        }
        for (const row of fresh.filter(row => row.file === file && cases.includes(row.name))) {
          const cause = rootCause(row);
          const key = JSON.stringify([lane, cause]);
          if (!groups.has(key)) groups.set(key, { lane, cause, rows: [] });
          groups.get(key).rows.push(row);
        }
      }
      for (const { lane, cause, rows: allRows } of [...groups.values()].sort((a, b) => a.cause.localeCompare(b.cause) || a.lane.localeCompare(b.lane))) {
        // One cause key for every filer: a cause an open repair owns gets a fact there, never a second item.
        const keyed = allRows.map(row => ({ file: row.file, name: row.name, cause }));
        await fileMainRed({ items, rows: keyed, source: `post-land suite, batch ${batch.id} (${names}); main ${batch.tip}`,
          addFact: (id, text) => state.write('appendFact', [id, { agentId: 'coordinator', kind: 'measurement', text }]),
          create: async fresh => {
            const rows = allRows.filter(row => fresh.some(entry => entry.file === row.file && entry.name === row.name));
            rows.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
            const files = [...new Set(rows.map(row => row.file))];
            const cases = rows.map(row => `${row.file} :: ${row.name}`);
            const criterion = `Repair these exact cases on main ${batch.tip}: ${cases.join('; ')}. First red in batch ${batch.id} (${names}); the previous batch's full suite did not fail them. Filed by the post-land suite.`;
            const title = files.length > 1 ? `Red cluster: ${cause.slice(0, 120)}` : `Main red: ${files[0]}`;
            const id = await state.write('addItem', [{ by: 'coordinator', lane, title, route: defaultItemRoute(criterion, criterionCells(batch.root)), specIds: [], parentId: null, after: [],
              criterion,
              brief: `Files: ${files.join(', ')}\nTest: Run the stored exact-file check; every case named in the criterion must pass.\nSource: post-land suite, batch ${batch.id} (${names}); main ${batch.tip}\n${mainRedKeyLines(fresh)}${mainRedEvidenceLines(rows)}`,
              check: `${String(state.config.affectedTests ?? '').trim()} ${files.map(word).join(' ')}` }]);
            for (const file of files) filed.push({ file, item: id });
            return id;
          } });
      }
    }
    writePrevious(path, { version: 1, batch: batch.id, items: batch.items.map(entry => entry.id), tip: batch.tip, failures: result.failures });
    state.say(`${label}: ${result.green ? 'green' : `${result.failures.length} red case(s)`}; ${previous ? `${fresh.length} new red case(s) against batch ${previous.batch}` : 'first run, recorded as the baseline'}${filed.length ? `; filed ${filed.map(row => `#${row.item} for ${row.file}`).join(', ')}` : ''}`);
    return { ran: true, newReds: fresh, filed, baseline: !previous };
  } catch (error) {
    state.say(`${label}: failed and filed nothing: ${error.message}`);
    return { ran: true, error: error.message };
  }
}
