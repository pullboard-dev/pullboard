/**
 * Every landing is one runner land job: accept offers it, and `pullboard land` and `land <ids> --forced` offer the same
 * kind; a runner merges, checks and pushes trunk with compare-and-swap, and its receipt marks the items merged. This
 * host merges nothing and runs no landing batch. With trunk.remote set this holds in any gate.runnerDispatch mode
 * (#5864). With trunk.remote empty the trunk is the board host's own repository, which only a runner on this host
 * reaches, so the job needs the local runner's board-host capability; that path stays behind pull until L6 [P7].
 */
import { isAbsolute } from 'node:path';
import { resolve } from 'node:path';
import { offerLandingJob } from '../../../../../packages/api/index.js';
import { openLandingJob } from '../../../../../packages/api/index.js';
import { queueFor } from '../../../../../packages/api/index.js';
import { sprintLandable } from '../../../../../packages/api/index.js';
import { configTrunkRemote } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { fencedHopEnabled } from '../../../../../packages/config/index.js';
import { hunkFreshnessEnabled } from '../../../../../packages/config/index.js';
import { submitComposeAsObject } from '../../../../../packages/config/index.js';
import { adaptiveBatchEnabled } from '../../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { unverifiedSubmissions } from '../../../../../packages/store/index.js';
import { stepAsideCount } from '../../../../../packages/store/index.js';
import { recordedWriteLock } from '../../../../../packages/store/index.js';
import { testResults } from '../../../../../packages/store/index.js';
import { lineSettings } from '../../../../../packages/store/index.js';
import { itemPace } from '../../../../../packages/store/index.js';
import { pullingLanding } from '../../../../../packages/store/index.js';
import { redNow } from '../../../../../packages/gate/heavy.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { mechanicalConflictFiles } from '../../../../../packages/landing/index.js';
import { checkLandingMessages } from '../../../../../packages/landing/index.js';
import { landingContext } from '../../../../../packages/landing/index.js';
import { withoutStaleVerdicts } from '../../../../../packages/landing/index.js';
import { requirePublishGreen } from '../../../../../packages/landing/index.js';
import { publishRedTouched } from '../../../../../packages/landing/index.js';
import { landingChangedFiles } from '../../../../../packages/landing/index.js';
import { relandAcceptedItems } from '../../../../../packages/landing/index.js';
import { carryLandingHops } from '../../../../../packages/landing/index.js';
import { landingMainReds } from '../../../../../packages/landing/index.js';
import { startGroup } from '../../../../../packages/landing/index.js';
import { parallelGatesEnabled } from '../../../../../packages/config/index.js';
import { derivedStateEnabled } from '../../../../../packages/config/index.js';
import { landingPriorityCompare } from '../../../../../packages/landing/index.js';
import { ordered } from '../../../index.js';
import { withBoard } from '../context.js';
import { BOARD_HOST } from '../runner/local.js';
import { ensureLocalRunner } from '../runner/local.js';
import { wakeRunnerForOffer } from '../runner/local.js';
import { pullGit } from '../runner/git.js';
import { landingShardGate } from '../submit/pull.js';
import { openLandJobs } from './waiting.js';
import { batchCap } from './adaptive.js';
import { trunkCheckedOut } from './checkout.js';

const TRUNK = 'refs/heads/main';

/**
 * The ref a land job lands onto: the primary checkout's own branch, whatever it is named, else main. Why: a repository
 * whose trunk is master or trunk must land there; a hard-coded main made the runner's fetch refuse every such offer [B34,C7].
 */
function trunkRef(root) {
  const branch = mainCheckout(root)?.branch;
  return typeof branch === 'string' && branch ? (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`) : TRUNK;
}

/**
 * Each item id's newest accept event id, the landing offer's accept order [C7,#11381].
 * Why: with health.derivedState on and the table current for main, the sweep already holds this order, so the offer reads it and runs no GROUP BY scan of accept events;
 * a table swept at another commit, the setting off, or a wanted item the table has no row for (accepted after the sweep) all scan exactly as before.
 * The health cell loads only with the setting on, so the offer's cold path is unchanged with it off.
 *
 * @param {string} root
 * @param {any} board
 * @param {number[]} wantedIds The accepted items the offer will order.
 * @param {{ enabled?: boolean, mainCommit?: string | null }} [options] The health.derivedState setting, read from machine settings by default, and the main commit to read the table at (a test seam; main's tip by default).
 * @returns {Promise<Map<number, number>>}
 */
export async function acceptOrderOf(root, board, wantedIds, { enabled = derivedStateEnabled(), mainCommit = null } = {}) {
  if (enabled) {
    const { readDerivedState } = await import('../../../../../packages/health/index.js');
    // The key the sweep writes under: the main checkout's branch, else the trunk ref, resolved to a commit as a verdict review resolves it.
    let main = mainCommit;
    if (!main) {
      const resolved = tryGit(root, ['rev-parse', '--verify', `${mainCheckout(root)?.branch ?? trunkRef(root)}^{commit}`]);
      main = resolved.status === 0 ? resolved.stdout.trim() : null;
    }
    const table = main ? readDerivedState(board, { mainCommit: main, enabled: true }) : null;
    if (table && wantedIds.every(id => table.acceptOrder.has(String(id)))) return new Map([...table.acceptOrder].map(([key, event]) => [Number(key), event]));
  }
  return new Map(board.db.prepare("SELECT item_id, MAX(event_id) AS event_id FROM event WHERE event_kind = 'accept' GROUP BY item_id").all().map(row => [row.item_id, row.event_id]));
}

/** The ref an accepted item's commit is published under on the trunk remote, so a runner can fetch it by name. */
export function landingItemRef(id) {
  return `refs/pullboard/land/${id}`;
}

/**
 * The trunk commit a land job lands onto, as this checkout holds it: the trunk remote's tip, fetched under a private ref
 * when this checkout lacks it, else main's commit. Why: verdict freshness is judged against the main the items land on,
 * and with a trunk remote of record this checkout's own main may lag it [B3,C7].
 */
async function landingTrunk(root, remote, main) {
  const trunk = trunkRef(root);
  const listed = tryGit(root, ['ls-remote', '--', remote, trunk]);
  const tip = listed.status === 0 && /^[0-9a-f]{40}/u.test(listed.stdout) ? listed.stdout.slice(0, 40) : main;
  const held = () => tryGit(root, ['cat-file', '-e', `${tip}^{commit}`]).status === 0;
  if (tip !== main && !held()) await pullGit.fetchTrunk(root, remote, [`+${trunk}:refs/pullboard/landing/trunk`]);
  return held() ? tip : main;
}

/**
 * The verdict reader of the derived-state table when it is current for the trunk commit the offer lands onto, else undefined.
 * Why: with health.derivedState on, a sweep at this commit already holds each accepted item's verdict freshness, so the offer reads rows instead of one git history per item; the health cell loads only with the setting on, and a table swept at another commit answers nothing [C7,#3010].
 */
async function derivedVerdicts(board, trunkTip) {
  if (!derivedStateEnabled()) return undefined;
  const { readDerivedState } = await import('../../../../../packages/health/index.js');
  const table = readDerivedState(board, { mainCommit: trunkTip, enabled: true });
  return table ? item => table.verdicts.get(String(item.item_id)) : undefined;
}

/**
 * The other item whose unverified submission sits among this commit's own commits past trunk, or null. Why: landing the
 * commit would put that submission on trunk unreviewed, so the item waits, as the engine's selection held it [B3,E8,#7395].
 */
function stackedUnverified(root, trunk, unverified, item, commit) {
  if (!unverified.length) return null;
  const own = new Set(tryGit(root, ['rev-list', commit, `^${trunk}`]).stdout.split('\n'));
  return unverified.find(other => other.item_id !== item.item_id && own.has(other.item_commit)) ?? null;
}

/**
 * The remote this checkout publishes its trunk to, as a URL or absolute path: the trunk branch's own remote, else origin.
 * Null when it has none, or under separate publish, where only pullboard publish pushes it. Why: with no trunk remote of
 * record a land job lands into this checkout, and origin took the landed tip under the Mac engine too [B3,C7,#7398].
 */
export function hostUpstream(root, config) {
  if (config?.landing?.publish === 'separate') return null;
  const name = tryGit(root, ['config', '--get', `branch.${trunkRef(root).replace(/^refs\/heads\//u, '')}.remote`]).stdout || 'origin';
  const url = name === '.' ? '' : tryGit(root, ['remote', 'get-url', '--push', name]).stdout;
  if (!url || url.startsWith('-') || /[\0\n\r]/u.test(url)) return null;
  // A scheme URL or scp-like host:path stays as written; a local path resolves from this checkout, as git reads it here.
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(url) || /^[^/]+:/u.test(url) || isAbsolute(url) ? url : resolve(root, url);
}

/**
 * Whether the line settings batch landings: line.landingBatchSize above 1 or line.collisionFreeBatch on. Why: only then
 * does an automatic offer wait for the open land job and gather the waiting items into one batch; unset, each accept
 * offers its own job as before [C7,S8].
 */
function batchesLandings(board) {
  const line = lineSettings(board);
  return (Number.isSafeInteger(line.landingBatchSize) && line.landingBatchSize > 1) || line.collisionFreeBatch === true;
}

/**
 * The entries that share no changed file with an entry kept before them, in order, as the landing table's noOverlap rule
 * reads its picked-touched map. Why: items changing the same file wait for the next batch rather than conflict in this one [C7,S8].
 */
function withoutOverlap(root, trunkTip, entries) {
  const touched = new Set();
  return entries.filter(entry => {
    const changed = landingChangedFiles(root, trunkTip, entry.commit);
    if (changed.some(file => touched.has(file))) return false;
    for (const file of changed) touched.add(file);
    return true;
  });
}

/**
 * The item ids an open land job already names. Why: a second accept offers its own items as their own job and never
 * names one twice, so no two jobs push the same land ref or merge the same item [C7,#7728].
 */
function openLandingItems(db) {
  return new Set(openLandJobs(db).keys());
}

/**
 * Publish an item's commit under its land ref on the trunk remote; a push that lost a race to the same commit counts,
 * and a lost race to anything else tries once more. Why: two hosts may offer at once, and a ref already at the
 * accepted commit is the landing's input, not a failure [C7,#7728].
 */
function publishItemRef(root, remote, entry) {
  let pushed = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    pushed = tryGit(root, ['push', '--quiet', '--no-verify', remote, `+${entry.commit}:${entry.ref}`]);
    if (pushed.status === 0) return;
    const listed = tryGit(root, ['ls-remote', '--', remote, entry.ref]);
    if (listed.status === 0 && listed.stdout.slice(0, 40) === entry.commit) return;
  }
  throw Object.assign(new Error(`could not publish #${entry.id} to the trunk remote: ${(pushed.stderr || pushed.stdout).slice(0, 300)}`), { code: 'LANDING_TRUNK_REMOTE' });
}

/**
 * Run `work` under the board's write lock, or inside the caller's transaction when one is open; the hold is recorded in
 * board-writes.jsonl and by a write-holders marker, as every board write is.
 * Why: two accepts at once each chose the same items and offered overlapping jobs (#7728); under the lock the second
 * offer sees the first one's jobs and names none of their items. A raw lock left a 347 s stall with no recorded holder (#11026) [C7].
 */
export function underBoardWriteLock(board, work) {
  return recordedWriteLock(board, work, 'offerPulledLanding');
}

/**
 * The deferred files each item's latest submission recorded, by item id; null when no item deferred any.
 * Why: the pulled gate records them in the submission proof, and only the landing job can run them on the merged tree [C7].
 */
function deferredFilesOf(db, items) {
  const found = {};
  for (const entry of items) {
    const row = db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'submit' ORDER BY event_id DESC LIMIT 1").get(entry.id);
    let proof = null;
    try { proof = JSON.parse(row?.event_detail ?? 'null')?.submissionProof; } catch { /* an unreadable detail defers nothing */ }
    // The files the submit ran (its invariants) run again beside the deferred ones, on the merged tree.
    const owed = Array.isArray(proof?.owedFiles) ? proof.owedFiles : [];
    // Cell tests a narrowed gate dropped (confinedImportSelection) run on the merged tree: a narrowed receipt is never the landing proof [C7].
    if (owed.length || Array.isArray(proof?.deferredFiles) && proof.deferredFiles.length) found[String(entry.id)] = [...new Set([...owed, ...(proof.deferredFiles ?? []), ...(Array.isArray(proof.files) ? proof.files : [])])];
  }
  return Object.keys(found).length ? found : null;
}

/**
 * What a land job's runner does with a red: pair its failing cases when accepted main turns flakes.rerun on, with the
 * runner prefix of the item's check and of the proof command; with it off, still name them, so the board records an
 * unclassified observation. Null when the board's policy reads cannot name a prefix.
 */
function landingFlakes(root, policy, item, head, pairPrefix) {
  const rerun = policy.config.flakes?.rerun === true;
  const config = policy.config, pin = { head, main: policy.commit };
  const proof = typeof config.affectedTests === 'string' && config.affectedTests.trim() ? config.affectedTests : config.gate;
  return { rerun, prefixes: rerun ? { check: pairPrefix(root, item?.item_check ?? null, config, pin), proof: pairPrefix(root, proof, config, pin) } : { check: null, proof: null } };
}

/** A changed file that is a test, for telling which accepted items share an affected test [C7,#9836]. */
const TEST_PATH = /(?:^|\/)(?:tests|journeys)\//u;

/**
 * The commands a land job carries for the runner's Sprint proof, read from the config at the landing base [C7,#12229].
 * Why: the runner has no host config, so the static check and the affected-tests command ride on the payload as argv. A project with no static check gets
 * static null; one with no affected-tests command gets a test command that fails, so a test file it cannot run is red and says so rather than green unproven.
 *
 * @param {{ staticChecks?: string, affectedTests?: string }} config
 * @returns {{ static: string[]|null, testCommand: string[], testFiles: string }}
 */
export function sprintPlan(config) {
  const staticChecks = config.staticChecks?.trim();
  const affected = config.affectedTests?.trim();
  // Each file reaches the command as a `./` path, as the host's affected-tests command builder quotes it.
  const dotted = 'for file in "$@"; do shift; set -- "$@" "./$file"; done; ';
  return {
    static: staticChecks ? ['sh', '-c', staticChecks] : null,
    testCommand: affected ? ['sh', '-c', `${dotted}${affected} "$@"`, 'sh'] : ['false'],
    testFiles: TEST_PATH.source,
  };
}

/**
 * The batches one offer cuts `free` into, in offer order: with `parallel` off, `free` sliced into batches of `size` as the offer always cut it;
 * with it on, one single-item batch per id of the first start group (items with disjoint files and tests), and the rest wait for the next wake [C7,#9836].
 *
 * @param {{ id: number, files?: string[], tests?: string[] }[]} free Entries in accept order.
 * @param {{ size: number, parallel?: boolean }} options
 * @returns {any[][]}
 */
export function landingOfferBatches(free, { size, parallel = false }) {
  if (parallel) return startGroup(free, { parallel: true }).map(id => [free.find(entry => entry.id === id)]);
  const batches = [];
  for (let start = 0; start < free.length; start += size) batches.push(free.slice(start, start + size));
  return batches;
}

/** A step payload as an object; a blob stub (a body past the jobs store's inline limit) reads as `{ stub: true }`, since only a long red receipt grows that big. */
function stepPayload(text) {
  const payload = JSON.parse(text ?? '{}');
  return payload && typeof payload === 'object' && Object.hasOwn(payload, 'blob') ? { stub: true } : payload;
}

/**
 * The sprint hold: the newest finished post-land main-wide test job when it is red and a sprint item it carried is not yet pulled out, else null.
 * Why: a sprint landing queues one main-wide test on the landed tip, and a red receipt reopens its items into a pull-out; the next sprint
 * item landed meanwhile would sit on the red tip. A pending or stuck job never holds (the offer uses the last finished result), so sprint
 * is never stalled by a runner that has not answered. A later finished green job is the newest, so it lifts the hold.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} board
 * @param {{ runs: { db: import('node:sqlite').DatabaseSync } } | null} [queue] - with runs_store on, the runs file holds the job rows
 * @returns {{ job: string, pending: number[] } | null}
 */
export function sprintMainRed(board, queue = null) {
  const db = queue ? queue.runs.db : board.db;
  const finished = db.prepare(`SELECT j.job_id AS job, s.job_step_payload AS payload FROM job j
    JOIN job_step s ON s.job_step_job = j.job_id AND s.job_step_name = 'receipt'
    WHERE j.job_id >= 'post-land:' AND j.job_id < 'post-land;' AND +j.job_kind = 'test' AND j.job_step = 'done'
    ORDER BY j.job_created DESC, j.rowid DESC, s.job_step_seq DESC LIMIT 1`).get();
  if (!finished) return null;
  let payload;
  try { payload = stepPayload(finished.payload); } catch { return null; }
  const receipt = payload.receipt;
  const phase = receipt?.gate?.phases?.[0];
  if (!payload.stub && receipt?.status === 0 && receipt?.gate?.green === true && (phase?.status ?? 0) === 0) return null;
  const offered = db.prepare("SELECT job_step_payload AS payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' ORDER BY job_step_id LIMIT 1").get(finished.job);
  let items = [];
  try { items = stepPayload(offered?.payload).payload?.postLand?.items ?? []; } catch { /* an unreadable offer names no item */ }
  const pending = items.filter(id => Number.isSafeInteger(id) && pullingLanding(board, id));
  return pending.length ? { job: finished.job, pending } : null;
}

/**
 * Offer the board's accepted, unmerged, unheld items as one land job, or return null when this machine lands them
 * itself (no trunk remote of record, and not pull or no local runner). While a land job is open no second automatic
 * one is offered: its receipt settles the items first. Named ids offer only those items; forced (the person's reason)
 * also takes named items not yet accepted, at their submitted commit, and is carried on the job. Each item's commit is
 * pushed to the trunk remote under landingItemRef first, since the runner fetches only from there.
 *
 * @param {object} ctx - The command context at the main checkout.
 * @param {string} root - The main checkout.
 * @param {{ pairPrefix?: Function, quarantineWaivers?: Function, gateRuns?: Function, mainPolicy: (root: string) => { config: object, commit: string }, listItems: Function, checkedLandingCommit: Function, badgeDocuments?: (board: object) => { path: string, text: string }[] }} reads - The
 *   policy and board reads the lander already holds.
 * @param {{ local?: typeof ensureLocalRunner, ids?: number[] | null, forced?: string | null, board?: object | null, lock?: typeof underBoardWriteLock }} [options] - board: the
 *   board a command already holds open, so a hand landing writes its offer there; lock: the write lock the offer's writes sit under (a test seam, the recorded board write lock by default); write: the board write a stale reopen goes through (a test seam, the command's ordered write by default).
 * @returns {Promise<{ offered: string | null, items: number[], waiting: boolean, forced?: string } | null>}
 */
export async function offerPulledLanding(ctx, root, { mainPolicy, listItems, checkedLandingCommit, badgeDocuments, pairPrefix, quarantineWaivers, gateRuns = () => [] }, { local = ensureLocalRunner, ids = null, forced = null, board: opened = null, lock = underBoardWriteLock, write = null } = {}) {
  const policy = mainPolicy(root);
  const configured = configTrunkRemote(policy.config);
  // No trunk remote: the board host's repository is trunk, landed by the local runner, which this starts again if it died.
  const hosted = !configured && runnerDispatchMode() === 'pull' && (await local(root)).running;
  if (!configured && !hosted) return null;
  const remote = configured ?? root;
  // A trunk remote of record that is a checkout here with trunk checked out (pb-trunk links to this one) takes its push in place [C7,#7951].
  const intoCheckout = Boolean(configured) && trunkCheckedOut(configured, root, trunkRef(root));
  const result = await (opened ? work => work(opened) : work => withBoard(ctx, work))(async board => {
    // An open land job keeps its own items; this offer takes only the accepted items no open job names [C7,#7728].
    const taken = ids ? new Set() : openLandingItems(board.db);
    // With batching on, an open land job holds the next offer: its receipt settles the items, then the waiting ones go out together [C7,S8].
    const batching = !ids && batchesLandings(board);
    if (batching && openLandingJob(board.db)) return { offered: openLandingJob(board.db), items: [], waiting: true };
    // A verdict a main change made stale goes back to its lane first, as the engine's selection does; forced takes none [B3,C7].
    const trunkTip = await landingTrunk(root, remote, policy.commit);
    // An open item a landing reopen left with its accept and green gate returns to verified first, or stays open naming its conflicts [B3,C7,#2997].
    if (!ids) await relandAcceptedItems({ root, board, base: trunkTip, write: (operation, args) => ordered(ctx, board, operation, args), say: line => ctx.io.say?.(line), landingPorts: { quarantineWaivers: quarantineWaivers ?? (() => []) } });
    // With health.derivedState on and the table swept at this trunk commit, each item's freshness is its table row, not a git read [C7,#3010].
    const derived = await derivedVerdicts(board, trunkTip);
    const all = await withoutStaleVerdicts(board, root, trunkTip, listItems(board, { all: true }), { candidate: item => !forced && !item.item_hold_at && !taken.has(item.item_id) && (!ids || ids.includes(item.item_id)),
      write: (operation, args) => write ? write(operation, args) : ordered(ctx, board, operation, args), say: line => ctx.io.say?.(line), hunkKeyed: hunkFreshnessEnabled(), composeAsObject: submitComposeAsObject(), residualConflicts: mechanicalConflictFiles, derived });
    for (const id of ids ?? []) if (!all.some(item => item.item_id === id && !item.item_merged_commit)) throw new Refused('LAND_NAMED', `#${id} is not an unmerged item on this board`, 'name only items that wait to land');
    // A submitted sprint item with a green screen on this trunk tip lands as a verified one does; the pace is read from the listed row [V2,M1,#12177].
    const landable = item => item.item_status === 'verified' || sprintLandable(board, item, trunkTip);
    const wanted = item => !item.item_merged_commit && (ids ? ids.includes(item.item_id) && (forced || landable(item)) : landable(item) && !item.item_hold_at && !taken.has(item.item_id));
    // An item stacked on another's unverified submission waits, named; a named one refuses; forced is the person's call [B3,E8,#7395].
    const candidates = all.filter(wanted);
    // Accept order, as the engine's selection merges: each item's newest accept event; named ids keep the order named [C7].
    const accepted = await acceptOrderOf(root, board, all.filter(wanted).map(item => item.item_id));
    // landing.first in accepted trunk policy goes ahead of the accept order, in the order listed; named ids keep the order named [C7,#7387].
    const pinned = new Map((Array.isArray(policy.config?.landing?.first) ? policy.config.landing.first : []).map((id, index) => [id, index]));
    // An item that met 2 or more infrastructure failures (lapsed leases, lost CAS) goes behind every other accepted item, as candidates() does; named ids keep the order named [C7,#3118].
    const aside = new Set(ids ? [] : candidates.filter(item => stepAsideCount(board, item.item_id) >= 2).map(item => item.item_id));
    const rank = item => ids ? ids.indexOf(item.item_id) : accepted.get(item.item_id) ?? Number.MAX_SAFE_INTEGER;
    const pin = item => !ids && pinned.has(item.item_id) ? pinned.get(item.item_id) : Number.MAX_SAFE_INTEGER;
    // landing.priorityOrder: the order next uses (urgent or pinned, milestone position) goes before accept order; named ids keep their order [C7,#3157].
    const byPriority = !ids && policy.config?.landing?.priorityOrder === true ? landingPriorityCompare(board) : () => 0;
    const commitOf = item => item.item_status === 'verified' ? checkedLandingCommit(board, item) : item.item_commit;
    // runs_store on: queueRun makes its own board transaction (intent, move, confirm), so the offers cannot sit inside this raw write lock; their ids are minted from the items, so a retried offer reuses its job [B2,P7].
    const queue = queueFor(board, 'coordinator', { file: ctx.file });
    // A sprint item waits while the newest finished main-wide test is red and its items are not yet pulled out; steady items are offered as before [V2,M1,#12502].
    let mainRed;
    const sprintHold = item => forced || itemPace(item) !== 'sprint' ? null : (mainRed === undefined ? (mainRed = sprintMainRed(board, queue)) : mainRed);
    const unverified = forced || !candidates.length ? [] : unverifiedSubmissions(board);
    // landing.pauseOnRed: a red publish holds the items touching its files, and every item when it names none or no item is left [C7,V4].
    const publishHold = forced ? null : requirePublishGreen(root, board, policy.config, { gateRuns }, { perItem: true });
    const chosen = candidates.filter(item => {
      const redMain = sprintHold(item);
      if (redMain && ids) throw new Refused('MAIN_RED', `#${item.item_id} waits: MAIN_RED on ${redMain.job}, red until ${redMain.pending.map(id => `#${id}`).join(' ')} ${redMain.pending.length > 1 ? 'are' : 'is'} pulled out`, 'land it after the pull-out records pulled, or go around with --forced "<why>"');
      if (redMain) { ctx.io.say?.(`#${item.item_id} waits: MAIN_RED on ${redMain.job}, until ${redMain.pending.map(id => `#${id}`).join(' ')} ${redMain.pending.length > 1 ? 'are' : 'is'} pulled out`); return false; }
      if (publishHold && publishRedTouched(publishHold.files, landingChangedFiles(root, trunkTip, commitOf(item))).length) return false;
      const stacked = stackedUnverified(root, trunkTip, unverified, item, commitOf(item));
      if (stacked && ids) throw new Refused('STACKED_UNVERIFIED', `#${item.item_id} holds #${stacked.item_id}'s unverified submission ${stacked.item_commit.slice(0, 12)}`, `land #${stacked.item_id} after its verify, or rebuild #${item.item_id} without it`);
      if (stacked) ctx.io.say?.(`#${item.item_id} waits: STACKED_UNVERIFIED on #${stacked.item_id} ${stacked.item_commit.slice(0, 12)}`);
      return !stacked;
    }).sort((left, right) => Number(aside.has(left.item_id)) - Number(aside.has(right.item_id)) || pin(left) - pin(right) || byPriority(left, right) || rank(left) - rank(right) || left.item_id - right.item_id);
    // A head stepped aside is named with its failure count, so the reorder is never silent [C7,#3118].
    for (const item of chosen) if (aside.has(item.item_id)) ctx.io.say?.(`#${item.item_id} steps aside: ${stepAsideCount(board, item.item_id)} infrastructure failures, offered behind the next accepted item`);
    // Each merge carries the engine's landing message from the item's frozen rows, so spec coverage reads its trailers [B3,R3,C7].
    if (publishHold && !chosen.length) throw publishHold.refusal;
    const messages = checkLandingMessages(chosen, landingContext(root, policy.commit, policy.config, commitOf));
    const items = chosen.map(item => {
      const message = messages.get(item.item_id);
      return { id: item.item_id, commit: commitOf(item), ref: landingItemRef(item.item_id), header: message.header, trailers: message.trailers, pace: itemPace(item) };
    });
    if (ids && items.length !== ids.length) throw new Refused('LAND_NOT_ACCEPTED', `${ids.filter(id => !items.some(entry => entry.id === id)).map(id => `#${id}`).join(' ')} is not accepted`, 'land it after its verify, or go around the gate with --forced "<why>"');
    if (!items.length) return { offered: ids ? null : openLandingJob(board.db), items: [], waiting: false };
    for (const entry of items) publishItemRef(root, remote, entry);
    const listed = tryGit(root, ['ls-remote', '--', remote, trunkRef(root)]);
    const expect = listed.status === 0 && /^[0-9a-f]{40}/u.test(listed.stdout) ? listed.stdout.slice(0, 40) : policy.commit;
    // Every git read and machine-settings read the offer needs happens here, before the lock: they depend only on root, trunkTip, policy and the chosen items, and under the lock they held every other board write for 30 s+ [C7,#11105].
    const trunk = trunkRef(root);
    // line.collisionFreeBatch: items changing the same file wait for the next batch; the files are read here, before the lock [C7,S8,#11105].
    const disjoint = !ids && lineSettings(board).collisionFreeBatch === true ? withoutOverlap(root, trunkTip, items) : items;
    const settings = loadMachineSettings();
    const parallel = parallelGatesEnabled();
    const files = new Map(parallel ? items.map(entry => [entry.id, landingChangedFiles(root, trunkTip, entry.commit)]) : []);
    const flakesOf = new Map(typeof pairPrefix === 'function' ? items.map(entry => [entry.id, landingFlakes(root, policy, chosen.find(item => item.item_id === entry.id), entry.commit, pairPrefix)]) : []);
    const upstream = hosted ? hostUpstream(root, policy.config) : null;
    const shardGate = policy.config.landing?.shardProof === true ? landingShardGate() : null;
    const badges = badgeDocuments?.(board) ?? [];
    return (queue ? work => work() : work => lock(board, work))(() => {
      // A concurrent accept may have offered some of these since they were chosen; those stay with its job [C7,#7728].
      const fresh = ids ? new Set() : openLandingItems(board.db);
      if (batching && openLandingJob(board.db)) return { offered: openLandingJob(board.db), items: [], waiting: true };
      const free = disjoint.filter(entry => !fresh.has(entry.id));
      if (!free.length) return { offered: openLandingJob(board.db), items: [], waiting: false };
      // A set line.landingBatchSize splits an automatic offer into jobs of at most that many, as it capped the engine's
      // batches; each job's push finds trunk moved by the one before and merges again on the new tip [C7,#7728].
      const size = ids ? free.length : Math.min(free.length, batchCap(board, { adaptive: adaptiveBatchEnabled() }));
      const jobs = [];
      // landing.ledgerMainReds: the ledger's red-now files ride on each job, so a red main already records holds no landing [C7,U152].
      const mainReds = landingMainReds(policy.config, policy.config.landing?.ledgerMainReds === true ? redNow(testResults(board.db)) : []);
      // With landing.parallelGates on, each entry carries its changed files and the tests among them, so the start group is the disjoint ones [C7,#9836].
      const planned = parallel ? free.map(entry => {
        const changed = files.get(entry.id);
        return { ...entry, files: changed, tests: [...changed.filter(file => TEST_PATH.test(file)), ...Object.values(deferredFilesOf(board.db, [entry]) ?? {}).flat()] };
      }) : free;
      for (const planBatch of landingOfferBatches(planned, { size, parallel })) {
        const batch = parallel ? planBatch.map(({ files, tests, ...entry }) => entry) : planBatch;
        // Each item's submit may have deferred test files to this landing; the job runs them on the merged tree [C7].
        const deferred = deferredFilesOf(board.db, batch);
        // The runner names a red's failing cases whether or not it pairs them; the prefixes are main's accepted policy, as the pulled gate's are [C7,H16].
        const flakes = flakesOf.get(batch[0].id) ?? null;
        // With gate.fencedHop on, each item's gate hop epoch rides on the job, and the runner pushes trunk through the fences [C7,#8437].
        const hops = carryLandingHops(board.db, batch, { enabled: fencedHopEnabled() });
        const job = offerLandingJob(board.db, { items: batch, expect, trunk, forced, deferred, flakes, hops, mainReds, sprint: batch.some(entry => entry.pace === 'sprint') ? sprintPlan(policy.config) : null, reofferTrunkBusy: settings.landing?.reofferTrunkBusy === true, squash: settings.landing?.squash === true, reuseGateReceipts: settings.landing?.reuseGateReceipts === true, reuseContractResults: settings.landing?.reuseContractResults === true, stallStop: settings.landing?.stallStop === true, staticAffectedOnly: settings.landing?.staticAffectedOnly === true, ...(shardGate ? { shardGate } : {}), badges, ...(queue ? { queue } : {}),
          ...(hosted ? { config: { ...policy.config, trunk: { ...policy.config.trunk, remote } }, needs: [BOARD_HOST], checkout: true, upstream } : { config: policy.config, checkout: intoCheckout }) });
        ctx.io.say?.(`offered ${forced ? 'forced ' : ''}land job ${job.id} for ${batch.map(entry => `#${entry.id}`).join(' ')}; a runner merges and pushes trunk`);
        jobs.push(job.id);
      }
      return { offered: jobs[0], items: free.map(entry => entry.id), waiting: false, ...(jobs.length > 1 ? { jobs } : {}), ...(forced ? { forced } : {}) };
    });
  });
  // The offer is committed: with runners.localWake on, an idle local runner claims it now, not at its next poll [C7,#10409].
  if (result?.offered && hosted) wakeRunnerForOffer();
  return result;
}
