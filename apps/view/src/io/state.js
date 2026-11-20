/**
 * The project state the view and the needs reader read: projectState with its row-age, derived-field and runner helpers,
 * in a module that loads no server, so a reader of the state never loads the view's HTTP surface [C7].
 */
import { projectItemState } from '../../../../packages/api/index.js';
import * as store from "../../../../packages/store/index.js";
import { landingPace } from '../../../../packages/roadmap/index.js';
import { milestoneFocus } from '../../../../packages/roadmap/index.js';
import { dashboardRecent } from './dashboard/recent.js';
import { boardCounts } from '../logic/counts.js';
import { firstLandings } from '../logic/counts.js';
import { withReadySplit } from '../logic/counts.js';
import { existsSync } from 'node:fs';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { isMainThread } from 'node:worker_threads';
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { releaseHeadlinesBetween } from '../../../../packages/config/index.js';
import { VERSION } from '../../../../packages/config/index.js';
import { COORDINATOR } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { displayAgentName } from '../../../../packages/seats/index.js';
import { doctrineHistory } from '../../../../packages/doctrine/index.js';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import { standardDoctrine } from '../../../../packages/doctrine/index.js';
import { codeIsFromMain } from '../../../../packages/git/index.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { resolveCommit } from '../../../../packages/git/index.js';
import { committedIds } from '../../../../packages/store/index.js';
import { openBoardForRead } from '../../../../packages/store/index.js';
import { productSummaries } from '../../../../packages/spec/index.js';
import { personNeeds } from '../../../../packages/spec/index.js';
import { projectRowDecisions } from '../../../../packages/spec/index.js';
import { projectSpecRevisions } from '../../../../packages/spec/index.js';
import { loadSpec } from '../../../../packages/spec/index.js';
import { gateFiles } from '../../../../packages/spec/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { rigorDraftNeeds } from '../../../../packages/rigor/index.js';
import { sentinelDraftNeeds } from '../../../../packages/sentinels/index.js';
import { sentinels } from '../../../../packages/sentinels/index.js';
import { publicLiveRunners } from './live/read.js';
import { readGateJobs } from './dashboard/gates.js';

/** The machine's runner and gate lease records, beside its settings file: one place names it, for the Dashboard's runners and the Pipeline page. */
export function machineResourcesFile() { return join(dirname(machineSettingsFile()), 'resources.sqlite'); }

/**
 * The anonymous runner progress /live/data.json carries for this repo's board: Runner 1..N, kinds, item ids, counts,
 * per-file state and minutes left, from this machine's runner leases and settings; nothing that names the machine [N26].
 *
 * @param {string} root
 * @param {{ now?: number, registeredOnly?: boolean }} [options] - registeredOnly: the Dashboard's own read, which lists the registered runners only (#8060).
 */
export function publicLiveSnapshot(root, { now = Date.now(), registeredOnly = false } = {}) {
  const { commonDir } = repoInfo(root);
  const board = openBoardForRead(store.boardFilePath(commonDir));
  if (!board) throw new Refused('NO_BOARD', 'no readable board to export; run pullboard init in this repo');
  let privateBoard;
  try { privateBoard = Boolean(board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key = ?').get('private_repo_board_id')); } finally { store.closeBoard(board); }
  // The machine's runner leases sit beside its settings file, in the machine home.
  return publicLiveRunners(commonDir, { resources: machineResourcesFile(), configured: loadMachineSettings().runners ?? [],
    openBoardReadOnly: store.openBoardReadOnly, now, privateBoard, registeredOnly, jobsFor: runsJobs });
}

/**
 * The handle that holds a board's job rows for a read: a read-only runs handle when the board's runs_store flag is on and its
 * runs file exists, else the board itself [B2,P7]. Why: with the split on, runner traffic no longer writes the board's job table (#9016).
 *
 * @param {import('node:sqlite').DatabaseSync} db - A board, read-only.
 * @param {string} boardFile
 * @returns {{ jobs: import('node:sqlite').DatabaseSync, close: () => void }}
 */
export function runsJobs(db, boardFile) {
  let on = false;
  try { on = store.runsStoreOn(db); } catch { /* A board with no board_meta reads off. */ }
  const file = store.runsFilePath(boardFile);
  if (!on || !existsSync(file)) return { jobs: db, close() {} };
  const runs = store.openBoardReadOnly(file);
  return { jobs: runs, close() { try { runs.close(); } catch { /* Already closed. */ } } };
}

/** The job-table count behind finishedRuns, kept as one string so a test can read its query plan [C7]. */
export const FINISHED_JOBS_SQL = "SELECT job_kind AS kind, COUNT(*) AS n FROM job WHERE job_step = 'done' AND job_updated > ? GROUP BY job_kind";

/**
 * How many pulled jobs finished on this board in the last four hours, by what the Dashboard's runner card names them:
 * gates, landings and tests. Why: the card lists runs in flight, so an idle runner that just ran nine jobs read "No runs" (#7945).
 *
 * @param {string} commonDir - The board's git common folder.
 * @param {number} now - The snapshot clock in milliseconds.
 * @returns {{ gate: number, landing: number, test: number }}
 */
export function finishedRuns(commonDir, now) {
  const count = { gate: 0, landing: 0, test: 0 };
  const file = store.boardFilePath(commonDir);
  let db = null;
  try {
    if (!existsSync(file)) return count;
    db = store.openBoardReadOnly(file);
    // With runs_store on, outcomes are the board's run rows; the job tables are in the runs file (#9016).
    const split = (() => { try { return store.runsStoreOn(db); } catch { return false; } })();
    const rows = split
      ? db.prepare("SELECT run_kind AS kind, COUNT(*) AS n FROM run WHERE run_state = 'done' AND run_updated > ? GROUP BY run_kind").all(now - 4 * 3_600_000)
      : db.prepare(FINISHED_JOBS_SQL).all(now - 4 * 3_600_000);
    for (const { kind, n } of rows) {
      const key = { gate: 'gate', 'gate-shard': 'gate', land: 'landing', landing: 'landing', test: 'test', 'main-test': 'test' }[kind];
      if (key) count[key] += Number(n);
    }
  } catch { /* A board with no job table or no readable file has finished nothing to show. */ } finally { try { db?.close(); } catch { /* Already closed. */ } }
  return count;
}

/** The last runner read per board, so a burst of state reads opens the machine's lease records once. */
const runnerReads = new Map();

/**
 * The Dashboard's runner card (#6847): the same anonymous runner progress /live/data.json carries, read at most once
 * every fifteen seconds per board. A machine with no runner records, or one that cannot be read now, shows none.
 *
 * @param {string} root - The board's checkout root.
 * @param {string} commonDir - The board's git common folder, which keys the kept read.
 * @param {number} now - The snapshot clock in milliseconds.
 * @returns {{ runners: object[], runs: object[] } | null}
 */
function dashboardRunners(root, commonDir, now) {
  const kept = runnerReads.get(commonDir);
  if (kept && now >= kept.at && now - kept.at < 15_000) return kept.value;
  let value = null;
  try { value = publicLiveSnapshot(root, { now, registeredOnly: true }); } catch { value = null; }
  // The person's own page names each registered runner (the host without its user) and marks one with no fresh heartbeat offline (#8060).
  if (value) {
    const names = [...new Set((loadMachineSettings().runners ?? []).map(runner => runner?.host).filter(host => typeof host === 'string'))].map(host => host.replace(/^.*@/u, ''));
    value = { ...value, runners: value.runners.map(runner => ({ ...runner, name: names[runner.runner - 1] ?? null, offline: runner.cpu === null && runner.ram === null })) };
  }
  // The runs already done sit beside those in flight, so a runner that ran jobs never reads as one that ran none (#7945).
  if (value) value = { ...value, finished: finishedRuns(commonDir, now), gates: readGateJobs(store.boardFilePath(commonDir), now, { open: store.openBoardReadOnly, jobsFor: runsJobs }) };
  runnerReads.set(commonDir, { at: now, value });
  return value;
}

/**
 * Open a project's board using running-source migration authority, or borrow a staged connection.
 *
 * @template T
 * @param {string} root
 * @param {(board: any, info: any, config: any) => T} read
 * @param {any | null} [providedBoard] Borrow a staged connection without closing it.
 * @returns {T}
 */
function withProject(root, read, providedBoard = null, boardOpeners) {
  if (!providedBoard && typeof boardOpeners?.openBoard !== 'function') throw new Refused('VIEW_SERVICE_REQUIRED', 'the view projection needs its caller to provide openBoard; use the CLI view composition or pass the actual service');
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const board = providedBoard ?? boardOpeners.openBoard(store.boardFilePath(info.commonDir), undefined, { isMain: codeIsFromMain() });
  try {
    return read(board, info, config);
  } finally {
    if (!providedBoard) store.closeBoard(board);
  }
}

/**
 * How new each row of the spec and doctrine files is, by the commit that added it, and the one commit both were read at
 * (see computeRowAges). A row on disk but not yet committed is missing here, and the state counts it 0, newer than any.
 * Walking a file's history is the slowest read behind a state, so the pair is kept until HEAD moves. With `later`, as
 * the view server asks, a project's first read never walks: it answers no pair (at null) and worker threads
 * refresh both files for HEAD, kept only once both finish, so the next read has them; once a pair is kept, a read
 * after HEAD moves walks again, so it never names the previous commit. Why a pair: the page orders spec
 * and doctrine rows together, so both lists name one capture even when HEAD moves while a worker reads; and HEAD moves
 * on every landing, where a walk of SPEC.md on a long-lived repo costs seconds that the board's first paint cannot wait for.
 *
 * @param {string} root
 * @param {{ spec: string, doctrine: string }} files
 * @param {string | null} head The one commit captured for this project's state.
 * @param {{ later?: boolean }} [options]
 * @returns {{ spec: Map<string, number>, doctrine: Map<string, number>, at: string | null }}
 */
function rowAges(root, files, head, { later = false } = {}) {
  const key = root + '\0' + files.spec + '\0' + files.doctrine, kept = agesKept.get(key);
  if (kept && kept.at === head) return kept;
  // A pair kept for an older commit is never answered: the page would show ages that name the previous commit, so a
  // read after a new commit walks once (the first read of a project, with nothing kept, is the one that goes later).
  if (!later || !head || kept) {
    const fresh = { spec: computeRowAges(root, files.spec, head, 'spec'), doctrine: computeRowAges(root, files.doctrine, head, 'doctrine'), at: head };
    agesKept.set(key, fresh);
    return fresh;
  }
  if (!agesRefreshing.has(key)) {
    agesRefreshing.add(key);
    Promise.all([rowAgesInWorker(root, files.spec, head, 'spec'), rowAgesInWorker(root, files.doctrine, head, 'doctrine')]).then(([spec, doctrine]) => {
      agesRefreshing.delete(key);
      if (spec && doctrine) agesKept.set(key, { spec, doctrine, at: head });
    });
  }
  return { spec: new Map(), doctrine: new Map(), at: null };
}
/** The history readers by name, so a worker thread can be told which one to run. */
const HISTORIES = { spec: committedIds, doctrine: doctrineHistory };

/**
 * Walk `file`'s history up to `head` and give each committed row id its age: 1 for a row the newest commit
 * to touch the file added, 2 for the commit before, and so on.
 *
 * @param {string} root
 * @param {string} file
 * @param {string | null} head
 * @param {'spec' | 'doctrine'} kind
 * @returns {Map<string, number>}
 */
function computeRowAges(root, file, head, kind) {
  if (!head) return new Map();
  const log = spawnSync('git', ['log', '--follow', '--format=%H', head, '--', file], { cwd: root, encoding: 'utf8' });
  const place = new Map((log.status === 0 ? log.stdout : '').split('\n').filter(Boolean).map((commit, n) => [commit, n + 1]));
  return new Map([...HISTORIES[kind](root, file, [head]).ids].map(([id, commit]) => [id, place.get(commit) ?? place.size + 1]));
}

/**
 * Compute the ages in a worker thread running this module, so the walk never blocks the view's requests.
 * A failed worker resolves to null and the caller keeps what it had.
 * Why execArgv is empty: a worker inherits the parent's flags, and under `node --input-type=module -e` those cannot start a file worker.
 *
 * @param {string} root
 * @param {string} file
 * @param {string} head
 * @param {'spec' | 'doctrine'} kind
 * @returns {Promise<Map<string, number> | null>}
 */
function rowAgesInWorker(root, file, head, kind) {
  return new Promise(done => {
    let worker;
    try { worker = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { rowAges: { root, file, head, kind } } }); }
    catch { done(null); return; }
    worker.once('message', rows => done(new Map(rows)));
    worker.once('error', () => done(null));
    worker.once('exit', () => done(null));
  });
}

if (!isMainThread && workerData?.rowAges?.kind in HISTORIES) {
  const { root, file, head, kind } = workerData.rowAges;
  parentPort.postMessage([...computeRowAges(root, file, head, kind)]);
}

/** @type {Map<string, { spec: Map<string, number>, doctrine: Map<string, number>, at: string | null }>} */
const agesKept = new Map();
/** The file pairs whose ages worker threads are reading now, so one read at a time runs for each. */
const agesRefreshing = new Set();

let keptViewReleaseNotes;
/** Lazily read the immutable release note summary once for this view process. */
function viewReleaseNotes() {
  if (!keptViewReleaseNotes) {
    keptViewReleaseNotes = {
      version: VERSION,
      releases: releaseHeadlinesBetween('0.0.0', VERSION),
      notes: 'https://github.com/pullboard-dev/pullboard/blob/main/CHANGELOG.md',
    };
  }
  return { ...keptViewReleaseNotes, releases: keptViewReleaseNotes.releases.map((release) => ({ ...release })) };
}

/**
 * Observe actual repository files named by a Doctrine gate without treating prose as a path.
 * @param {string} root
 * @param {string} head
 * @param {string | undefined} gate
 * @returns {{ file: string, exists: boolean, ref: string | null }[]}
 */
function doctrineGateFiles(root, head, gate) {
  return gateFiles(gate).map((file) => {
    const path = resolve(root, file);
    const inside = !isAbsolute(file) && !relative(root, path).split(/[\\/]/u).includes('..');
    let exists = false;
    try { exists = inside && statSync(path).isFile(); } catch { /* Missing test files stay visible as absent observations. */ }
    return { file, exists, ref: exists && head ? file + ':1@' + head : null };
  });
}

/**
 * Everything the page shows for one project. Given the newest shout the person has seen there,
 * it also counts every shout since, which the forty it sends cannot always show. An itemProjector
 * lets a caller that keeps its own item projections reuse them: it is called once per item, in
 * order, and returns that item's projection, calling project() for a fresh one only when it has none.
 *
 * @param {string} root
 * @param {{ seen?: number | null, board?: any, itemProjector?: ((item: any, context: { board: any, status: Map<number, string>, project: () => any }) => any) | null }} [options]
 *   A supplied board stays owned by its caller.
 * @returns {any}
 */
export function projectState(root, { seen = null, board: providedBoard = null, itemProjector = null, boardOpeners, rowAgesLater = false } = {}) {
  return withProject(root, (board, info, config) => {
    const all = store.listItems(board, { all: true });
    const status = new Map(all.map((item) => [item.item_id, item.item_status]));
    // Both row lists and their cached ages name this commit even if HEAD moves between Git reads.
    const head = resolveCommit(info.root, 'HEAD');
    const doctrine = loadDoctrine(info.root, config);
    // A standard rule was never added to this repo, so it has no age here; the repo's own rows have.
    const ages = rowAges(info.root, { spec: config.spec, doctrine: doctrine.name }, head, { later: rowAgesLater });
    const specAges = { ages: ages.spec, at: ages.at }, doctrineAges = { ages: ages.doctrine, at: ages.at };
    const now = board.clock.now().getTime();
    const marker = derivedMarker(board, info.root, [config.spec, doctrine.name], [head, specAges.at, doctrineAges.at, Math.floor(now / 60_000), JSON.stringify(config)]);
    const kept = derivedKept.get(info.root);
    const derived = kept?.marker === marker ? kept.derived : derivedState(board, info, config, { all, head, doctrine, specAges, doctrineAges, now });
    derivedKept.set(info.root, { marker, derived });
    const lastMove = derived.lastMove;
    const fields = derived.fields;
    // The keys keep the order the page and the exported snapshot have always had.
    const state = projectRowDecisions(derived.rowDecisions, {
      root: info.root,
      releaseNotes: viewReleaseNotes(),
      rowAgesAt: { [config.spec]: specAges.at, [doctrine.name]: doctrineAges.at },
      lanes: fields.lanes,
      owning: fields.owning,
      // A caller with its own copy of an item returns it; project() builds the item only when asked.
      items: all.map((item) => (itemProjector
        ? itemProjector(item, { board, status, project: () => projectItemState(board, item, status) })
        : projectItemState(board, item, status))),
      shouts: fields.shouts,
      decisions: fields.decisions,
      decisionQueue: fields.decisionQueue,
      asked: fields.asked,
      events: fields.events,
      dashboardNext: fields.dashboardNext,
      // Pace windows end on exact milliseconds, so they are read at this clock and never kept with the minute-marked fields.
      dashboardPace: landingPace(board, new Map(all.map(item => [item.item_id, item])), now, store),
      // The hero's four-hour counts, so a board whose full history the browser never finishes reading still shows numbers.
      dashboardRecent: dashboardRecent(board, new Map(all.map(item => [item.item_id, item])), now),
      dashboardLanded: fields.dashboardLanded,
      // The Dashboard's Runners card: this machine's runners, numbered and anonymous as on /live (#6847).
      dashboardRunners: dashboardRunners(info.root, info.commonDir, now),
      landingBatches: fields.landingBatches,
      agents: store.listAgents(board).map((agent) => ({ ...agent, family: agent.family, model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, config.agents.names), lastMoveAt: lastMove.get(agent.agent_id) ?? null })),
      holds: fields.holds,
      itemHolds: fields.itemHolds,
      spec: fields.spec,
      practice: fields.practice,
      unseen: seen === null ? null : { since: seen, count: board.db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_id > ?').get(seen).n },
      products: fields.products,
    });
    const projected = projectSpecRevisions({ ...state, ...derived.late }, derived.rowDrafts, derived.rowDecisions);
    const read = { ...projected, needs: personNeeds(projected) };
    // One number in one place: every page reads these counts, never its own (#7310).
    const counts = boardCounts(read, now);
    // Release and Roadmap read the same ready definition NOW does (#7763).
    return withReadySplit({ ...read, counts });
  }, providedBoard, boardOpeners);
}

/**
 * The items whose current merge was recorded in the last 24 hours, each with its commit: what the Dashboard's landing
 * bars and lists match against its events. The older landings are not listed; the page counts them from its items.
 *
 * @param {any} board
 * @param {any[]} all Every item row.
 * @param {number} now
 * @returns {{ id: number, commit: string, at: number }[]}
 */
function recentLandings(board, all, now) {
  const landed = new Map(all.filter(item => item.item_merged_commit).map(item => [item.item_id, item.item_merged_commit]));
  return firstLandings(landed, store.eventsOfKinds(board, ['merged'])).filter(entry => entry.at > now - 24 * 3_600_000);
}

/**
 * Everything in a project's state that only the board's recorded history, HEAD, the spec and doctrine files and the
 * minute decide: every field but the items, the agents and the unseen count. projectState keeps it while
 * derivedMarker is unchanged, so a read after an agent heartbeat or lease renewal rebuilds only what moved.
 *
 * @param {any} board
 * @param {{ root: string }} info
 * @param {any} config
 * @param {{ all: any[], head: string | null, doctrine: any, specAges: { ages: Map<string, number> }, doctrineAges: { ages: Map<string, number> }, now: number }} reads
 * @returns {{ fields: object, late: object, lastMove: Map<string, string>, rowDecisions: any[], rowDrafts: any[] }}
 */
function derivedState(board, info, config, { all, head, doctrine, specAges, doctrineAges, now }) {
  const rows = (file, ages) => loadSpec(info.root, { ...config, spec: file }).rows.map(({ id, status: state, tier, text, gate, serves, section }) => ({
    id, status: state, tier, text: store.readableRigorText(text), gate, serves, section, added: ages.get(id) ?? 0,
    gateFiles: gate ? gate.split(',').map(value => value.trim()).filter(Boolean).map(name => {
      const path = resolve(info.root, name);
      const inside = !isAbsolute(name) && !relative(info.root, path).split(/[\\/]/u).includes('..');
      let exists = false;
      try { exists = inside && statSync(path).isFile(); } catch { /* A missing gate is visible evidence, not a failed board read. */ }
      return { file: name, exists, ref: exists && head ? name + ':1@' + head : null };
    }) : [],
  }));
  // A decline's text is its reason. Keep the inherited rule available so the page strikes the
  // rule itself, while showing the repo's reason beside it.
  const inherited = new Map(standardDoctrine().rows.map((row) => [row.id, row.text]));
  const rowDecisions = store.rowDecisions(board), rowDrafts = store.rowDrafts(board);
  const spec = loadSpec(info.root, config);
  const fields = {
    lanes: [COORDINATOR, ...Object.keys(config.lanes)],
    // The lanes that own folders, where builders work; review lanes own none.
    owning: Object.keys(config.lanes).filter((lane) => (config.lanes[lane].owns ?? []).length > 0),
    shouts: store.recentShouts(board, 40),
    // Every ask still waiting for an answer, however far back the forty shouts reach (B21): the
    // person's to answer here, and the rest with who holds them (B26).
    decisions: store.openDecisions(board, store.PERSON),
    decisionQueue: store.openDecisions(board, COORDINATOR),
    asked: store.openDecisions(board).filter((ask) => ask.shout_to !== store.PERSON),
    events: store.recentEvents(board, 80),
    dashboardNext: [...all].filter(item => item.item_status === 'open').sort(store.buildOrder(board)).map(item => item.item_id),
    // Only the landings the Dashboard draws (the last 24 hours): every older landing is an item whose stage the page already holds (#6666).
    dashboardLanded: recentLandings(board, all, now),
    landingBatches: store.landingBatches(board).filter(batch => !['landed', 'blocked'].includes(batch.state))
      .map(batch => ({ startedAt: batch.startedAt, items: (batch.items || []).map(entry => ({ id: entry.id })) })),
    holds: store.laneHolds(board),
    // Each item held on its own, with its reason, so every list can say why it is not moving (#1256).
    itemHolds: all.filter((item) => item.item_hold_reason).map((item) => ({ item: item.item_id, reason: item.item_hold_reason, by: item.item_hold_by, at: item.item_hold_at })),
    spec: rows(config.spec, specAges.ages),
    practice: doctrine.rows.map(({ id, status: state, tier, text, gate, serves, section, origin, version, reason }) => ({
      id, status: state, tier, text, gate, serves, section, origin, version, reason,
      standardVersion: inherited.has(id) ? doctrine.version : null, overrides: origin === 'repo' && inherited.has(id), added: origin === 'standard' ? null : doctrineAges.ages.get(id) ?? 0,
      gateFiles: doctrineGateFiles(info.root, head, gate),
      ...(state === 'wont' && inherited.has(id) ? { standardText: inherited.get(id) } : {}),
    })),
    // Each product's progress, counted as pullboard status counts it (N28).
    products: productSummaries(config, spec, all),
  };
  // Pending person decisions govern the calls on the API, sealed relay and exported page alike.
  const rigorRows = projectRowDecisions(rowDecisions, { root: info.root, spec: spec.rows, practice: doctrine.rows });
  const focus = milestoneFocus(board, { milestones: store.milestones });
  const late = { focusMilestone: focus ? { name: focus.name, items: [...focus.ids] } : null, rigorDrafts: rigorDraftNeeds(rigorRows, rowDrafts, rowDecisions), sentinelDrafts: sentinelDraftNeeds(sentinels(board)) };
  return { fields, late, lastMove: store.lastMoves(board), rowDecisions, rowDrafts };
}

/**
 * A cheap marker of everything derivedState reads: the board's id, the newest event, shout and verdict, the holds, the item count and
 * newest id, each named file's size and times, and the caller's own parts (HEAD, row-age heads, the minute, config).
 * Why these: every board move records an event in the same transaction, so a read that sees the same newest event saw
 * the same items, settings, milestones and batches; shouts, verdicts and holds have their own tables, a hold's row is
 * replaced in place, and total_changes() catches any write made on the reading connection itself, raw or not.
 *
 * @param {any} board
 * @param {string} root
 * @param {string[]} files
 * @param {any[]} parts
 * @returns {string}
 */
function derivedMarker(board, root, files, parts) {
  const row = board.db.prepare(`SELECT (SELECT meta_value FROM board_meta WHERE meta_key = 'board_id') AS board, (SELECT MAX(event_id) FROM event) AS event, (SELECT MAX(shout_id) FROM shout) AS shout,
    (SELECT COUNT(*) || ':' || MAX(rowid) FROM verdict) AS verdict,
    (SELECT group_concat(hold_lane || char(31) || hold_reason || char(31) || hold_by || char(31) || hold_at, char(30)) FROM hold) AS hold, total_changes() AS written,
    (SELECT COUNT(*) || ':' || MAX(item_id) FROM item) AS item`).get();
  const stats = files.map(file => {
    try { const stat = statSync(resolve(root, file)); return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]; } catch { return null; }
  });
  return JSON.stringify([row, stats, parts]);
}
/** @type {Map<string, { marker: string, derived: ReturnType<typeof derivedState> }>} */
const derivedKept = new Map();
