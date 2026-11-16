/** Read-only, allowlisted settings projection for the local API [O5,O6]. */
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  configFromSource,
  defaults,
  loadConfig,
} from '../main.js';
import { repoInfo } from '../../../../git/index.js';
import {
  machineSettingsFile,
} from '../../../../resources/index.js';
import {
  LINE_SETTING_DEFINITIONS,
  validateLineSetting,
} from '../../../../queue/index.js';
import {
  gateQueueSettings,
  loadMachineSettings,
} from '../settings.js';
import { Refused } from '../../../../kernel/index.js';
import { describeSetting } from './descriptions.js';
import { environmentProblem } from '../main.js';

const MACHINE_DEFAULTS = {
  gateSlots: 2, browserSlots: 1, 'gate.shortSlots': 0, 'gate.runnerWaitMs': 300_000, 'gate.tripOverheadBudgetMs': 10_000,
  'gate.queue.reviewsFirst': false, 'gate.queue.currentReleaseFirst': false, 'gate.queue.agingMinutes': 30,
  'gate.memoryFloorMB': null, 'gate.diskFloorMB': 10_240, 'gate.browserFreeChecks': false, 'gate.browserByLaunch': false, 'gate.runnersFirst': false, 'gate.runnersOnly': false, 'gate.refuseMissingCheckFile': false, 'gate.refuseTempWorktree': false, 'gate.runnerDispatch': 'pull', 'gate.requireRunnerAttribution': false, 'gate.jobReserve': null, 'gate.localRunner': true, 'gate.localLoadShare': 1, 'gate.staticSlots': 2, 'gate.staticMemo': false, 'gate.namedImportSelection': false, 'gate.mainComparison': 'on-red', 'gate.submitAuthorization': 'runner', 'gate.handoffWorkers': null, 'budget.dailyUsd': null, 'budget.totalUsd': null, 'gate.measuredSlots': false, 'gate.loadAwareDispatch': true, 'gate.runnerBusyCeiling': 90, 'gate.timingRunner': 'auto', 'gate.postLandSuite': false, 'gate.tableReplay': false, 'gate.fencedHop': true, 'gate.testNice': false, 'gate.sampleDiskIo': false, 'gate.endStaleJobs': false, 'gate.redFactLocation': false, 'gate.recaptureHandoff': false, 'gate.mainCaseFilter': false, 'gate.settleOnMainReceipt': false, 'inspection.clauses': false, 'holds.requireOwner': false, 'review.releaseReasons': false, 'health.lapsedSweep': false, 'health.derivedState': false, 'sentinels.recordWriteHolder': false, 'next.itemNotices': false, 'list.thinRead': false,
  'maintenance.retireIdleSeats': false, 'maintenance.retireIdleHours': 3,
  'health.diskFloorGb': 0,
  'health.sentinel': true, 'view.background': true, 'relay.offerAtInit': true, runners: [], runnerRates: {}, 'landing.pools': [], 'landing.reofferTrunkBusy': false, 'landing.squash': false, 'landing.reuseGateReceipts': false,
  'runners.fetchFailFast': false, 'runners.drainOnFetchFailure': false,
  'submit.proofOnly': false, 'census.rerunNonGreen': false,
  'serve.address': '127.0.0.1', 'serve.port': 0, scratch: null, 'moves.shadow': false, 'tests.registryStrict': false, 'test.statusOutcomes': false, 'census.balanceByTime': false, 'census.recordFileTimes': false, 'moves.live.claim': false, 'moves.live.outbox': false, 'moves.live.handoff': false, 'moves.live.submit': false, 'moves.live.outcome': false, 'moves.live.job': false, 'moves.live.reopen': false,
  'jobs.avoidRunners': false, 'census.jobMinutes': null, 'census.jobsPerRunner': null, 'claim.refuseOffMainHead': false,
  'runners.yieldWhilePruning': false, 'runners.postedLineNamesCase': false,
};
const OPTIONAL_REPO_DEFAULTS = {
  'submit.handoff': false, 'withdraw.review': false, 'withdraw.refuseLanded': false,
  project: null, name: null, generated: null, tiers: null, laneMode: 'on', 'checks.provesNothing': 'warn', 'verify.unrelatedTrunkMoves': false, 'verify.landedReviews': false, 'verify.queueAccept': false, 'verify.requireRowRewrite': false, 'resume.adoptOrphans': false, 'verify.composeAtAdmission': false, 'verify.familyRelaxAt': null,
  'flakes.rerun': false, 'flakes.quarantine': false, 'rigor.budget': 400, 'rigor.autoDraft': true, 'cells.cache': false, 'cells.shimMaxAgeDays': 7, 'relay.outbox': true, 'relay.board': null,
  submitGate: null, submitDeferAbove: null, landingShards: 1, 'landing.publish': null, 'landing.pauseOnRed': false, 'landing.manualOverride': false, 'landing.perItem': true, 'landing.shardProof': false, 'landing.pipeline': false, 'landing.landedFromMain': false, 'landing.ledgerMainReds': false, 'landing.adaptiveBatch': false, 'landing.first': null, 'landing.auditOnly': null, 'landing.environment': null, 'landing.trunkRemote': null, positiveControl: null, affectedTests: null, affectedSuites: null,
  'inbox.keepUntilActed': false, 'inbox.escalateAfterMinutes': null, 'queue.contention': false, 'queue.contentionThreshold': 1,
  'health.sentinel': true, 'testConcurrency.browser': 2, approvers: null, 'claims.perSeat': null, 'claims.itemsInGate': false, 'claims.itemsInGateMax': 3, 'claims.fileLease': false, 'claims.fileLeaseHubs': [], 'seat.checkpoints': false,
};

/** Read one optional object without migrations, writes, or parser diagnostics containing its bytes. */
function readObject(file) {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Refused('BAD_SETTINGS', `cannot read settings in ${file}; restore a JSON object`); }
}

/** Resolve a supported dotted key without inheriting unrelated object members. */
function at(value, key) {
  // A key under `runners` is stored flat, since `runners` is the list of registered runners and cannot hold fields [C7,#9024].
  if (value && typeof value === 'object' && Object.hasOwn(value, key)) return value[key];
  return key.split('.').reduce((part, name) => part && Object.hasOwn(part, name) ? part[name] : undefined, value);
}

/** Keep only explicitly supported fields in a user-defined structured record. */
function fields(value, names) {
  return Object.fromEntries(names.filter(name => value?.[name] !== undefined).map(name => [name, value[name]]));
}

/** Project structured settings without returning unknown nested metadata or credential fields. */
function safeValue(key, value) {
  if (key === 'landing.environment' && value !== null && environmentProblem(value)) throw new Refused('BAD_SETTINGS', 'landing.environment needs exact platform, arch and Node version');
  if (key === 'landing.pools' && (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/u.test(id)))) throw new Refused('BAD_SETTINGS', 'landing.pools lists board identifiers');
  const strings = entries => Array.isArray(entries) && entries.every(entry => typeof entry === 'string');
  if (key === 'products' && !Object.values(value).every(strings)) throw new Refused('BAD_SETTINGS', 'products must map names to spec-id lists');
  if (key === 'runners') return value.map(runner => fields(runner, ['host', 'slots', 'browser', 'node', 'root']));
  if (key === 'lanes') return Object.fromEntries(Object.entries(value).map(([name, lane]) => [name, fields(lane, ['owns', 'specs', 'starts'])]));
  if (key === 'fix') return value.map(fixer => fields(fixer, ['run', 'files']));
  return value;
}

/** Enumerate supported default leaves, keeping dynamic maps and lists as single settings. */
function leaves(value, prefix = '') {
  return Object.entries(value).flatMap(([key, entry]) => {
    const name = prefix ? prefix + '.' + key : key;
    return entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length
      ? leaves(entry, name) : [[name, entry]];
  });
}

/** Refuse malformed supported scalar settings without echoing credential-bearing input. */
function checkedValue(key, value, fallback) {
  // gate.timingRunner is "auto", a runner host, or false (off), as the machine settings loader accepts.
  if (key === 'gate.timingRunner' && value === false) return value;
  const expected = key === 'landing.environment' ? 'object' : fallback === null
    ? (key === 'gate.memoryFloorMB' || key === 'submitDeferAbove' || key === 'claims.perSeat' || key.startsWith('resources.') ? 'number' : key === 'approvers' ? 'array' : 'string') : typeof fallback;
  if (value !== null && (expected === 'array' ? !Array.isArray(value) : expected !== 'object' && typeof value !== expected)) {
    throw new Refused('BAD_SETTINGS', `setting ${key} has an unsupported type; restore its documented value`);
  }
  if (key === 'relay.excluded' && (!Array.isArray(value) || !value.every(entry => typeof entry === 'string'))) {
    throw new Refused('BAD_SETTINGS', 'relay.excluded must be a list of repository paths');
  }
  if (key.endsWith('.url') && value !== null) {
    let url;
    try { url = new URL(value); } catch { throw new Refused('BAD_SETTINGS', 'restore the relay origin URL'); }
    if (url.username || url.password || url.search || url.hash) throw new Refused('BAD_SETTINGS', 'relay origins cannot carry credentials or query parameters');
  }
  return safeValue(key, value);
}

/** Say in plain words which setting holds the wrong kind of value, where it lives and how to restore it. */
function badValue(key, fallback, file) {
  const label = describeSetting(key).label || key;
  const documented = fallback === null || fallback === undefined ? 'its documented value' : JSON.stringify(fallback);
  return { message: `${label} (${key}) holds the wrong kind of value.`,
    fix: `Set ${key} back to ${documented} or remove it from ${file}.` };
}

/** Append one setting with both its effective value and explicit provenance. */
function add(rows, { scope, board, root, file, raw, effective = raw }, key, fallback, { secret = false, value = at(effective, key), source, origin, error } = {}) {
  // One wrong-typed value becomes that row's plain-words problem; every other setting is still listed.
  let problem = error;
  let shown = null;
  if (!error && !secret) {
    try { shown = checkedValue(key, value ?? fallback, fallback); }
    catch (refusal) { if (!(refusal instanceof Refused) || refusal.code !== 'BAD_SETTINGS') throw refusal; problem = badValue(key, fallback, file); }
  }
  rows.push({ key, scope, ...(board ? { board, root } : {}), value: problem ? null : secret ? (value ? 'set' : 'not set') : shown,
    default: secret ? 'not set' : fallback, source: source ?? file,
    origin: origin ?? (at(raw, key) === undefined ? 'default' : 'configured'), ...describeSetting(key), ...(secret ? { secret: true } : {}), ...(problem ? { error: problem } : {}) });
}

/** Remove one configured leaf in memory so the ordinary parser can isolate one bad setting. */
function withoutSetting(raw, key) {
  const candidate = structuredClone(raw);
  const parts = key.split('.');
  let parent = candidate;
  for (const part of parts.slice(0, -1)) {
    if (!parent?.[part] || typeof parent[part] !== 'object' || Array.isArray(parent[part])) {
      if (parts[0] === 'verify' && typeof candidate.verify === 'string') {
        delete candidate.verify;
        return candidate;
      }
      return null;
    }
    parent = parent[part];
  }
  const leaf = parts.at(-1);
  if (!Object.hasOwn(parent, leaf)) return null;
  delete parent[leaf];
  return candidate;
}

/** Keep healthy rows when precisely one configured leaf makes loadConfig refuse. */
function repoConfigForInventory(root, raw, supported) {
  try { return { effective: loadConfig(root), invalidKey: null }; }
  catch (error) {
    if (!(error instanceof Refused) || error.code !== 'BAD_CONFIG') throw error;
    let sourceProblem;
    try { configFromSource(JSON.stringify(raw)); }
    catch (problem) { sourceProblem = problem; }
    if (!sourceProblem) throw error;
    if (!(sourceProblem instanceof Refused) || sourceProblem.code !== 'BAD_CONFIG') throw sourceProblem;
    for (const key of supported.keys()) {
      const candidate = withoutSetting(raw, key);
      if (!candidate) continue;
      try { return { effective: configFromSource(JSON.stringify(candidate)), invalidKey: key }; }
      catch (candidateError) {
        if (!(candidateError instanceof Refused) || candidateError.code !== 'BAD_CONFIG') throw candidateError;
      }
    }
    throw error;
  }
}

/** Give a precise repair for the numeric submit threshold and a safe repair for other keys. */
function settingError(key) {
  return { message: `Invalid ${key} setting.`, fix: key === 'submitDeferAbove'
    ? 'Use a whole number at least 1 with submitGate set to landing, or remove submitDeferAbove.'
    : `Restore ${key} to its documented value in pullboard.json.` };
}

/** Read machine configuration and credential presence without migrating legacy relay sessions. */
function machineSettings(rows, { defaultViewPort, DEFAULT_VIEW_PORT }) {
  const file = machineSettingsFile();
  const raw = readObject(file);
  loadMachineSettings();
  gateQueueSettings();
  const context = { scope: 'machine', file, raw };
  for (const [key, fallback] of Object.entries(MACHINE_DEFAULTS)) add(rows, context, key, fallback);
  add(rows, context, 'view.port', DEFAULT_VIEW_PORT, { value: defaultViewPort(), source: process.env.PULLBOARD_VIEW_PORT === undefined ? 'built-in' : 'environment:PULLBOARD_VIEW_PORT', origin: process.env.PULLBOARD_VIEW_PORT === undefined ? 'default' : 'configured' });
  const relayFile = join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'relay-machine', 'state.json');
  const relay = readObject(relayFile);
  const relayContext = { scope: 'machine', file: relayFile, raw: { relay } };
  add(rows, relayContext, 'relay.autoLink', false);
  add(rows, relayContext, 'relay.excluded', []);
  add(rows, relayContext, 'relay.owner.account', null, { value: relay.owner?.account ?? relay.session?.account, origin: relay.owner?.account !== undefined || relay.session?.account !== undefined ? 'configured' : 'default' });
  add(rows, relayContext, 'relay.owner.url', null, { value: relay.owner?.url ?? relay.session?.url, origin: relay.owner?.url !== undefined || relay.session?.url !== undefined ? 'configured' : 'default' });
  add(rows, relayContext, 'relay.session.token', 'not set', { secret: true });
}

/** Project every supported repository setting plus its board's relay connection configuration. */
function repositorySettings(rows, board, { performanceCores }) {
  const info = repoInfo(board.root);
  const file = join(info.root, 'pullboard.json');
  const raw = readObject(file);
  const supported = new Map([...leaves(defaults()), ...Object.entries(OPTIONAL_REPO_DEFAULTS), ['testConcurrency.files', performanceCores()]]);
  const { effective, invalidKey } = repoConfigForInventory(info.root, raw, supported);
  const context = { scope: 'repo', board: board.id, root: info.root, file, raw, effective };
  for (const [key, fallback] of supported) {
    const value = key === 'testConcurrency.browser' ? Math.min(effective.testConcurrency?.files ?? supported.get('testConcurrency.files'), effective.testConcurrency?.browser ?? 2) : at(effective, key);
    // Legacy scalar verify configures only policy; its synthesized siblings retain default provenance.
    const origin = key === 'verify.policy' && typeof raw.verify === 'string' ? 'configured' : undefined;
    add(rows, context, key, fallback, { value, origin: key === invalidKey ? 'configured' : origin,
      ...(key === invalidKey ? { error: settingError(key) } : {}) });
  }
  const relayFile = join(info.commonDir, 'pullboard', 'relay.json');
  const relay = readObject(relayFile);
  const deletedFile = join(info.commonDir, 'pullboard', 'relay-deleted.json');
  const relayContext = { scope: 'board', board: board.id, root: info.root, file: relayFile, raw: { relay } };
  add(rows, { ...relayContext, file: deletedFile }, 'relay.deleted', false, { value: existsSync(deletedFile), origin: existsSync(deletedFile) ? 'configured' : 'default' });
  for (const [key, fallback] of Object.entries({ 'relay.url': null, 'relay.board': null, 'relay.agent': null, 'relay.personReauth': false, 'relay.keyStorage': null })) add(rows, relayContext, key, fallback);
  const environmentToken = process.env.PULLBOARD_RELAY_TOKEN;
  add(rows, relayContext, 'relay.token', 'not set', { secret: true, value: environmentToken ?? relay.token,
    source: environmentToken === undefined ? relayFile : 'environment:PULLBOARD_RELAY_TOKEN', origin: environmentToken === undefined && !relay.token ? 'default' : 'configured' });
  add(rows, relayContext, 'relay.agentTokens', 'not set', { secret: true, value: Object.values(relay.agentTokens ?? {}).some(value => typeof value?.token === 'string' && value.token.length > 0) });
  const keyFile = join(process.env.PULLBOARD_HOME || join(homedir(), '.pullboard'), 'relay-keys', board.id + '.key');
  const keyEnvironment = process.env.PULLBOARD_RELAY_KEY;
  add(rows, { ...relayContext, file: keyFile }, 'relay.key', 'not set', { secret: true,
    value: existsSync(keyFile) || keyEnvironment !== undefined || relay.keyStorage === 'keychain',
    origin: existsSync(keyFile) || keyEnvironment !== undefined || relay.keyStorage === 'keychain' ? 'configured' : 'default',
    source: existsSync(keyFile) ? keyFile : keyEnvironment !== undefined ? 'environment:PULLBOARD_RELAY_KEY' : relay.keyStorage === 'keychain' ? 'system keychain' : keyFile });
}

/** Include board-owned line inputs in the existing read-only inventory, without exposing reasons or window evidence. */
function boardLineSettings(rows, board) {
  const file = join(repoInfo(board.root).commonDir, 'pullboard', 'board.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const read = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?');
    for (const key of Object.keys(LINE_SETTING_DEFINITIONS)) {
      const stored = read.get('line_setting:' + key);
      let value = false;
      if (stored) {
        try { value = JSON.parse(stored.meta_value); }
        catch { throw new Refused('BAD_SETTINGS', 'a stored board line setting is malformed; restore its recorded value'); }
      }
      validateLineSetting(key, value);
      rows.push({ key: 'line.' + key, scope: 'board', board: board.id, root: board.root,
        value, default: false, source: file, origin: stored ? 'configured' : 'default', ...describeSetting('line.' + key) });
    }
  } finally { db.close(); }
}

/** Read a registered board identity without creating, migrating, or repairing its database. */
function registeredBoard(project) {
  const info = repoInfo(project.root);
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='board_meta'").get()) return null;
    const id = db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('board_id')?.meta_value;
    return typeof id === 'string' && /^[0-9a-f]{32}$/u.test(id) ? { ...project, id } : null;
  } finally { db.close(); }
}

/** Read authorized settings using runtime defaults supplied by the API's composition layer. */
export function settingsInventory(projects, selected, providers) {
  const rows = [];
  const boards = [];
  const warnings = [];
  for (const project of projects) {
    try {
      const board = registeredBoard(project);
      if (board) boards.push(board);
      else warnings.push({ root: project.root, code: 'BOARD_UNAVAILABLE', message: 'board identity is unavailable; restore the registered board before reading its settings' });
    } catch {
      warnings.push({ root: project.root, code: 'BOARD_UNAVAILABLE', message: 'cannot read the registered board identity without repairing its storage' });
    }
  }
  const authorized = selected === null ? boards : boards.filter(board => board.id === selected);
  if (selected !== null && !authorized.length) throw new Refused('NO_BOARD', 'no registered board with this identity; use GET /api/v1/boards');
  machineSettings(rows, providers);
  for (const board of authorized) { repositorySettings(rows, board, providers); boardLineSettings(rows, board); }
  return { settings: rows, ...(warnings.length ? { warnings } : {}) };
}
