import { fileSystemAdapter } from '../../../fs/index.js';
import {
  localDependencyIds,
  dependencyLabel,
} from "../logic/dependencies.js";

/**
 * `pullboard digest`: a short Markdown briefing of one board, for a person or a chat assistant
 * that can read the repo but never the board [A2,N26].
 *
 * Why read-only SQLite and not the board API: the digest must never change the board, so it opens
 * the file read-only and never migrates, syncs or resolves another registered board.
 */
import { randomUUID } from 'node:crypto';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import {
  CAUGHT_KINDS,
  caughtFrom,
} from "../logic/caught.js";

import { secretsIn } from "../../../commits/light.js";
import { Refused } from "../../../kernel/index.js";


import {
  rowDecisionContext,
  staleRowDecision,
} from "../../../spec/index.js";
import { loadConfig } from "../../../config/index.js";

const fs = fileSystemAdapter();

/** The briefing stays under 50 KB, counted in UTF-8 bytes. */
export const DIGEST_MAX_BYTES = 50_000;
/** How many rows each section reads before its byte budget decides how many it shows. */
const ROW_LIMIT = 200;
/** Fact kinds that record a judgement and its reason. */
const JUDGEMENTS = ['decision', 'rejection', 'root-cause', 'supersession'];
/** How far back the briefing's caught section reads, in days. */
const CAUGHT_DAYS = 30;
/** Plain words for verdict reasons, keeping the code beside them for agents. */
const REASONS = {
  TEST_FAILURE: 'a test failed', BEHAVIOR_MISMATCH: 'the behavior differs from the bar', INSUFFICIENT_EVIDENCE: 'too little evidence',
  STALE_HEAD: 'the commit was out of date', CRITERION_MET: 'it meets its bar', OTHER: 'another reason',
};

/**
 * Board text as one safe Markdown line. Pullboard's secret patterns are checked on the whole
 * source text, on each of its lines and on the text as it would print, before anything is split
 * or shortened; any match redacts the whole entry. Why the whole entry: a multi-line secret such
 * as a private key block is recognised by its header, and redacting only that line would print
 * the body and footer that follow it.
 *
 * @param {unknown} value
 * @param {number} limit UTF-8 bytes
 * @param {{ count: number }} cut counts shortened fields for the left-out section
 * @returns {string}
 */
function line(value, limit, cut) {
  const source = String(value ?? '');
  const printed = source.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const views = [source, printed, ...source.split(/\r?\n/u)];
  if (secretsIn(views.map((text) => ({ path: 'digest', line: 1, text }))).length) return '[redacted secret]';
  const text = printed;
  if (Buffer.byteLength(text) <= limit) return text;
  cut.count += 1;
  let kept = text.slice(0, limit);
  while (Buffer.byteLength(kept) > limit - 4) kept = kept.slice(0, -1);
  return `${kept.replace(/[\uD800-\uDBFF]$/u, '')} …`;
}

/**
 * One section: its heading, as many entries as fit its byte budget, and a closing line naming how
 * many were left out. The counts also go to the final left-out section and the JSON result.
 *
 * @param {string} title
 * @param {string[]} entries newest or most important first
 * @param {number} total every matching row on the board, shown or not
 * @param {number} budget UTF-8 bytes for the whole section
 * @param {string} empty what the section says when the board has none
 */
function section(title, entries, total, budget, empty) {
  let text = `## ${title}\n\n`;
  let shown = 0;
  for (const entry of entries) {
    if (Buffer.byteLength(text) + Buffer.byteLength(entry) + 80 > budget) break;
    text += `${entry}\n`;
    shown += 1;
  }
  if (!total) text += `${empty}\n`;
  else if (shown < total) text += `${shown ? '\n' : ''}${total - shown} more left out to keep this briefing short.\n`;
  return { title, shown, total, text: `${text}\n` };
}

/**
 * Read one consistent snapshot of the board at `file` and render the briefing.
 *
 * @param {string} file the board's SQLite file
 * @param {{ name?: string, now?: Date, root?: string, config?: any, healthReport?: Function }} [options] root and config let
 *   pullboard health's stuck findings join the briefing
 * @returns {{ markdown: string, sequence: number, sections: { title: string, shown: number, total: number }[], bytes: number }}
 */
export function readDigest(file, { name = 'this project', now = new Date(), root, config, healthReport } = {}, ports) {
  const { openBoardReadOnly } = ports;
  if (!fs.exists(file)) throw new Refused('NO_BOARD', 'this repository has no board yet; run pullboard init in the main checkout first');
  const db = openBoardReadOnly(file);
  try {
    db.exec('BEGIN DEFERRED');
    const result = render(db, { name, now, root, config, healthReport }, ports);
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}

/**
 * Render the briefing from an open read-only connection inside one read transaction.
 *
 * @param {any} db
 * @param {{ name: string, now: Date, root?: string, config?: any }} options
 */
function render(db, { name, now, root, config, healthReport }, ports) {
  const { foreignBlockers, counterCaught, readCapacity, capacityLines, milestones, rowDrafts, rowDecisions, automaticDecisionSource, automaticSourceFromText, rigorDecisionKey, readAutomaticRigorSource } = ports;
  const cut = { count: 0 };
  const at = now.toISOString();
  /** One field of board text, bounded. */
  const text = (value, limit = 1_200) => line(value, limit, cut);
  const all = db.prepare('SELECT * FROM item ORDER BY item_id').all();
  /** An item's state as its reader means it: an expired claim is open again. */
  const state = (item) => (item.item_status === 'claimed' && (item.item_lease_until ?? '') <= at ? 'open' : item.item_status);
  const items = new Map(all.map((item) => [item.item_id, { ...item, state: state(item) }]));
  /** An item named by its title, with its number for pullboard show. */
  const label = (id) => {
    const item = items.get(id);
    return item ? `${text(item.item_title, 240)} (#${id})` : `an item this board no longer has (#${id})`;
  };
  const laneHolds = new Map(db.prepare('SELECT hold_lane, hold_reason FROM hold').all().map((row) => [row.hold_lane, row.hold_reason]));
  const open = [];
  const blocked = [];
  const review = [];
  for (const item of [...items.values()].sort((a, b) => b.item_updated_at.localeCompare(a.item_updated_at) || b.item_id - a.item_id)) {
    if (item.state === 'submitted') { review.push(item); continue; }
    if (!['open', 'claimed'].includes(item.state)) continue;
    const waits = [...localDependencyIds(item).filter((id) => items.get(id)?.state !== 'verified'),
      ...foreignBlockers({ db }, item).map(dependencyLabel)];
    const hold = item.item_hold_reason || laneHolds.get(item.item_lane);
    (hold || waits.length ? blocked : open).push({ ...item, waits, hold });
  }
  /** One open or blocked item with its bar, who holds it, and what it waits on. */
  const work = (item) => {
    const who = item.state === 'claimed' && item.item_owner ? `claimed by ${text(item.item_owner, 80)}` : 'open to claim';
    const lines = [`- ${label(item.item_id)}, in the ${text(item.item_lane, 60)} lane: ${who}.`,
      `  Done when: ${text(item.item_criterion || 'no bar is written yet.', 500)}`];
    if (item.hold) lines.push(`  Held: ${text(item.hold, 400)}`);
    if (item.waits.length) lines.push(`  Waits for: ${item.waits.slice(0, 6).map(id => typeof id === 'number' ? label(id) : text(id, 150)).join('; ')}${item.waits.length > 6 ? `; and ${item.waits.length - 6} more` : ''}.`);
    return lines.join('\n');
  };
  const landed = all.filter((item) => item.item_status === 'verified' && item.item_merged_commit).length;
  const accepted = all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit).length;

  const judged = `event_kind = 'row_decision' OR (event_kind = 'fact' AND json_valid(event_detail) AND json_extract(event_detail, '$.kind') IN (${JUDGEMENTS.map(() => '?').join(', ')}))`;
  const facts = db.prepare(`SELECT * FROM event WHERE ${judged} ORDER BY event_id DESC LIMIT ?`).all(...JUDGEMENTS, ROW_LIMIT);
  const answered = 'FROM shout reply JOIN shout ask ON ask.shout_id = reply.shout_answers WHERE ask.shout_decision = 1';
  const answers = db.prepare(`SELECT reply.*, ask.shout_text AS question, ask.shout_from AS asker ${answered} ORDER BY reply.shout_id DESC LIMIT ?`).all(ROW_LIMIT);
  const decisions = [
    ...facts.map((row) => {
      const detail = JSON.parse(row.event_detail);
      if (row.event_kind === 'row_decision') {
        const record = detail.record ?? {};
        const verb = record.decision === 'approve' ? 'approved' : 'declined';
        return { at: row.event_at, entry: `- ${text(row.event_by, 80)} ${verb} the ${text(record.kind, 20)} row ${text(record.id, 40)}, ${text(row.event_at, 40)}: ${text(record.text, 600)}${record.reason ? `\n  Reason: ${text(record.reason, 600)}` : ''}` };
      }
      return { at: row.event_at, entry: `- A ${text(detail.kind, 20)} on ${label(row.item_id)} by ${text(row.event_by, 80)}, ${text(row.event_at, 40)}:\n  ${text(detail.text, 500)}` };
    }),
    ...answers.map((row) => ({ at: row.shout_at, entry: `- ${text(row.shout_from, 80)} answered ${text(row.asker, 80)}, ${text(row.shout_at, 40)}.\n  Asked: ${text(row.question, 600)}\n  Answer and reason: ${text(row.shout_text, 500)}` })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const decisionTotal = Number(db.prepare(`SELECT count(*) AS n FROM event WHERE ${judged}`).get(...JUDGEMENTS).n)
    + Number(db.prepare(`SELECT count(*) AS n ${answered}`).get().n);

  const verdicts = db.prepare('SELECT * FROM verdict ORDER BY verdict_id DESC LIMIT ?').all(ROW_LIMIT).map((row) => {
    const verb = row.verdict_decision === 'ACCEPT' ? 'accepted' : 'rejected';
    const why = REASONS[row.verdict_reason] ? `${REASONS[row.verdict_reason]} (${row.verdict_reason})` : text(row.verdict_reason, 80);
    return `- ${label(row.item_id)} was ${verb} by ${text(row.verdict_by, 80)}, ${text(row.verdict_at, 40)}: ${why}.${row.verdict_note ? `\n  Note: ${text(row.verdict_note, 300)}` : ''}`;
  });
  const waiting = "FROM shout ask WHERE ask.shout_to = 'person' AND ask.shout_decision = 1 AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id)";
  const questions = db.prepare(`SELECT ask.* ${waiting} ORDER BY ask.shout_id LIMIT ?`).all(ROW_LIMIT).map((row) =>
    `- ${text(row.shout_from, 80)} asks, ${text(row.shout_at, 40)}: ${text(row.shout_text)}\n  Answer: pullboard answer ${row.shout_id} "<your answer>" --as person`);
  const shouts = db.prepare("SELECT * FROM shout WHERE shout_to = 'coordinator' ORDER BY shout_id DESC LIMIT ?").all(ROW_LIMIT).map((row) =>
    `- ${text(row.shout_from, 80)}, ${text(row.shout_at, 40)}: ${text(row.shout_text, 400)}`);

  let elsewhere = 0;
  const roadmap = milestones({ db }).map((milestone, order) => {
    const local = milestone.items.filter((id) => typeof id === 'number');
    elsewhere += milestone.items.length - local.length;
    const count = (test) => local.filter((id) => test(items.get(id))).length;
    const counts = [`${count((item) => item?.item_status === 'verified' && item.item_merged_commit)} landed`,
      `${count((item) => item?.item_status === 'verified' && !item.item_merged_commit)} accepted`,
      `${count((item) => item?.state === 'submitted')} in review`,
      `${count((item) => ['open', 'claimed'].includes(item?.state))} open`];
    const finished = local.length > 0 && count((item) => item?.item_status === 'verified') === local.length;
    const moved = count((item) => item && !['open', 'claimed'].includes(item.state) && item.item_status !== 'withdrawn') > 0;
    return { order, finished, entry: `- ${text(milestone.name, 200)}: ${finished ? 'finished' : moved ? 'in progress' : 'planned'}; ${local.length} items, ${counts.join(', ')}.${milestone.note ? `\n  ${text(milestone.note, 240)}` : ''}` };
  })
    // Releases still in progress come first, in roadmap order; then the most recently finished.
    .sort((a, b) => (a.finished - b.finished) || (a.finished ? b.order - a.order : a.order - b.order)).map((row) => row.entry);

  // The same findings as pullboard health, read in this transaction: what is stuck and who moves it.
  const health = root ? healthReport({ db, root, config, now }) : { stuck: [] };
  /** Who moves a stuck finding next, in plain words. */
  const owner = ({ role, who }) => (role === 'person' ? 'you' : role === 'coordinator' ? 'the coordinator' : who ? `${text(who, 80)} (${role})` : `a ${role}`);
  const stuck = health.stuck.map((entry) => `- ${entry.item ? label(entry.item) : text(entry.subject, 60)}: ${text(entry.title, 240)}, since ${text(entry.since, 40)}: ${text(entry.why, 400)}\n  Next, ${owner(entry.owner)}: ${text(entry.next, 300)}`);
  // What the board caught in the last month, from moves it already recorded; shown here and never pushed.
  const windowStart = new Date(now.getTime() - CAUGHT_DAYS * 86_400_000).toISOString();
  const caught = counterCaught({ db }, windowStart) ?? caughtFrom(db.prepare('SELECT * FROM event ORDER BY event_id').all(), db.prepare('SELECT * FROM verdict ORDER BY verdict_id').all(), windowStart);
  const caughtLabels = new Map(CAUGHT_KINDS.map(({ kind, label }) => [kind, label]));
  const caughtEntries = caught.entries.slice().reverse().map((entry) =>
    `- ${caughtLabels.get(entry.kind)}: ${entry.item === null ? 'no item' : label(entry.item)}, ${text(entry.at, 40)}: ${text(entry.text, 400)}`);
  const caughtCounts = CAUGHT_KINDS.map(({ kind, label: words }) => `${caught.counts[kind]} ${words}`).join('; ');
  const draftDecisions = rowDecisions({ db });
  const cadence = (config ?? (root ? loadConfig(root) : null))?.landing?.cadenceMs ?? 86_400_000;
  const draftDecisionContext = root && draftDecisions.length ? rowDecisionContext(root, config ?? loadConfig(root)) : null;
  const unansweredRigor = rowDrafts({ db }).filter(draft => {
    const source = automaticSourceFromText(draft.text);
    return source && now.getTime() - Date.parse(draft.at) >= cadence
      && !draftDecisions.some(record => (!draftDecisionContext || !staleRowDecision(record, draftDecisionContext))
        && record.kind === draft.target && (record.id === draft.id && automaticDecisionSource(record) === source
          || record.event > draft.event && rigorDecisionKey(record) === readAutomaticRigorSource(source).key));
  }).map(draft => `- Rigor draft ${text(draft.id, 40)}: ${text(draft.text.slice(0, draft.text.lastIndexOf(' Source: ')), 700)}\n  Unproved ${text(draft.target, 20)} proposal still waiting on the person; materialize with pullboard spec apply, then approve or decline.`);
  const capacity = readCapacity({ db }, now.getTime());
  const sections = [
    section('Stuck and who moves it', stuck, stuck.length, 4_000, 'Nothing is stuck.'),
    section('Open work', open.slice(0, ROW_LIMIT).map(work), open.length, 8_000, 'Nothing is open.'),
    section('Blocked work', blocked.slice(0, ROW_LIMIT).map(work), blocked.length, 6_000, 'Nothing is blocked.'),
    section('In review', review.slice(0, ROW_LIMIT).map((item) => `- ${label(item.item_id)}, built by ${text(item.item_built_by ?? item.item_owner, 80)}: waits for a second agent to verify it.`), review.length, 3_000, 'Nothing waits for review.'),
    section('Recent decisions and answers', decisions.map((row) => row.entry), decisionTotal, 7_000, 'No decisions are recorded yet.'),
    section('Recent verdicts', verdicts, Number(db.prepare('SELECT count(*) AS n FROM verdict').get().n), 5_000, 'No work has been verified yet.'),
    section('Questions waiting on you', questions, Number(db.prepare(`SELECT count(*) AS n ${waiting}`).get().n), 4_500, 'No question waits on you.'),
    section('Latest shouts to the coordinator', shouts, Number(db.prepare("SELECT count(*) AS n FROM shout WHERE shout_to = 'coordinator'").get().n), 3_000, 'No one has shouted the coordinator yet.'),
    section('Milestones', roadmap, roadmap.length, 4_000, 'No milestones are set.'),
    section(`What the board caught, last ${CAUGHT_DAYS} days`, caughtEntries, caught.total, 4_000, 'Nothing was caught in this window.'),
    section('Unanswered Rigor drafts', unansweredRigor, unansweredRigor.length, 2_000, 'No automatic draft is overdue.'),
    section('Capacity forecast', capacityLines(capacity), 1, 3_000, 'Capacity measurements are unavailable.'),
  ];
  // The per-kind counts sit under the heading, before the lines they count.
  if (caught.total) sections[9].text = sections[9].text.replace('\n\n', `\n\n${caughtCounts}.\n\n`);
  const sequence = Number(db.prepare('SELECT coalesce(max(event_id), 0) AS n FROM event').get().n);
  const glance = [
    `- ${landed} items landed and ${accepted} are accepted and wait to land.`,
    `- ${review.length} wait for review, ${open.length} are open and ${blocked.length} are blocked.`,
    `- ${sections[6].total} questions wait on you, and ${health.stuck.length} things are stuck.`,
  ].join('\n');
  const left = [
    ...sections.filter((entry) => entry.shown < entry.total).map((entry) => `- ${entry.title}: ${entry.shown} of ${entry.total} shown.`),
    `- ${cut.count} long texts were cut short, and any entry that looks like it holds a secret reads [redacted secret].`,
    `- ${elsewhere} milestone items from other boards were left out; this briefing covers this board only.`,
    '- Older history, finished work, code and full conversations stay on the board: pullboard show <number> prints any item.',
  ].join('\n');
  const markdown = `# Board briefing: ${text(name, 200)}\n\nRead from this project's board at ${at}, through board move ${sequence}. Making it changed nothing on the board.\n\n## At a glance\n\n${glance}\n\n${sections.map((entry) => entry.text).join('')}## Left out of this briefing\n\n${left}\n`;
  const bytes = Buffer.byteLength(markdown);
  // The section budgets sum well under the cap, so this refusal marks a bug in those budgets.
  if (bytes >= DIGEST_MAX_BYTES) throw new Refused('DIGEST_SIZE', 'the briefing outgrew its 50 KB budget; shout the coordinator with the board size so the budgets get fixed');
  return { markdown, sequence, bytes, capacity, sections: sections.map(({ title, shown, total }) => ({ title, shown, total })) };
}

/**
 * The output path, refused inside Git metadata (where the board lives) or onto an SQLite file,
 * so a typo can never replace the board with a briefing. Symlinked directories are resolved first.
 *
 * @param {string} path
 * @param {string} commonDir
 * @returns {string}
 */
function outputPath(path, commonDir) {
  const target = resolve(path);
  let parent;
  try { parent = fs.realpath(dirname(target)); }
  catch { throw new Refused('DIGEST_WRITE', `the folder for ${target} does not exist; create it or choose another --out file`); }
  const canonical = join(parent, basename(target));
  const inside = relative(fs.realpath(commonDir), canonical);
  if (basename(canonical) === '.git' || !inside || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) {
    throw new Refused('DIGEST_WRITE', 'the board lives in .git; choose an --out file outside it, such as briefing.md');
  }
  if (fs.exists(canonical) && fs.stat(canonical).isFile()) {
    const fd = fs.open(canonical, 'r');
    try {
      const head = Buffer.alloc(16);
      if (fs.read(fd, head, 0, 16, 0) === 16 && head.toString() === 'SQLite format 3\0') {
        throw new Refused('DIGEST_WRITE', `${canonical} is a database; choose a Markdown --out file, such as briefing.md`);
      }
    } finally { fs.close(fd); }
  }
  return canonical;
}

/**
 * Replace the chosen file atomically: write a private temporary file beside it, flush it, then
 * rename it over the target, so a reader sees the old briefing or the new one and never half.
 *
 * @param {string} path
 * @param {string} markdown
 * @param {string} commonDir
 * @returns {string} the file written
 */
export function writeDigest(path, markdown, commonDir) {
  const target = outputPath(path, commonDir);
  const temporary = join(dirname(target), `.pullboard-digest-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.open(temporary, 'wx', 0o600);
    fs.writeFile(fd, markdown);
    fs.fsync(fd);
    fs.close(fd);
    fd = undefined;
    fs.rename(temporary, target);
    return target;
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused('DIGEST_WRITE', `could not write ${target}; choose a writable --out file and run pullboard digest again`);
  } finally {
    if (fd !== undefined) fs.close(fd);
    fs.rm(temporary, { force: true });
  }
}

/**
 * Rewrite the briefing after every board move until `signal` aborts. SQLite's data_version
 * changes when another connection commits, including WAL writes, so polling it is cheap and the
 * watcher holds no transaction between reads.
 *
 * @param {string} file
 * @param {string} path
 * @param {{ name: string, root?: string, config?: any, healthReport?: Function, commonDir: string, signal: AbortSignal, interval?: number, onWrite?: (result: any) => void }} options
 */
export async function watchDigest(file, path, { name, root, config, healthReport, commonDir, signal, interval = 250, onWrite = () => {} }, ports) {
  const { openBoardReadOnly } = ports;
  let db;
  let identity;
  let seen = -1;
  try {
    while (!signal.aborted) {
      const stat = fs.stat(file);
      const current = `${stat.dev}:${stat.ino}`;
      if (current !== identity) {
        // A restored or replaced board file gets a fresh connection.
        db?.close();
        db = openBoardReadOnly(file);
        identity = current;
        seen = -1;
      }
      const version = db.prepare('PRAGMA data_version').get().data_version;
      if (version !== seen) {
        const result = readDigest(file, { name, root, config, healthReport }, ports);
        onWrite({ ...result, path: writeDigest(path, result.markdown, commonDir) });
        seen = version;
      }
      try { await pause(interval, undefined, { signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  } finally { db?.close(); }
}

/**
 * The digest command: print the briefing, write it with --out, or keep it current with --watch.
 *
 * @param {any} io
 * @param {{ first?: string, second?: string, rest: string[], values: Record<string, any> }} args
 * @param {{ info: { root: string, commonDir: string }, config: { name?: string }, file: string }} ctx
 * @param {{healthReport: Function}} services Actual upper-layer health observation bound to dispatch.
 * @returns {Promise<number>}
 */
export async function digestCommand(io, { first, second, rest, values }, ctx, ports) {
  const { healthReport } = ports;
  const usage = 'pullboard digest [--out <file>] [--watch]; --watch needs --out';
  if (first || second || rest.length || Object.keys(values).some((key) => !['out', 'watch', 'json'].includes(key))) throw new Refused('USAGE', usage);
  if (values.out === '' || (values.watch && (!values.out || values.json))) throw new Refused('USAGE', usage);
  const name = ctx.config.name;
  const out = values.out === undefined ? undefined : resolve(io.cwd, values.out);
  if (values.watch) {
    const controller = new AbortController();
    /** Stop watching on Ctrl-C or a termination signal; the board is left as it was. */
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await watchDigest(ctx.file, out, { name, root: ctx.info.root, config: ctx.config, healthReport, commonDir: ctx.info.commonDir, signal: controller.signal,
        onWrite: (result) => io.say(`wrote the briefing to ${result.path} (board move ${result.sequence}); Ctrl-C stops watching`) }, ports);
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return 0;
  }
  // The command's clock is the reading time, so a fixture that holds the clock reads the window it set up.
  const result = readDigest(ctx.file, { name, now: io.clock?.now?.() ?? new Date(), root: ctx.info.root, config: ctx.config, healthReport }, ports);
  const path = out === undefined ? undefined : writeDigest(out, result.markdown, ctx.info.commonDir);
  io.result?.({ capacityForecast: result.capacity, markdown: result.markdown, bytes: result.bytes, sequence: result.sequence, sections: result.sections, ...(path ? { path } : {}) });
  io.say(path ? `wrote the briefing to ${path}; share that file with any chat assistant` : result.markdown.trimEnd());
  return 0;
}
