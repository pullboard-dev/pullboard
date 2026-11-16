import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
/** Read-only machine settings retain the same validation as admission, without loading writers [C7]. */
import { validateCostPrices } from './prices.js';
import { validateRunnerRates } from './runner-rates.js';
import { Refused } from '../../../kernel/light.js';
import { machineSettingsFile } from '../../../resources/light.js';
import { parseMachineSettings } from '../../../queue/light.js';
import { validateGateQueue } from '../../../queue/light.js';
const DEFAULT_GATE_SLOTS = 2;

/**
 * Read the machine settings file as a plain object, or null when there is none.
 * Why: the queue light door stays free of file reads, so a logic test never reaches fs through it [C7].
 *
 * @param {string} file - The machine settings file the caller resolved.
 * @returns {object|null}
 */
function readMachineSettingsFile(file) {
  return parseMachineSettings(existsSync(file) ? readFileSync(file, 'utf8') : null, file);
}

/**
 * The machine settings a person sets that carry a plain value, by the kind of value each takes. Each one is also a
 * `pullboard settings <key> <value>` form, so the view can offer a copyable line for it [O5,O6,N26].
 * Why: a setting with no form leaves a person hand-editing settings.json, which the Settings page cannot teach.
 */
export const PERSON_SET = Object.freeze({
  'budget.dailyUsd': 'usd', 'budget.totalUsd': 'usd', scratch: 'folder',
  'gate.diskFloorMB': 'mb', 'gate.memoryFloorMB': 'mb', 'gate.queue.agingMinutes': 'minutes',
  'gate.queue.reviewsFirst': 'switch', 'gate.queue.currentReleaseFirst': 'switch', 'gate.browserFreeChecks': 'switch', 'gate.browserByLaunch': 'switch',
  'health.sentinel': 'switch', 'view.background': 'switch', 'relay.offerAtInit': 'switch',
});

/**
 * Turn what a person typed for one PERSON_SET key into the value to store, or undefined for `off` (clears the key).
 *
 * @param {string} key
 * @param {string} text
 * @returns {boolean|number|string|undefined}
 */
export function parsePersonSet(key, text) {
  const kind = PERSON_SET[key];
  const refuse = why => new Refused('BAD_MACHINE_SETTINGS', `${key} ${why}; run pullboard settings ${key} ${kind === 'switch' ? 'on|off' : kind === 'folder' ? '<folder>|off' : kind === 'usd' ? '<dollars>|off' : '<n>|off'}`);
  if (!kind) throw new Refused('BAD_MACHINE_SETTINGS', `${key} is not a setting a person sets from the command line`);
  if (kind === 'switch') {
    if (text !== 'on' && text !== 'off') throw refuse('must be on or off');
    return text === 'on';
  }
  if (text === 'off') return undefined;
  if (kind === 'folder') {
    if (!isAbsolute(text)) throw refuse('must be an absolute folder that exists, or off');
    return text;
  }
  if (kind === 'usd') {
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text) || !(Number(text) > 0)) throw refuse('must be a positive dollar amount, or off');
    return Number(text);
  }
  if (!/^[1-9]\d*$/u.test(text) && !(kind === 'mb' && text === '0') || !Number.isSafeInteger(Number(text))) throw refuse(kind === 'minutes' ? 'must be a whole number of minutes, 1 or more, or off' : 'must be a whole number of megabytes, or off');
  return Number(text);
}

const DEFAULT_BROWSER_SLOTS = 1;

/**
 * Which slot counts this machine's settings state outright. An unset count is only the default, so a pool that a
 * runner's own jobs already sized keeps its recorded capacity instead (#2541).
 */
export function declaredMachineSlots() {
  const value = readMachineSettingsFile(machineSettingsFile());
  return { gate: value?.gateSlots !== undefined, browser: value?.browserSlots !== undefined };
}

/**
 * The optional spend ceiling: an object holding only dailyUsd and/or totalUsd, each a positive dollar amount. Off
 * when unset, so a machine with no budget spends without a ceiling [N2].
 *
 * @param {unknown} budget the budget value from the machine settings file
 * @param {string} file the settings file named in any refusal
 */
function validateBudget(budget, file) {
  if (budget === undefined) return;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget) || Object.keys(budget).some(key => key !== 'dailyUsd' && key !== 'totalUsd')) {
    throw new Refused('BAD_MACHINE_SETTINGS', `budget in ${file} must be an object with dailyUsd and/or totalUsd; remove it to turn the spend ceiling off`);
  }
  for (const key of ['dailyUsd', 'totalUsd']) {
    if (budget[key] !== undefined && (typeof budget[key] !== 'number' || !Number.isFinite(budget[key]) || budget[key] <= 0)) {
      throw new Refused('BAD_MACHINE_SETTINGS', `budget.${key} in ${file} must be a positive dollar amount; remove it to turn that ceiling off`);
    }
  }
}

/**
 * Where `pullboard serve` listens: a literal IPv4 address of one of this machine's interfaces and a port. Off the
 * loopback address the API needs the machine's board key, so runners on the network can pull jobs [P7,O5].
 *
 * @param {unknown} serve the serve value from the machine settings file
 * @param {string} file the settings file named in any refusal
 */
export function validateServe(serve, file) {
  if (serve === undefined) return;
  if (!serve || typeof serve !== 'object' || Array.isArray(serve) || Object.keys(serve).some(key => key !== 'address' && key !== 'port')) {
    throw new Refused('BAD_MACHINE_SETTINGS', `serve in ${file} holds only address and port; remove it to serve on loopback`);
  }
  const octets = typeof serve.address === 'string' ? serve.address.split('.') : [];
  if (serve.address !== undefined && (octets.length !== 4 || octets.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255) || serve.address === '0.0.0.0')) {
    throw new Refused('BAD_MACHINE_SETTINGS', `serve.address in ${file} must be one interface's literal IPv4 address, such as 192.168.7.21; remove it to serve on loopback`);
  }
  if (serve.port !== undefined && (!Number.isSafeInteger(serve.port) || serve.port < 0 || serve.port > 65535)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `serve.port in ${file} must be a port from 0 to 65535; 0 chooses a free one`);
  }
}

/**
 * Check the board this machine's seats use over HTTP: board.url, an http(s) address, and board.token, the serve key [P7].
 * @param {unknown} board
 * @param {string} file
 */
export function validateBoardRemote(board, file) {
  if (board === undefined) return;
  if (!board || typeof board !== 'object' || Array.isArray(board) || Object.keys(board).some(key => !['url', 'token', 'commits'].includes(key))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `board in ${file} holds only url, token and commits; remove it to use the local board`);
  }
  // Off by default: with commits set to bundle, a submit by URL carries the clone's commits as one git bundle [P7,C7].
  if (board.commits !== undefined && board.commits !== 'bundle') throw new Refused('BAD_MACHINE_SETTINGS', `board.commits in ${file} must be bundle; run pullboard settings board.commits bundle, or off to remove it`);
  let url = null;
  try { url = board.url === undefined ? null : new URL(board.url); } catch { /* Refused below. */ }
  if (board.url !== undefined && (!url || !['http:', 'https:'].includes(url.protocol))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `board.url in ${file} must be an http or https address, such as http://100.64.0.2:4321; run pullboard settings board.url <url>`);
  }
  if (board.token !== undefined && (typeof board.token !== 'string' || !board.token || /\s/u.test(board.token))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `board.token in ${file} must be the key pullboard serve printed; run pullboard settings board.token <key>`);
  }
}

/** Read and validate machine settings, preserving any unrelated settings. */
export function loadMachineSettings() {
  const file = machineSettingsFile();
  const value = readMachineSettingsFile(file);
  if (!value) return { gateSlots: DEFAULT_GATE_SLOTS, browserSlots: DEFAULT_BROWSER_SLOTS };
  if (value.gate?.runnerWaitMs !== undefined) validateRunnerWaitMs(value.gate.runnerWaitMs);
  if (value.gate?.tripOverheadBudgetMs !== undefined && (!Number.isSafeInteger(value.gate.tripOverheadBudgetMs) || value.gate.tripOverheadBudgetMs < 1)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.tripOverheadBudgetMs in ${file} must be a positive whole number of milliseconds; remove it for the 10000 ms default`);
  }
  if (value.landing !== undefined && (!value.landing || typeof value.landing !== 'object' || Array.isArray(value.landing)
    // The landing switches sit beside pools, so a machine may set one without a pool [C7,#9102].
    || Object.keys(value.landing).some(key => !['pools', 'adaptiveBatch', 'reofferTrunkBusy', 'squash', 'strictFullSuite', 'reuseGateReceipts', 'reuseContractResults'].includes(key)) || (value.landing.pools !== undefined && !Array.isArray(value.landing.pools))
    || (value.landing.pools ?? []).some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/u.test(id)))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `landing.pools in ${file} lists the board identifiers this machine may land`);
  }
  if (value.health?.sentinel !== undefined && typeof value.health.sentinel !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `health.sentinel in ${file} must be true or false`);
  }
  if (value.gate?.browserFreeChecks !== undefined && typeof value.gate.browserFreeChecks !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.browserFreeChecks in ${file} must be true or false`);
  }
  if (value.gate?.runnersOnly !== undefined && typeof value.gate.runnersOnly !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.runnersOnly in ${file} must be true or false`);
  }
  if (value.gate?.handoffWorkers != null && (!Number.isSafeInteger(value.gate.handoffWorkers) || value.gate.handoffWorkers < 1)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.handoffWorkers in ${file} must be a whole number of 1 or more; remove it for the computed default`);
  }
  if (value.gate?.postLandSuite !== undefined && typeof value.gate.postLandSuite !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.postLandSuite in ${file} must be true or false`);
  }
  if (value.gate?.fencedHop !== undefined && typeof value.gate.fencedHop !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.fencedHop in ${file} must be true or false`);
  }
  if (value.gate?.recaptureHandoff !== undefined && typeof value.gate.recaptureHandoff !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.recaptureHandoff in ${file} must be true or false`);
  }
  if (value.gate?.mainCaseFilter !== undefined && typeof value.gate.mainCaseFilter !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.mainCaseFilter in ${file} must be true or false`);
  }
  if (value.gate?.endStaleJobs !== undefined && typeof value.gate.endStaleJobs !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.endStaleJobs in ${file} must be true or false`);
  }
  for (const key of ['jobs.handBackUnrunnable', 'runners.fetchFailFast', 'runners.drainOnFetchFailure', 'runners.postedLineNamesCase']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', `${key} in ${file} must be true or false`);
  }
  if (value.gate?.settleOnMainReceipt !== undefined && typeof value.gate.settleOnMainReceipt !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.settleOnMainReceipt in ${file} must be true or false`);
  }
  if (value.gate?.redFactLocation !== undefined && typeof value.gate.redFactLocation !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.redFactLocation in ${file} must be true or false`);
  }
  if (value.items?.typedFields !== undefined && typeof value.items.typedFields !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `items.typedFields in ${file} must be true or false`);
  }
  const testGroup = value.test;
  if (testGroup?.statusOutcomes !== undefined && typeof testGroup.statusOutcomes !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `test.statusOutcomes in ${file} must be true or false`);
  }
  if (value.tests?.registryStrict !== undefined && typeof value.tests.registryStrict !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `tests.registryStrict in ${file} must be true or false`);
  }
  if (value.census?.recordFileTimes !== undefined && typeof value.census.recordFileTimes !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `census.recordFileTimes in ${file} must be true or false`);
  }
  if (value.census?.rerunNonGreen !== undefined && typeof value.census.rerunNonGreen !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `census.rerunNonGreen in ${file} must be true or false`);
  }
  if (value.census?.rerunOnSettle !== undefined && typeof value.census.rerunOnSettle !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `census.rerunOnSettle in ${file} must be true or false`);
  }
  if (value['runners.yieldWhilePruning'] !== undefined && typeof value['runners.yieldWhilePruning'] !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `runners.yieldWhilePruning in ${file} must be true or false`);
  }
  if (value.census?.balanceByTime !== undefined && typeof value.census.balanceByTime !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `census.balanceByTime in ${file} must be true or false`);
  }
  if (value.census?.jobMinutes !== undefined && value.census.jobMinutes !== null && !(typeof value.census.jobMinutes === 'number' && Number.isFinite(value.census.jobMinutes) && value.census.jobMinutes > 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `census.jobMinutes in ${file} must be a number of minutes above 0, or null`);
  }
  if (value.jobs?.avoidRunners !== undefined && typeof value.jobs.avoidRunners !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `jobs.avoidRunners in ${file} must be true or false`);
  }
  if (value.push?.recordTiming !== undefined && typeof value.push.recordTiming !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `push.recordTiming in ${file} must be true or false`);
  }
  if (value.push?.rerunFailedShardOnce !== undefined && typeof value.push.rerunFailedShardOnce !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `push.rerunFailedShardOnce in ${file} must be true or false`);
  }
  if (value.census?.jobsPerRunner !== undefined && value.census.jobsPerRunner !== null && !(Number.isSafeInteger(value.census.jobsPerRunner) && value.census.jobsPerRunner >= 1)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `census.jobsPerRunner in ${file} must be a whole number of jobs, 1 or more, or null`);
  }
  if (value.moves?.shadow !== undefined && typeof value.moves.shadow !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `moves.shadow in ${file} must be true or false`);
  }
  for (const [table, live] of Object.entries(value.moves?.live ?? {})) {
    if (typeof live !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', `moves.live.${table} in ${file} must be true or false`);
  }
  if (value.gate?.tableReplay !== undefined && typeof value.gate.tableReplay !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.tableReplay in ${file} must be true or false`);
  }
  if (value.gate?.testNice !== undefined && typeof value.gate.testNice !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.testNice in ${file} must be true or false`);
  }
  if (value.gate?.sampleDiskIo !== undefined && typeof value.gate.sampleDiskIo !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.sampleDiskIo in ${file} must be true or false`);
  }
  if (value.gate?.runnersFirst !== undefined && typeof value.gate.runnersFirst !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.runnersFirst in ${file} must be true or false`);
  }
  if (value.gate?.browserByLaunch !== undefined && typeof value.gate.browserByLaunch !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.browserByLaunch in ${file} must be true or false`);
  }
  if (value.gate?.measuredSlots !== undefined && typeof value.gate.measuredSlots !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.measuredSlots in ${file} must be true or false`);
  }
  if (value.gate?.loadAwareDispatch !== undefined && typeof value.gate.loadAwareDispatch !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', 'gate.loadAwareDispatch must be true or false');
  if (value.gate?.runnerBusyCeiling !== undefined && (!Number.isFinite(value.gate.runnerBusyCeiling) || value.gate.runnerBusyCeiling < 1 || value.gate.runnerBusyCeiling > 100)) throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnerBusyCeiling must be a percentage from 1 through 100');
  // The controller value is gone from the schema: every runner job is a row a runner pulls, so "pull" is the only value [P7].
  if (value.gate?.runnerDispatch !== undefined && value.gate.runnerDispatch !== 'pull') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.runnerDispatch in ${file} must be "pull"; "controller" is removed because every runner job is a row a runner pulls; next: run pullboard settings gate.runnerDispatch pull`);
  }
  if (value.gate?.requireRunnerAttribution !== undefined && typeof value.gate.requireRunnerAttribution !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.requireRunnerAttribution in ${file} must be true or false`);
  }
  if (value.gate?.refuseMissingCheckFile !== undefined && typeof value.gate.refuseMissingCheckFile !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.refuseMissingCheckFile in ${file} must be true or false`);
  }
  if (value.gate?.refuseTempWorktree !== undefined && typeof value.gate.refuseTempWorktree !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.refuseTempWorktree in ${file} must be true or false`);
  }
  if (value.claim?.refuseOffMainHead !== undefined && typeof value.claim.refuseOffMainHead !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `claim.refuseOffMainHead in ${file} must be true or false`);
  }
  if (value.add !== undefined && (!value.add || typeof value.add !== 'object' || Array.isArray(value.add) || Object.keys(value.add).some(key => key !== 'warnUnnamedTest'))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `add in ${file} holds only warnUnnamedTest; remove other keys`);
  }
  if (value.add?.warnUnnamedTest !== undefined && typeof value.add.warnUnnamedTest !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `add.warnUnnamedTest in ${file} must be true or false`);
  }
  if (value.freeze?.refuseEmptyBar !== undefined && typeof value.freeze.refuseEmptyBar !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `freeze.refuseEmptyBar in ${file} must be true or false`);
  }
  if (value.holds?.requireOwner !== undefined && typeof value.holds.requireOwner !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `holds.requireOwner in ${file} must be true or false`);
  }
  if (value.review?.releaseReasons !== undefined && typeof value.review.releaseReasons !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `review.releaseReasons in ${file} must be true or false`);
  }
  if (value.health?.lapsedSweep !== undefined && typeof value.health.lapsedSweep !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `health.lapsedSweep in ${file} must be true or false`);
  }
  if (value.health?.derivedState !== undefined && typeof value.health.derivedState !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `health.derivedState in ${file} must be true or false`);
  }
  if (value.landing?.reofferTrunkBusy !== undefined && typeof value.landing.reofferTrunkBusy !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `landing.reofferTrunkBusy in ${file} must be true or false`);
  }
  if (value.landing?.reuseContractResults !== undefined && typeof value.landing.reuseContractResults !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `landing.reuseContractResults in ${file} must be true or false`);
  }
  if (value.landing?.reuseGateReceipts !== undefined && typeof value.landing.reuseGateReceipts !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `landing.reuseGateReceipts in ${file} must be true or false`);
  }
  if (value.landing?.adaptiveBatch !== undefined && typeof value.landing.adaptiveBatch !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `landing.adaptiveBatch in ${file} must be true or false`);
  }
  if (value.landing?.squash !== undefined && typeof value.landing.squash !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `landing.squash in ${file} must be true or false`);
  }
  if (value.landing?.strictFullSuite !== undefined && typeof value.landing.strictFullSuite !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `landing.strictFullSuite in ${file} must be true or false`);
  }
  if (value.spec?.commitOnApply !== undefined && typeof value.spec.commitOnApply !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `spec.commitOnApply in ${file} must be true or false`);
  }
  if (value.sentinels?.recordWriteHolder !== undefined && typeof value.sentinels.recordWriteHolder !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `sentinels.recordWriteHolder in ${file} must be true or false`);
  }
  if (value.next?.itemNotices !== undefined && typeof value.next.itemNotices !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `next.itemNotices in ${file} must be true or false`);
  }
  if (value.next?.readinessCheck !== undefined && typeof value.next.readinessCheck !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `next.readinessCheck in ${file} must be true or false`);
  }
  if (value.submit?.proofOnly !== undefined && typeof value.submit.proofOnly !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `submit.proofOnly in ${file} must be true or false`);
  }
  if (value.gate?.namedImportSelection !== undefined && typeof value.gate.namedImportSelection !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.namedImportSelection in ${file} must be true or false`);
  }
  if (value.list?.thinRead !== undefined && typeof value.list.thinRead !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `list.thinRead in ${file} must be true or false`);
  }
  if (value.maintenance?.retireIdleSeats !== undefined && typeof value.maintenance.retireIdleSeats !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `maintenance.retireIdleSeats in ${file} must be true or false`);
  }
  if (value.maintenance?.retireIdleHours !== undefined && !(Number.isFinite(value.maintenance.retireIdleHours) && value.maintenance.retireIdleHours > 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `maintenance.retireIdleHours in ${file} must be a positive number of hours`);
  }
  if (value.health?.diskFloorGb !== undefined && !(Number.isFinite(value.health.diskFloorGb) && value.health.diskFloorGb >= 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `health.diskFloorGb in ${file} must be a number of gigabytes, 0 or more`);
  }
  const reserve = value.gate?.jobReserve;
  if (reserve != null && (typeof reserve !== 'object' || Array.isArray(reserve) || Object.values(reserve).some(share => !Number.isFinite(share) || share < 0 || share > 1)
    || Object.values(reserve).reduce((sum, share) => sum + share, 0) > 1)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.jobReserve in ${file} must be { "interactive", "gate", "landing", "background": a share of 0 through 1 }, adding up to at most 1; remove it to keep the plain claim order`);
  }
  if (value.gate?.localRunner !== undefined && typeof value.gate.localRunner !== 'boolean') throw new Refused('BAD_MACHINE_SETTINGS', `gate.localRunner in ${file} must be true or false`);
  if (value.gate?.localLoadShare !== undefined && (!Number.isFinite(value.gate.localLoadShare) || value.gate.localLoadShare <= 0)) throw new Refused('BAD_MACHINE_SETTINGS', `gate.localLoadShare in ${file} must be a number above 0: the load per core below which the local runner takes a job`);
  if (value.gate?.submitAuthorization !== undefined && !['runner', 'local'].includes(value.gate.submitAuthorization)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.submitAuthorization in ${file} must be "runner" or "local"`);
  }
  if (value.gate?.mainComparison !== undefined && !['on-red', 'off'].includes(value.gate.mainComparison)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.mainComparison in ${file} must be "on-red" or "off"`);
  }
  const timingRunner = value.gate?.timingRunner;
  if (timingRunner !== undefined && timingRunner !== false && (typeof timingRunner !== 'string' || !timingRunner.trim() || timingRunner.trim() !== timingRunner)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.timingRunner in ${file} must be "auto", a registered runner host, or false`);
  }
  if (value.inspection?.clauses !== undefined && typeof value.inspection.clauses !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `inspection.clauses in ${file} must be true or false`);
  }
  validateServe(value.serve, file);
  validateBoardRemote(value.board, file);
  validateGateQueue(value, file);
  validateCostPrices(value.costPrices);
  validateRunnerRates(value.runnerRates);
  validateBudget(value.budget, file);
  if (value.view !== undefined && (!value.view || typeof value.view !== 'object' || Array.isArray(value.view)
    || (value.view.background !== undefined && typeof value.view.background !== 'boolean'))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `view in ${file} must be an object whose background is true or false; fix it before running Pullboard`);
  }
  if (value.relay?.offerAtInit !== undefined && typeof value.relay.offerAtInit !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `relay.offerAtInit in ${file} must be true or false`);
  }
  if (value.relay?.pruneReceipts !== undefined && typeof value.relay.pruneReceipts !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `relay.pruneReceipts in ${file} must be true or false`);
  }
  const canaryProblem = relayCanaryProblem(value.relay?.canary);
  if (canaryProblem) throw new Refused('BAD_MACHINE_SETTINGS', `relay.canary in ${file} is invalid: ${canaryProblem}`);
  const workerBudget = value.workers?.budget;
  if (workerBudget !== undefined && (!workerBudget || typeof workerBudget !== 'object' || Array.isArray(workerBudget)
    || !(typeof (workerBudget.spend ?? workerBudget.seatHours) === 'number' && Number.isFinite(workerBudget.spend ?? workerBudget.seatHours) && (workerBudget.spend ?? workerBudget.seatHours) >= 0)
    || !['day', 'week'].includes(workerBudget.window) || Object.keys(workerBudget).some(key => !['spend', 'seatHours', 'window'].includes(key))
    || (workerBudget.spend !== undefined && workerBudget.seatHours !== undefined))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `workers.budget in ${file} must be spend per day or week; run pullboard settings workers.budget 40/day`);
  }
  if (value.gate?.memoryFloorMB !== undefined && (!Number.isSafeInteger(value.gate.memoryFloorMB) || value.gate.memoryFloorMB < 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.memoryFloorMB in ${file} must be a whole number of megabytes, 0 or more; fix it before running Pullboard`);
  }
  if (value.gate?.diskFloorMB !== undefined && (!Number.isSafeInteger(value.gate.diskFloorMB) || value.gate.diskFloorMB < 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.diskFloorMB in ${file} must be a whole number of megabytes, 0 or more; fix it before running Pullboard`);
  }
  const runners = value.runners ?? [];
  if (!Array.isArray(runners)) throw new Refused('BAD_MACHINE_SETTINGS', 'runners must be an array; use pullboard runner add <ssh-host> --slots <n> --browser <n>');
  const seen = new Set();
  for (const runner of runners) {
    validateRunner(runner);
    if (seen.has(runner.host)) throw new Refused('BAD_MACHINE_SETTINGS', 'runner hosts must be unique; remove the duplicate machine setting');
    seen.add(runner.host);
  }
  const gateSlots = value.gateSlots ?? DEFAULT_GATE_SLOTS;
  if (!Number.isSafeInteger(gateSlots) || gateSlots < 0 || gateSlots === 0 && runners.length === 0) {
    throw new Refused('BAD_GATE_SLOTS', `gateSlots in ${file} must be positive, or 0 with a registered runner; run pullboard runner add <ssh-host> --slots <n> --browser <n>`);
  }
  const browserSlots = value.browserSlots ?? DEFAULT_BROWSER_SLOTS;
  if (!Number.isSafeInteger(browserSlots) || browserSlots < 0 || browserSlots > gateSlots || browserSlots === 0 && runners.length === 0) {
    throw new Refused('BAD_BROWSER_SLOTS', `browserSlots in ${file} must be positive and no greater than gateSlots (${gateSlots}), or 0 with a registered runner; run pullboard settings browserSlots <n>`);
  }
  const shortSlots = value.gate?.shortSlots;
  if (shortSlots !== undefined && (!Number.isSafeInteger(shortSlots) || shortSlots < 0)) {
    throw new Refused('BAD_SHORT_SLOTS', `gate.shortSlots in ${file} must be a whole number, 0 or more; run pullboard settings gate.shortSlots <n>`);
  }
  return { ...value, gateSlots, browserSlots, ...(runners.length ? { runners } : {}) };
}

/** Hours a seat worktree must sit untouched before maintenance retires it (#9109), or null while maintenance.retireIdleSeats is off (default). */
export function retireIdleSeatHours() {
  const settings = loadMachineSettings().maintenance;
  return settings?.retireIdleSeats === true ? settings.retireIdleHours ?? 3 : null;
  }
/** Free gigabytes below which pullboard health warns (#9110); 0, the default, never warns. */
export function healthDiskFloorGb() {
  return loadMachineSettings().health?.diskFloorGb ?? 0;
}

/** Whether old relay request receipts are dropped (#9337): off by default; only an exact `true` turns it on. */
export function relayPruneReceipts() {
  return loadMachineSettings().relay?.pruneReceipts === true;
}

/** Whether pullboard list reads through the thin read door (#9089): off by default; only an exact `true` turns it on. */
export function listThinRead() {
  return loadMachineSettings().list?.thinRead === true;
}

/**
 * Whether affected-test selection follows named imports through a re-exporting door: gate.namedImportSelection, default off.
 * Why: one door re-exporting a changed module selected every test that imports the door, whatever name it took [C7].
 */
export function namedImportSelectionOn() {
  return loadMachineSettings().gate?.namedImportSelection === true;
}


/** Whether a submit with no change may pass for an item that is all ticked proof clauses (#9105): off by default; only an exact `true` turns it on. */
export function submitProofOnly() {
  return loadMachineSettings().submit?.proofOnly === true;
}


/** Validate an SSH destination as one argument, never a command or an SSH option. */
export function validateRunner(value) {
  if (!value || typeof value.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u.test(value.host)
    || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0 || value.browser > value.slots) {
    throw new Refused('BAD_RUNNER', 'use an SSH host or alias, positive --slots, and --browser from zero through slots');
  }
  if (value.gui !== undefined && value.gui !== null && typeof value.gui !== 'boolean') throw new Refused('BAD_RUNNER', 'runner gui must be true, false, or unknown');
  if (value.publicKey !== undefined) {
    const key = value.publicKey;
    let der;
    try { der = typeof key === 'string' ? Buffer.from(key, 'base64url') : Buffer.alloc(0); }
    catch { der = Buffer.alloc(0); }
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{59}$/u.test(key) || der.length !== 44
      || der.toString('base64url') !== key || der.subarray(0, 12).toString('hex') !== '302a300506032b6570032100') {
      throw new Refused('BAD_RUNNER', 'runner publicKey must be an enrolled Ed25519 SPKI key; run pullboard runner add <ssh-host>');
    }
  }
  for (const key of ['node', 'root']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || /[\u0000-\u001f\u007f]/u.test(value[key])
      || !(value[key].startsWith('/') && value[key].length > 1 || key === 'node' && value[key] === 'node'))) {
      throw new Refused('BAD_RUNNER', `runner ${key} must be an absolute remote path${key === 'node' ? ' or node' : ''}`);
    }
  }
  if (value.toolchains !== undefined) validateToolchains(value.toolchains);
  if (value.fixed !== undefined && typeof value.fixed !== 'boolean') throw new Refused('BAD_RUNNER', 'runner fixed must be true or false');
  if (value.drain !== undefined && typeof value.drain !== 'boolean') throw new Refused('BAD_RUNNER', 'runner drain must be true or false');
  for (const key of ['cores', 'memoryMB']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1)) throw new Refused('BAD_RUNNER', `runner ${key} must be a positive whole number measured on the runner`);
  }
  if (value.measuredAt !== undefined && !Number.isFinite(Date.parse(value.measuredAt))) throw new Refused('BAD_RUNNER', 'runner measuredAt must be a timestamp');
  if (value.cpuLoad !== undefined && !validRunnerCpuLoad(value.cpuLoad)) throw new Refused('BAD_RUNNER', 'runner CPU load requires its own timestamp, busy percentage and three load averages');
  return { host: value.host, ...(value.cpuLoad ? { cpuLoad: value.cpuLoad } : {}), slots: value.slots, browser: value.browser, ...(value.gui !== undefined ? { gui: value.gui } : {}),
    ...(value.publicKey ? { publicKey: value.publicKey } : {}),
    ...(value.node ? { node: value.node } : {}), ...(value.root ? { root: value.root } : {}),
    ...(value.toolchains && Object.keys(value.toolchains).length ? { toolchains: { ...value.toolchains } } : {}),
    ...(value.fixed === true ? { fixed: true } : {}), ...(value.drain === true ? { drain: true } : {}),
    ...(value.cores !== undefined && value.memoryMB !== undefined ? { cores: value.cores, memoryMB: value.memoryMB, ...(value.measuredAt !== undefined ? { measuredAt: value.measuredAt } : {}) } : {}) };
}


/**
 * Check a runner's toolchains: names (node, python, go, cargo, dotnet) mapped to a version string, empty when any version serves.
 * Why: a job is admitted only where its project's toolchains exist, so the record must be exact and bounded [C7].
 */
export function validateToolchains(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Refused('BAD_RUNNER', 'runner toolchains must map names to versions, for example node=22,python=3.12');
  const names = Object.keys(value);
  if (names.length > 32) throw new Refused('BAD_RUNNER', 'a runner declares at most 32 toolchains');
  for (const name of names) {
    if (!/^[a-z][a-z0-9+_-]{0,31}$/u.test(name)) throw new Refused('BAD_RUNNER', `toolchain name "${name}" must be lowercase letters, digits, +, _ or -; for example node, python, go, cargo`);
    if (typeof value[name] !== 'string' || !/^[0-9A-Za-z._+-]{0,32}$/u.test(value[name])) throw new Refused('BAD_RUNNER', `toolchain ${name} version must be up to 32 letters, digits, dots, +, _ or -; for example ${name}=22`);
  }
  return value;
}

/** Parse the --toolchain flag text, "node=22,python=3.12,cargo", into the toolchains record. */
export function parseToolchains(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Refused('BAD_RUNNER', 'use --toolchain node=22,python=3.12,go=1.23 (a name, optionally =version, comma separated)');
  const out = {};
  for (const part of text.split(',')) {
    const [name, ...version] = part.trim().split('=');
    if (Object.hasOwn(out, name)) throw new Refused('BAD_RUNNER', `toolchain ${name} is listed twice`);
    out[name] = version.join('=');
  }
  return validateToolchains(out);
}

/** Validate only execution settings; credentials remain in the existing board link and device key store. */
export function relayCanaryConfig(value) {
  const problem = relayCanaryProblem(value);
  if (problem) throw new Refused('RELAY_CANARY_CONFIG', problem);
  return normalCanary(value);
}

/**
 * Name what is wrong with a stored canary setting, or return null when it is valid or absent.
 * Why: machine settings load on every move, so they report a bad canary as BAD_MACHINE_SETTINGS
 * without raising the canary command's own refusal from unrelated moves.
 */
function relayCanaryProblem(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || typeof value.root !== 'string' || !isAbsolute(value.root)
    || typeof value.agentId !== 'string' || !value.agentId || /\s/u.test(value.agentId)
    || Object.keys(value).some(key => !['enabled', 'root', 'agentId', 'deadlineMs'].includes(key))) {
    return 'configure a dedicated linked seat with pullboard relay canary on; credentials are never command arguments';
  }
  const deadlineMs = value.deadlineMs ?? 5000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 25000) {
    return 'set the canary timeout between 100 and 25000 milliseconds, below its one-minute cadence';
  }
  return null;
}

/** Copy only the known canary fields, defaulting the deadline; the value is already validated. */
function normalCanary(value) {
  if (value === undefined || value === null) return null;
  return { enabled: value.enabled, root: value.root, agentId: value.agentId, deadlineMs: value.deadlineMs ?? 5000 };
}

export const DEFAULT_RUNNER_WAIT_MS = 300_000;

/** Validate a machine's finite runner wait without allowing Node timer overflow. */
export function validateRunnerWaitMs(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Refused('BAD_MACHINE_SETTINGS', 'gate.runnerWaitMs must be a positive whole number of milliseconds, at most 2147483647; run pullboard settings gate.runnerWaitMs <n>');
  }
  return value;
}

/** Validate a runner-published two-sample CPU observation without treating an absent reading as idle. */
export function validRunnerCpuLoad(value) {
  return value !== null && typeof value === 'object' && Number.isFinite(Date.parse(value.at))
    && Number.isFinite(value.busyPercent) && value.busyPercent >= 0 && value.busyPercent <= 100
    && Array.isArray(value.average) && value.average.length === 3 && value.average.every(n => Number.isFinite(n) && n >= 0);
}

/**
 * The board this machine's seats read over HTTP, or null for the local board: board.url and board.token [P7].
 * Why: a seat on another host has no board.sqlite; it reaches the board host's pullboard serve instead.
 * @returns {{ url: string, token: string, commits?: 'bundle' } | null}
 */
export function boardRemote() {
  const board = loadMachineSettings().board;
  return board?.url ? { url: board.url, token: board.token ?? '', ...(board.commits ? { commits: board.commits } : {}) } : null;
}
