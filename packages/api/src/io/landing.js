/** The board side of a runner landing job: one queue row naming the accepted items and the trunk sha expected [P7]. */
import { createHash } from 'node:crypto';
import { fileSystemAdapter } from '../../../fs/index.js';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { ledgerFiles } from '../../../store/index.js';
import { ledgerHits } from '../../../store/index.js';
import { ledgerMainReds } from '../../../store/index.js';
import { ledgerRecentFiles } from '../../../store/index.js';
import { landingWaiverKind } from '../../../store/index.js';
import { PERSON } from '../../../store/index.js';
import { runsStoreOn } from '../../../store/index.js';
import { offerJob } from './jobs.js';
import { offeredRequest } from './jobs.js';
import { holdJob } from '../../../jobs/index.js';

const fs = fileSystemAdapter();

/** The job kind a runner asks for to take landings; packages/landing's runner side takes this kind. */
export const LANDING_JOB_KIND = 'land';
// Budget: a land job's payload stays well under the job payload cap (16 KiB), so a long header or trailer cannot tip it over.
const LAND_PAYLOAD_BYTES = 8 * 1024;
/**
 * The shape of the land payload this board writes. A runner understands shapes up to its own LANDING_PAYLOAD_SHAPE
 * (packages/landing's runner job) and refuses a newer one with LANDING_PAYLOAD_VERSION, rather than landing without an option
 * its code never learned (#7791). Shape 2: fields such as `checkout` may sit in the job's request (#7766).
 */
export const LAND_PAYLOAD_SHAPE = 2;
// The shape a land job carrying hop epochs is written in: a runner that cannot push through the fences refuses it rather than land unfenced [C7,#8437].
export const LAND_HOPS_SHAPE = 3;
// Budget: a land job whose push failed is offered again this many times, then the coordinator hears a named refusal (#7791).
export const LAND_PUSH_RETRIES = 2;
// The payload parts a runner may read from the job's request instead: what the board derived, never ids, commits or refs.
const SPILLABLE = ['proof', 'deferred', 'badges', 'waivers', 'checks', 'shardProof', 'mainReds'];
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const REF = /^refs\/[A-Za-z0-9._/-]{1,200}$/u;
// A landing merge's header is one line; its trailers are the builder's Pullboard- lines and nothing else.
const MESSAGE_HEADER = /^[^\n\r]{1,200}$/u;
const MESSAGE_TRAILERS = /^Pullboard-[A-Za-z]+: [^\n\r]{1,2000}(?:\nPullboard-[A-Za-z]+: [^\n\r]{1,2000})*$/u;

/**
 * The person's waivers still live at `now`, oldest first, each with its kind resolved: `{ id, kind, test, until, reason }`.
 * Why here: a runner never opens the board, so a pulled gate's receipt and a land job's payload read the person's
 * waivers from the board's own events, with the controller's expiry rule (live while `until` is after now) [B3,R3,#655].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now - Epoch milliseconds.
 * @returns {{ id: string, kind: string, test: string, until: string, reason: string }[]}
 */
export function livePersonWaivers(db, now) {
  return db.prepare("SELECT event_by, event_detail FROM event WHERE event_kind = 'landing_waiver' ORDER BY event_id").all()
    .filter(row => row.event_by === PERSON).map(row => JSON.parse(row.event_detail).waiver)
    .filter(waiver => typeof waiver?.test === 'string' && Date.parse(waiver.until) > now)
    .map(({ id, test, until, reason }) => ({ id, kind: landingWaiverKind(test), test, until, reason }));
}

/** Refuse hop epochs that do not name a landed item and a whole epoch; return them as { item, epoch } [C7,#8437]. */
function landingHops(hops, landed) {
  const ids = new Set(landed.map(entry => entry.id));
  if (!Array.isArray(hops) || hops.some(hop => !ids.has(hop?.item) || !Number.isSafeInteger(hop.epoch) || hop.epoch < 1)) {
    throw new Refused('LANDING_HOPS', 'a landing job\'s hops are { item, epoch }: a landed item and the whole hop epoch its gate row holds');
  }
  return hops.map(({ item, epoch }) => ({ item, epoch }));
}

const PACES = ['sprint', 'steady', 'strict'];

/** Refuse an accepted-items list a runner could not land as written; return it in landing order. */
function landingItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Refused('LANDING_ITEMS', 'a landing job names at least one accepted item as { id, commit, ref? }');
  return items.map(entry => {
    if (!Number.isSafeInteger(entry?.id) || entry.id < 1 || !SHA.test(entry.commit ?? '') || (entry.ref !== undefined && !REF.test(entry.ref))) {
      throw new Refused('LANDING_ITEMS', 'each landed item is { id, commit, ref? }: a positive item id, its full accepted commit sha, and the refs/ name the trunk remote holds it under');
    }
    if (entry.header !== undefined && (typeof entry.header !== 'string' || !MESSAGE_HEADER.test(entry.header) || typeof entry.trailers !== 'string' || !MESSAGE_TRAILERS.test(entry.trailers))) {
      throw new Refused('LANDING_ITEMS', 'a landed item\'s message is { header, trailers }: one header line and its Pullboard- trailer lines, as the landing message builder writes them');
    }
    if (entry.pace !== undefined && !PACES.includes(entry.pace)) throw new Refused('LANDING_ITEMS', 'a landed item\'s pace is sprint, steady or strict, and steady when it names none');
    return { id: entry.id, commit: entry.commit, pace: entry.pace ?? 'steady', ...(entry.ref ? { ref: entry.ref } : {}), ...(entry.header !== undefined ? { header: entry.header, trailers: entry.trailers } : {}) };
  });
}

/**
 * Offer one landing to the runners: a row on the board's job queue, never a process on this host. The row carries the
 * accepted items, the trunk sha they were accepted against and the trunk remote of record; a runner fetches, merges,
 * checks and pushes. Offering the same landing again returns the job as it stands.
 *
 * Why: the board host only keeps rows, so a landing survives the board host sleeping, and nothing here runs git.
 * One job kind for every landing: automatic on accept, by hand, and forced, whatever gate.runnerDispatch says (#5864).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ items: { id: number, commit: string, ref?: string }[], expect: string, mainReds?: Array<[string, string]>, config: { trunk?: { remote?: string }, landing?: { trunkRemote?: string, shardProof?: boolean } }, shardGate?: { run: string[], entry: string } | null,
 *   flakes?: { rerun: boolean, prefixes?: { check?: string | null, proof?: string | null } } | null, mode?: string, trunk?: string, check?: string[] | null, needs?: string[], checkout?: boolean, upstream?: string | null, forced?: string | null, badges?: { path: string, text: string }[], now?: number }} request - badges: the
 *   badge documents the board computed, which the runner writes into the landing merge (it has no board) [C7]; checkout: the
 *   remote is the board host's own checkout with trunk checked out, so the push updates its work tree too [P7]; upstream: that
 *   checkout's own remote URL, which the runner then pushes the landed tip to [#7398]; forced: the
 *   reason a forced landing names, carried on the job and its key, and its job runs no check; mode is no longer read, since landing
 *   pulls in any mode. config.landing.publish "separate" rides on the job, so a red item parks and the clean ones land.
 *   queue: the board's queue (queueFor) while runs_store is on, so the offer goes through queueRun and the runs file [B2,P7]; null writes the board's job rows as before.
 *   reuseContractResults: landing.reuseContractResults (default off), the contracts carry a hit list of the ledger's newest green files, so the runner reuses a contract file whose inputs are unchanged (#9301).
 *   stallStop: landing.stallStop (default off), rides the job as a flag so its runner stops a check with no progress for two minutes (#8749).
 *   staticAffectedOnly: landing.staticAffectedOnly, on the job so its runner scopes the static guard to the classes that read a changed gate data file (#9077).
 *   reuseGateReceipts: landing.reuseGateReceipts (default off), the items' own green gate rows head the proof's hit list and ride the job as a flag (#9243).
 *   squash: landing.squash, on the job so its runner lands each item as one single-parent commit (#9219).
 *   reofferTrunkBusy: landing.reofferTrunkBusy, on the job so its runner carries a green static check to a tip whose new commits miss the batch's files (#9103).
 *   mainReds: the `[file, commit]` pairs the board's red-now ledger records red (landing.ledgerMainReds); they ride with the contracts, so the runner counts a red in such a file as main's [C7,U152].
 * @returns {ReturnType<typeof offerJob>}
 */
export function offerLandingJob(db, { items, expect, config, squash = false, trunk = 'refs/heads/main', check = null, needs = [], checkout = false, upstream = null, forced = null, badges = [], deferred = null, flakes = null, hops = [], shardGate = null, mainReds = [], queue = null, reofferTrunkBusy = false, reuseGateReceipts = false, reuseContractResults = false, stallStop = false, staticAffectedOnly = false, now = Date.now() }) {
  // trunk.remote, else its old name landing.trunkRemote: config's configTrunkRemote order, kept here since the cell ratchet allows no new api->config import.
  const remote = config?.trunk?.remote || config?.landing?.trunkRemote;
  if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw new Refused('LANDING_TRUNK_REMOTE', 'a runner landing pushes the trunk remote of record; set trunk.remote in pullboard.json to its git URL');
  if (!SHA.test(expect ?? '')) throw new Refused('LANDING_EXPECT', 'a landing job names the full trunk sha its items were accepted against');
  if (!REF.test(trunk)) throw new Refused('LANDING_TRUNK_REF', 'the trunk is a refs/ name, like refs/heads/main');
  if (check !== null && (!Array.isArray(check) || check.length === 0 || check.some(part => typeof part !== 'string'))) throw new Refused('LANDING_CHECK', 'a landing check is a command as a list of strings, like ["npm", "run", "gate"]');
  if (upstream !== null && (!checkout || typeof upstream !== 'string' || !upstream || upstream.startsWith('-') || /[\0\n\r]/u.test(upstream))) throw new Refused('LANDING_UPSTREAM', 'a landing upstream is the board host checkout\'s own remote URL, carried only on a job that lands into that checkout');
  if (forced !== null && (typeof forced !== 'string' || !forced.trim())) throw new Refused('FORCED_REASON', 'a forced landing names why it went around the gate: --forced "<why>"');
  if (!Array.isArray(badges) || badges.some(entry => typeof entry?.path !== 'string' || typeof entry?.text !== 'string' || /^\/|\.\./u.test(entry.path))) throw new Refused('LANDING_BADGES', 'landing badges are { path, text } documents inside the repo, as the view\'s badgeDocuments returns them');
  if (flakes !== null && (typeof flakes?.rerun !== 'boolean' || ['check', 'proof'].some(role => flakes.prefixes?.[role] != null && typeof flakes.prefixes[role] !== 'string'))) {
    throw new Refused('LANDING_FLAKES', 'a landing job\'s flakes are { rerun, prefixes: { check, proof } }: whether a red pairs its failing cases, and the runner prefix of each command');
  }
  const landed = landingItems(items);
  const fenced = landingHops(hops, landed);
  const defer = deferredPayload(deferred, config?.affectedTests, landed);
  const ids = landed.map(entry => entry.id).join('+').slice(0, 120);
  const proof = landingProof(db, landed, config?.affectedTests, expect, { reuseGate: reuseGateReceipts === true && !forced });
  const own = forced || check || proof ? null : ownChecks(db, landed, config);
  // A deferred selection replaces only the affected tests; the project's own gate still judges the merged tree [C7].
  const deferGate = defer && !forced && typeof config?.gate === 'string' && config.gate.trim() ? ['sh', '-c', config.gate.trim()] : null;
  const separate = config?.landing?.publish === 'separate';
  // The runner selects, on each tree it checks, the affected tests no submit proved: contracts main gained after submit [C7,#7378].
  const runner = typeof config?.affectedTests === 'string' && config.affectedTests.trim();
  // landing.reuseContractResults (off by default): the newest green ledger rows ride with the contracts, so a contract file at an unchanged inputKey is reused [C7,#9301].
  const contractLedger = reuseContractResults === true && !forced && runner && !/[\0\n\r]/u.test(runner) ? ledgerHits(db, ledgerRecentFiles(db), { budget: 16_000, perFile: 1 }) : null;
  const contracts = !forced && runner && !/[\0\n\r]/u.test(runner) ? { runner, ...(reuseContractResults === true ? { reuse: true, ...(contractLedger ? { ledger: contractLedger } : {}) } : {}) } : null;
  // The person's live waivers ride on the job, so its runner holds no landing for a waived test, whether the proof or the contracts ran it; a new waiver is a new job [#655,C7].
  const waivers = proof || contracts ? livePersonWaivers(db, now) : [];
  const key = createHash('sha256').update(JSON.stringify([remote, trunk, expect, landed, ...(forced ? [forced] : []), ...(waivers.length ? [waivers.map(waiver => waiver.id)] : []), ...(fenced.length ? [fenced] : [])])).digest('hex').slice(0, 16);
  // The board's static guard runs on the merged tree, from accepted main's config, never the item's own [C7,#7492].
  const staticChecks = !forced && typeof config?.staticChecks === 'string' && config.staticChecks.trim() && !/\0/u.test(config.staticChecks) ? config.staticChecks.trim() : null;
  // The repository's install command (check.install) rides on the job, so its runner prepares the landing checkout before the first item check [C7,#12231].
  const install = typeof config?.check?.install === 'string' && config.check.install.trim() && !/\0/u.test(config.check.install) ? config.check.install.trim() : null;
  // landing.perItem is on by default (off under parallel landing); only off rides on the job, so default payloads stay as they were [C7,#2901].
  const batchOnly = config?.landing?.perItem === false || config?.landing?.parallel === true;
  // The landing's checks may run this long (the push shard limit setting) before the runner stops them and posts LAND_PROOF_TIMEOUT; only a non-default limit rides on the job [C7,#7820].
  const proofMinutes = Number.isSafeInteger(config?.pushGate?.shardMinutes) && config.pushGate.shardMinutes > 0 && config.pushGate.shardMinutes !== 20 ? config.pushGate.shardMinutes : null;
  // landing.shardProof (off by default): the job carries the gate its proof's shard jobs run, so its runner spreads the proof over runners [C7,#7818,#8255].
  const shardOn = config?.landing?.shardProof === true && !forced;
  if (shardOn && (!Array.isArray(shardGate?.run) || !shardGate.run.length || typeof shardGate.entry !== 'string')) throw new Refused('LANDING_SHARD_GATE', 'landing.shardProof is on, so the offer names the gate a proof shard runs: { run, entry }');
  const shardProof = shardOn ? { run: shardGate.run, entry: shardGate.entry } : null;
  const payload = { shape: fenced.length ? LAND_HOPS_SHAPE : LAND_PAYLOAD_SHAPE, remote, trunk, expect, items: landed, ...(fenced.length ? { hops: fenced } : {}), ...(check ?? own?.gate ?? deferGate ? { check: check ?? own?.gate ?? deferGate } : {}), ...(own?.checks ? { checks: own.checks } : {}), ...(proof ? { proof } : {}), ...(shardProof ? { shardProof } : {}), ...(defer ? { deferred: defer } : {}), ...(contracts ? { contracts } : {}), ...(contracts && Array.isArray(mainReds) && mainReds.length ? { mainReds } : {}), ...(staticChecks ? { staticChecks } : {}), ...(install ? { install } : {}), ...(waivers.length ? { waivers } : {}),
    ...(separate ? { publish: 'separate' } : {}), ...(batchOnly ? { perItem: false } : {}), ...(proofMinutes ? { proofMinutes } : {}), ...(badges.length ? { badges } : {}), ...(checkout ? { checkout: true } : {}), ...(upstream ? { upstream } : {}), ...(flakes ? { flakes: { rerun: flakes.rerun, prefixes: { check: flakes.prefixes?.check ?? null, proof: flakes.prefixes?.proof ?? null } } } : {}), ...(forced ? { forced: forced.trim() } : {}),
    // landing.reofferTrunkBusy rides on the job only when on, so its runner may carry a green static check to a new tip [C7,#9103].
    ...(squash === true && !forced ? { squash: true } : {}),
    ...(reofferTrunkBusy === true && !forced ? { reofferTrunkBusy: true } : {}),
    // landing.reuseGateReceipts rides on the job only when on, so its runner may count the hit list's files as reused [C7,#9243].
    ...(reuseGateReceipts === true && !forced && proof ? { reuseGateReceipts: true } : {}),
    // landing.stallStop rides on the job only when on, so its runner may stop a check that shows no progress for two minutes [C7,#8749].
    ...(stallStop === true ? { stallStop: true } : {}),
    // landing.staticAffectedOnly rides on the job only when on, so its runner scopes the static guard past a changed gate data file [C7,#9077].
    ...(staticAffectedOnly === true ? { staticAffectedOnly: true } : {}) };
  const spilled = spillLargeInputs(payload);
  return offerJob(db, { id: `land:${ids}:${key}`, kind: LANDING_JOB_KIND, priority: 'landing', needs, now, payload: spilled.payload, ...(spilled.request ? { request: spilled.request } : {}) }, queue);
}

/**
 * Move a land job's board-derived inputs out of its payload when the payload would grow past LAND_PAYLOAD_BYTES: the
 * largest of the proof (every file an item's gates proved, the ledger hits, main's reds), deferred files, badge
 * documents, waivers and own checks go to the job's request, which only its runner reads, and the payload keeps the ids,
 * commits and refs plus `requested`, the names of what moved. Why: a big board's proof alone passed the job payload's
 * 16 KiB cap and the accepted work was retained instead of landing (#7766); the runner reads the request with its claim.
 *
 * @param {Record<string, unknown>} payload
 * @returns {{ payload: Record<string, unknown>, request: { land: Record<string, unknown> } | null }}
 */
export function spillLargeInputs(payload) {
  const size = value => Buffer.byteLength(JSON.stringify(value));
  if (size(payload) <= LAND_PAYLOAD_BYTES) return { payload, request: null };
  const kept = { ...payload }, moved = {};
  for (const key of SPILLABLE.filter(name => kept[name] !== undefined).sort((a, b) => size(kept[b]) - size(kept[a]))) {
    if (size({ ...kept, requested: Object.keys(moved) }) <= LAND_PAYLOAD_BYTES) break;
    moved[key] = kept[key];
    delete kept[key];
  }
  return { payload: { ...kept, requested: Object.keys(moved) }, request: { land: moved } };
}

/**
 * The deferred test files each landed item's submit left to the landing gate, with the project's runner: what the runner
 * runs on the merged tree and returns the item on red. Null when none, or no runner to run them.
 * Why: a submit that deferred its selection proved only part of it, so the land job owes the rest [C7].
 *
 * @param {Record<string, string[]> | null} deferred Deferred files by item id, as each item's submission proof recorded them.
 * @param {unknown} runner The project's affectedTests command.
 * @param {{ id: number }[]} landed
 * @returns {{ runner: string, files: Record<string, string[]> } | null}
 */
function deferredPayload(deferred, runner, landed) {
  if (!deferred || typeof runner !== 'string' || !runner.trim() || /[\0\n\r]/u.test(runner)) return null;
  const files = {};
  for (const entry of landed) {
    const rows = deferred[String(entry.id)];
    if (Array.isArray(rows) && rows.length && rows.every(file => typeof file === 'string' && /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u.test(file))) files[String(entry.id)] = rows;
  }
  return Object.keys(files).length ? { runner: runner.trim(), files } : null;
}

/**
 * The checks a land job with no ledger proof runs on the merged tree, as 0.9.3's landing gate did: each item's own
 * check, and the project's full gate when it names no affectedTests runner. Why: a plain project's land job checked
 * nothing, so an item green at its base but red on current main landed (#6468, #6469). A job with a ledger proof has
 * neither, since the proof's files are the ones each item's gate ran, its check's among them [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: number }[]} items
 * @param {{ gate?: unknown, affectedTests?: unknown }} config
 * @returns {{ checks: Record<string, string> | null, gate: string[] | null }} checks: each item's own check by item id.
 */
function ownChecks(db, items, config) {
  const read = db.prepare('SELECT item_check FROM item WHERE item_id = ?');
  const checks = Object.fromEntries(items.map(entry => [String(entry.id), read.get(entry.id)?.item_check])
    .filter(([, command]) => typeof command === 'string' && command.trim()).map(([id, command]) => [id, command.trim()]));
  const affected = typeof config?.affectedTests === 'string' && config.affectedTests.trim();
  const gate = !affected && typeof config?.gate === 'string' && config.gate.trim() ? ['sh', '-c', config.gate.trim()] : null;
  return { checks: Object.keys(checks).length ? checks : null, gate };
}

/**
 * The proof a landing job runs on the merged tree, read only from the board's ledger: the test files its items' gates
 * proved, the runner command, and the ledger's hits for those files. The runner reruns only the files whose inputKey
 * at the merged tree misses, so an unrelated main move runs nothing. A file with a fail row at main's commit rides as
 * `mainRed`: at main's identical inputKey it is main's red, charged to main and never run, so it holds no landing.
 * Null when no item has ledger rows or there is no runner command, so such a landing checks as before [P7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ commit: string }[]} items
 * @param {unknown} runner the project's affectedTests command
 * @param {string} [main] the trunk sha the items were accepted against
 * @param {{ reuseGate?: boolean }} [options] reuseGate (landing.reuseGateReceipts): the items' own green gate rows head the hit list, so the budget never drops them [C7,#9243]
 * @returns {{ runner: string, files: string[], ledger: ReturnType<typeof ledgerHits> } | null}
 */
export function landingProof(db, items, runner, main, { reuseGate = false } = {}) {
  if (typeof runner !== 'string' || !runner.trim() || /[\0\n\r]/u.test(runner)) return null;
  const files = ledgerFiles(db, items.map(entry => entry.commit));
  if (!files.length) return null;
  const ledger = ledgerHits(db, files, { budget: 16_000, ...(reuseGate ? { commits: items.map(entry => entry.commit) } : {}) }) ?? { contexts: [], files: [] };
  const mainRed = main ? ledgerMainReds(db, files, main, ledger.contexts) : [];
  return { runner: runner.trim(), files, ledger: mainRed.length ? { ...ledger, mainRed } : ledger.files.length ? ledger : null };
}

/**
 * The landing job offered and not yet done, or null: a lander offers no second landing while one is open, since its
 * receipt settles the items first.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string | null} The open job's id.
 */
export function openLandingJob(db) {
  // With runs_store on the job lives in the runs file, and the board holds one queued run row until its receipt applies [B2,P7,#9114].
  if (runsStoreOn(db)) return db.prepare("SELECT run_job FROM run WHERE run_kind = ? AND run_state IN ('queued', 'awaiting') ORDER BY run_created, rowid LIMIT 1").get(LANDING_JOB_KIND)?.run_job ?? null;
  return db.prepare("SELECT job_id FROM job WHERE job_kind = ? AND job_step <> 'done' ORDER BY job_created LIMIT 1").get(LANDING_JOB_KIND)?.job_id ?? null;
}

/**
 * Keep a red land job's receipt as a durable log under the repo's pullboard/landings folder, where the inline engine
 * kept its batch log and users read it. Why: a pulled runner works in its own checkout and writes no log on this machine,
 * so the board, which holds the receipt, writes it [C7].
 *
 * @param {any} board
 * @param {string} job
 * @param {{ outcome?: string, detail?: string | null, returned?: { id: number, reason: string, detail: string }[] }} receipt
 * @returns {string | null} the log's path, or null when the board has no repo folder or nothing red to keep
 */
export function keepLandingLog(board, job, receipt) {
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  const folder = file && basename(dirname(file)) === 'pullboard' ? join(dirname(file), 'landings', String(job).replace(/[^\w.-]+/gu, '_').slice(0, 120)) : null;
  const rows = (receipt.returned ?? []).filter(row => typeof row?.detail === 'string');
  if (!folder || (!rows.length && !receipt.detail)) return null;
  try {
    fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const body = [`land job ${job}: ${receipt.outcome ?? 'red'}`, ...rows.map(row => `#${row.id} ${row.reason}:\n${row.detail}`), ...(rows.length ? [] : [String(receipt.detail)])].join('\n\n');
    fs.writeFile(join(folder, 'runner.log'), `${body}\n`, { mode: 0o600 });
    return join(folder, 'runner.log');
  } catch { return null; }
}

/**
 * Offer a land job again as a new job with the same offered payload and request, after its push failed. The id is the
 * first job's id plus `~r<n>`, since offering the same landing returns the job as it stands.
 * Why: a push-failed receipt marked its job done and nothing offered the accepted items again (#7791).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job - The failed land job's id.
 * @param {{ now?: number, holdMs?: number }} [options] - holdMs: no runner may claim the new job for this long, a backoff (#9102).
 * @returns {{ id: string, retry: number } | null} The new job, or null when the job has no offered payload.
 */
export function reofferLandingJob(db, job, { now = Date.now(), queue = null, holdMs = 0 } = {}) {
  // With runs_store on the failed job's offered row lives in the runs file, not on the board [B2,P7].
  const home = queue ? queue.runs.db : db;
  const row = home.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(job);
  if (!row) return null;
  const offered = JSON.parse(row.job_step_payload);
  const [, first, retry] = /^(.*?)(?:~r(\d+))?$/u.exec(job);
  const next = Number(retry ?? 0) + 1;
  const id = `${first}~r${next}`;
  offerJob(db, { id, kind: LANDING_JOB_KIND, priority: 'landing', needs: offered.needs ?? [], now, payload: offered.payload ?? null, request: offeredRequest(home, job) }, queue);
  // A claim takes only a job whose lease_until has passed, so an unowned lease_until in the future is the backoff [C7,#9102].
  if (holdMs > 0) holdJob(home, id, now + holdMs, { now });
  return { id, retry: next, ...(holdMs > 0 ? { until: now + holdMs } : {}) };
}

/** How many times a land job id has been offered again: 0 for the first offer. */
export function landingRetries(job) {
  return Number(/~r(\d+)$/u.exec(job)?.[1] ?? 0);
}
