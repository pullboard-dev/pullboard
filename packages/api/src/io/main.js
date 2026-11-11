import { fileChangeWaiter } from '../../../activity/index.js';
import { claimHealthSnapshot } from '../../../health/index.js';
import { recordedClaimWorktrees } from '../../../activity/index.js';
import { claimOverlaps } from '../../../items/index.js';
import { workQueue } from '../../../items/index.js';
import { costAnalytics } from '../../../stats/index.js';
import { personSigningPresentation } from '../../../person/index.js';
import { projectFit } from '../../../blueprints/index.js';
import { pendingFit } from '../../../blueprints/index.js';
import { fitFile } from '../../../blueprints/index.js';
import { lifecycleEvent } from '../../../items/index.js';
import { withdrawnFrom } from '../../../items/index.js';
import { verifiedPasskeyRowDecision } from '../../../person/index.js';
import { gitSpawnSync } from '../../../git/index.js';
import { counterProofStats } from '../../../verify/index.js';
import { proofStats } from '../../../stats/index.js';
import { isProofAgent } from '../../../stats/index.js';
import { buildLocalBoardState } from '../../../store/index.js';
import { stateFileInputs } from '../../../store/index.js';
import { fileRevision } from '../../../store/index.js';
import { WHOLE_STATE_DELTA_FIELDS } from '../logic/fields.js';
import { capacityAtRead } from '../../../stats/index.js';
import { nativeStateClockMatches } from '../../../store/index.js';
import {
  dependencyValues,
  localDependencyIds,
} from '../../../items/index.js';
/** The local API v1: the CLI's moves, persistent board identities and live events (A2). */
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createServer } from 'node:http';
import {
  basename,
  join,
  resolve,
} from 'node:path';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { displayAgentName } from '../../../seats/index.js';
import { withProjectGitTimeout } from '../../../git/index.js';
import { sameCommonDir } from '../../../git/index.js';
import * as store from '../../../store/index.js';
import { roadmap } from '../../../store/index.js';
import {
  COORDINATOR,
  loadConfig,
} from '../../../config/index.js';
import {
  codeIsFromMain,
  repoInfo,
  resolveCommit,
  withGitReadFacts,
} from '../../../git/index.js';
import {
  relayLinked,
  relayOperation,
  relayRevoke,
  relayTokens,
} from '../../../link/index.js';
import { laneNames } from '../../../seats/index.js';
import { MACHINE } from '../../../state/index.js';
import {
  listApiProjects,
  registryFile,
  registeredProjectRootsSnapshot,
} from '../../../seats/index.js';
import { milestoneRoadmap } from '../../../roadmap/index.js';
import {
  ruleProofWindow,
} from '../../../verify/index.js';
import {
  SUMMARY_KEYS,
  itemSummary,
} from '../../../items/index.js';
import {
  compareFlowWindows,
  prepareFlowHistory,
  projectFlowStats,
} from '../../../stats/index.js';
import {
  projectItemSpecApprovals,
  specApprovalState,
} from '../../../spec/index.js';
import { Refused } from '../../../kernel/index.js';
import { verdictProjector } from '../../../verify/index.js';
import { trunkRevisionReader } from '../../../git/index.js';
import { relayPresentationShout } from '../../../pages/index.js';
import { createApiHandler } from './http.js';
import { settingsInventory } from '../../../config/index.js';
import { runnerDispatchMode } from '../../../config/index.js';
import { jobQueueCall } from '../../../jobs/index.js';
import { personRequestStatuses } from '../../../link/index.js';
import { relayCanaryNeeds } from '../../../link/index.js';
import { relayFiles } from '../../../store/index.js';
import { startStateMaterializer } from './state/materializer.js';
import { watchEventSignals } from './event-signals.js';

/** Inputs shared by the complete state cache and the lightweight live-change watcher. */
const STATE_REVISION_INPUTS = Object.freeze([
  'identity', 'head', 'trunk', 'files', 'event', 'agents', 'leases', 'requestReceipts', 'milestones', 'externalRoadmap', 'eventLogVersion', 'ruleProofWindow', 'localRelayMarker',
]);

/** Serialize named state inputs in one stable order for cache and stream comparisons. */
function stateRevision(inputs) {
  return JSON.stringify(STATE_REVISION_INPUTS.map((name) => [name, inputs[name]]));
}

/**
 * Read this board's own revision inputs from one open connection, for the cache and the watcher alike.
 * nextExpiry is the earliest live claim or review lease, when a lease turns over with no write.
 */
function localRevisionInputs(board, now) {
  board = Object.assign(Object.create(board), { clock: { ...board.clock, now: () => new Date(now) } });
  const leases = board.db.prepare('SELECT item_id, item_status, item_owner, item_lease_until, item_review_by, item_review_until FROM item ORDER BY item_id').all()
    .map((item) => [
      item.item_id, item.item_status, item.item_owner, item.item_lease_until, item.item_review_by, item.item_review_until,
      item.item_status === 'claimed' && (item.item_lease_until ?? '') > now,
      item.item_status === 'submitted' && Boolean(item.item_review_by) && (item.item_review_until ?? '') > now,
    ]);
  const expiries = leases.flatMap(([, , , leaseUntil, , reviewUntil, claimLive, reviewLive]) => [claimLive ? leaseUntil : null, reviewLive ? reviewUntil : null]);
  const proofWindow = ruleProofWindow(board, now);
  return {
    event: board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id,
    agents: store.listAgents(board),
    leases,
    requestReceipts: board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('relay_person_requests')?.meta_value ?? null,
    milestones: store.milestones(board),
    ruleProofWindow: proofWindow.events,
    nextExpiry: [...expiries, proofWindow.nextExpiry].filter(Boolean).sort()[0] ?? null,
  };
}

/** Hide foreign milestone references in revision tokens while preserving one unavailable obligation each. */
function visibleMilestoneInputs(milestones, scoped) {
  if (!scoped) return milestones;
  let hidden = 0;
  return milestones.map((milestone) => ({
    ...milestone,
    items: milestone.items.map((item) => typeof item === 'number' ? item : `external-${++hidden}`),
  }));
}

/** Capture the inexpensive inputs that can invalidate a complete board-state snapshot. */
function boardStateRevision(root, id, isMain, { projects = listApiProjects, scopeCommonDir = null, observedAt = Date.now(), boardOpeners } = {}) {
  const { openBoard } = requireBoardOpeners(boardOpeners);
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const files = stateFileInputs(info.root, config, { fitFile }).map(fileRevision);
  const local = withBoard(info.root, (board) => {
    const inputs = localRevisionInputs(board, new Date(observedAt).toISOString());
    const hasExternalMilestones = inputs.milestones.some((milestone) => milestone.items.some((item) => typeof item !== 'number'));
    return { ...inputs, externalMilestones: hasExternalMilestones
      ? scopeCommonDir === null
        ? milestoneRoadmap(info.root, board, { ports: { ...store, roadmap, openBoard, workQueue, listApiProjects } })
        : milestoneRoadmap(info.root, board, { projects, hideOutOfScope: true, ports: { ...store, roadmap, openBoard, workQueue } })
      : null };
  }, isMain, boardOpeners);
  const inputs = {
    identity: [info.commonDir, id],
    head: resolveCommit(info.root, 'HEAD'),
    trunk: trunkRevisionReader(info)(),
    files,
    event: local.event,
    agents: local.agents,
    leases: local.leases,
    requestReceipts: local.requestReceipts,
    milestones: visibleMilestoneInputs(local.milestones, scopeCommonDir !== null),
    externalRoadmap: local.externalMilestones,
    eventLogVersion: store.EVENT_LOG_VERSION,
    ruleProofWindow: local.ruleProofWindow,
    localRelayMarker: localRelayMarker(info),
  };
  const revision = stateRevision(inputs);
  return { cacheId: info.commonDir + '\0' + id, revision, event: local.event, milestones: local.externalMilestones,
    inputs: { ...inputs, leases: local.leases }, cacheable: true };
}

/** Cheap file identity for an event-stream poll; content is read only after this marker changes. */
function fileMarker(file) {
  try {
    const stat = statSync(file.path);
    return [file.name, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [file.name, null];
    throw error;
  }
}

/** Capture a marker for a single absolute path, including an explicit missing-file value. */
function fileMarkerForPath(path) {
  try {
    const stat = statSync(path);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

/** Invalidate only this local API state when its private canary record or queued link changes. */
function localRelayMarker(info) {
  const files = relayFiles(info.commonDir);
  return [fileMarkerForPath(join(info.commonDir, 'pullboard', 'relay-health.sqlite')), fileMarkerForPath(files.link)];
}

/** Read HEAD and its selected ref without spawning Git on every 200 ms poll. */
function headFileRevision(info) {
  const head = readFileSync(join(info.gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40,64}$/iu.test(head)) return head.toLowerCase();
  const symbolic = /^ref: (.+)$/.exec(head);
  if (!symbolic) return head;
  const ref = symbolic[1];
  try { return readFileSync(join(info.commonDir, ref), 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let packed;
    try { packed = readFileSync(join(info.commonDir, 'packed-refs'), 'utf8'); }
    catch (packedError) {
      if (packedError.code === 'ENOENT') return head;
      throw packedError;
    }
    return packed.split('\n').find((line) => line.endsWith(' ' + ref))?.split(' ')[0] ?? head;
  }
}

/**
 * Read the machine registry that milestoneRoadmap resolves against, without listApiProjects' pruning
 * or metadata writes: a poll must not rewrite the registry it watches.
 */
function registeredProjects() {
  try {
    const value = JSON.parse(readFileSync(registryFile(), 'utf8'));
    if (!Array.isArray(value.projects)) return [];
    return value.projects.filter((project) => typeof project?.root === 'string').map((project) => ({
      ...project,
      root: resolve(project.root),
      name: project.name ?? basename(project.root),
    }));
  } catch {
    return [];
  }
}

/** Open only boards named by this board's external milestone references. */
function openRoadmapInputs(root, milestones, localDb, { scopeCommonDir = null } = {}) {
  const references = milestones.flatMap((milestone) => milestone.items.filter((item) => typeof item !== 'number'));
  const registered = references.length ? registeredProjects().filter((project) => {
    if (scopeCommonDir === null) return true;
    try { return sameCommonDir(repoInfo(project.root).commonDir, scopeCommonDir); }
    catch { return false; }
  }) : [];
  const opened = new Map();
  const pathMarkers = new Map();
  const watchPath = (path) => {
    if (!pathMarkers.has(path)) pathMarkers.set(path, fileMarkerForPath(path));
  };
  let inputs;
  try {
    inputs = references.map((reference, index) => {
      const match = /^(.+)#([1-9]\d*)$/.exec(reference);
      if (!match) return { reference, visibleReference: scopeCommonDir === null ? reference : `external-${index + 1}`, unavailable: true };
      const [, repo, number] = match;
      const candidates = registered.filter((project) => project.name === repo || basename(project.root) === repo);
      for (const candidate of candidates) {
        watchPath(candidate.root);
        watchPath(join(candidate.root, '.git'));
      }
      if (candidates.length !== 1) return { reference, visibleReference: scopeCommonDir === null ? reference : `external-${index + 1}`, unavailable: true };
      try {
        const info = repoInfo(candidates[0].root);
        const path = join(info.commonDir, 'pullboard', 'board.sqlite');
        watchPath(path);
        const db = resolve(candidates[0].root) === resolve(root) ? localDb : (opened.get(path) ?? store.openBoardReadOnly(path));
        if (db !== localDb) opened.set(path, db);
        return { reference, visibleReference: reference, id: Number(number), db, path };
      } catch {
        return { reference, visibleReference: scopeCommonDir === null ? reference : `external-${index + 1}`, unavailable: true };
      }
    });
  } catch (error) {
    for (const db of opened.values()) {
      try { db.close(); } catch {}
    }
    throw error;
  }
  return {
    inputs,
    paths: () => [...pathMarkers.keys()],
    close() {
      for (const db of opened.values()) {
        try { db.close(); } catch {}
      }
    },
    needsRefresh() {
      for (const [path, marker] of pathMarkers) if (fileMarkerForPath(path) !== marker) return true;
      return false;
    },
    revision(now) {
      const values = [];
      let nextExpiry = null;
      for (const input of inputs) {
        if (input.unavailable) { values.push([input.visibleReference ?? input.reference, 'unavailable']); continue; }
        const item = input.db.prepare('SELECT item_title, item_status, item_lease_until FROM item WHERE item_id = ?').get(input.id);
        if (!item) { values.push([input.visibleReference ?? input.reference, 'missing']); continue; }
        const status = item.item_status === 'claimed' && (item.item_lease_until ?? '') <= now ? 'open' : item.item_status;
        if (item.item_status === 'claimed' && item.item_lease_until > now && (!nextExpiry || item.item_lease_until < nextExpiry)) nextExpiry = item.item_lease_until;
        values.push([input.visibleReference ?? input.reference, item.item_title, status]);
      }
      return { values, nextExpiry };
    },
  };
}

/** Watch the same named state inputs as the cache without rebuilding a board-state response. */
function watchLocalStateRevision(board, { scopeCommonDir = null } = {}) {
  const info = repoInfo(board.root);
  const readTrunk = trunkRevisionReader(info);
  const config = loadConfig(info.root);
  let files = stateFileInputs(info.root, config, { fitFile });
  const dbPath = join(info.commonDir, 'pullboard', 'board.sqlite');
  let db = store.openBoardReadOnly(dbPath);
  let closed = false;
  let dbMarker;
  let fileMarkers;
  let fileContent;
  let head;
  let dataVersion;
  let local = null;
  let external = null;
  let externalVersion = new Map();
  let externalValues = null;
  let externalNextExpiry = null;
  let externalReferences = null;
  let registryMarker = null;
  let notifications;
  const listeners = new Set();
  let expiryTimer;
  /** Rebind named inputs and schedule only the earliest real lease/proof-window expiry. */
  function armNotifications() {
    const relay = relayFiles(info.commonDir);
    const heads = [...new Set([join(info.gitDir, 'HEAD'), join(info.commonDir, 'HEAD')])];
    const refs = heads.flatMap(path => {
      try { const ref = /^ref: (.+)$/mu.exec(readFileSync(path, 'utf8')); return ref ? [join(info.commonDir, ref[1])] : []; }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    });
    const paths = [dbPath, dbPath + '-wal', ...files.map(file => file.path), registryFile(), ...heads, ...refs, join(info.commonDir, 'packed-refs'),
      join(info.commonDir, 'pullboard/relay-health.sqlite'), join(info.commonDir, 'pullboard/relay-health.sqlite-wal'), relay.link,
      ...(external?.paths() ?? []), ...(external?.inputs ?? []).flatMap(input => input.path ? [input.path, input.path + '-wal'] : [])];
    notifications.update(paths);
    clearTimeout(expiryTimer);
    const expiry = [local?.nextExpiry, externalNextExpiry].filter(Boolean).sort()[0];
    if (expiry) expiryTimer = setTimeout(() => { for (const listener of [...listeners]) listener(); }, Math.max(1, Date.parse(expiry) - Date.now()));
  }

  try {
    notifications = fileChangeWaiter([dbPath, dbPath + '-wal']);
    dbMarker = fileMarkerForPath(dbPath);
    fileMarkers = files.map(fileMarker);
    fileContent = files.map(fileRevision);
    head = headFileRevision(info);
    dataVersion = db.prepare('PRAGMA data_version').get().data_version;
  } catch (error) {
    notifications?.close(); db.close();
    throw error;
  }

  /** Refresh related external board reads only after their retained connection reports a commit. */
  function externalInputs(now, milestoneDefinitions, localChanged) {
    const references = milestoneDefinitions.flatMap((milestone) => milestone.items.filter((item) => typeof item !== 'number'));
    const currentRegistryMarker = fileMarkerForPath(registryFile());
    const registryChanged = registryMarker !== currentRegistryMarker;
    if (!external || JSON.stringify(externalReferences) !== JSON.stringify(references) || registryChanged || external.needsRefresh()) {
      external?.close();
      external = openRoadmapInputs(info.root, milestoneDefinitions, db, { scopeCommonDir });
      externalVersion = new Map();
      externalValues = null;
      externalNextExpiry = null;
      externalReferences = references;
      registryMarker = currentRegistryMarker;
    }
    let changed = false;
    for (const input of external.inputs) {
      if (!input.unavailable && input.db !== db) {
        // Keep the version observed before row reads. A commit during revision() is then
        // detected on the next poll instead of pairing old rows with a newer version.
        const value = input.db.prepare('PRAGMA data_version').get().data_version;
        const key = input.db;
        if (externalVersion.has(key) && externalVersion.get(key) !== value) changed = true;
        externalVersion.set(key, value);
      }
    }
    if (changed || localChanged || !externalValues || (externalNextExpiry && externalNextExpiry <= now)) {
      const current = external.revision(now);
      externalValues = current.values;
      externalNextExpiry = current.nextExpiry;
    }
    return externalValues;
  }

  /** Return the current cheap revision, updating heavier SQL projections only when needed. */
  function revision() {
    if (closed) throw new Error('the event-stream revision watcher is closed');
    const latestDbMarker = fileMarkerForPath(dbPath);
    if (latestDbMarker !== dbMarker) {
      const replacement = store.openBoardReadOnly(dbPath);
      const replacementVersion = replacement.prepare('PRAGMA data_version').get().data_version;
      external?.close();
      external = null;
      db.close();
      db = replacement;
      dbMarker = latestDbMarker;
      dataVersion = replacementVersion;
      local = null;
      externalValues = null;
      externalVersion = new Map();
    }
    const currentMarkers = files.map(fileMarker);
    if (JSON.stringify(currentMarkers) !== JSON.stringify(fileMarkers)) {
      const latestConfig = loadConfig(info.root);
      files = stateFileInputs(info.root, latestConfig, { fitFile });
      fileMarkers = files.map(fileMarker);
      fileContent = files.map(fileRevision);
    }
    const latestHead = headFileRevision(info);
    const latestDataVersion = db.prepare('PRAGMA data_version').get().data_version;
    const now = new Date().toISOString();
    const localChanged = latestDataVersion !== dataVersion;
    const localExpiryChanged = Boolean(local?.nextExpiry && local.nextExpiry <= now);
    if (!local || localChanged || localExpiryChanged) {
      local = localRevisionInputs({ db, clock: store.systemClock }, now);
      dataVersion = latestDataVersion;
    }
    head = latestHead;
    const externalRoadmap = externalInputs(now, local.milestones, localChanged || localExpiryChanged);
    const value = stateRevision({
      identity: [info.commonDir, board.id],
      head,
      trunk: readTrunk(),
      files: fileContent,
      event: local.event,
      agents: local.agents,
      leases: local.leases,
      requestReceipts: local.requestReceipts,
      milestones: visibleMilestoneInputs(local.milestones, scopeCommonDir !== null),
      externalRoadmap,
      eventLogVersion: store.EVENT_LOG_VERSION,
      ruleProofWindow: local.ruleProofWindow,
      localRelayMarker: localRelayMarker(info),
    });
    armNotifications();
    return value;
  }

  return {
    revision,
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribe = notifications.subscribe(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(expiryTimer); notifications.close(); listeners.clear();
      try { external?.close(); } finally { db.close(); }
    },
  };
}

/** Everything a summary leaves out, with the latest verdict whole: laid over its summary, it is the full item. */
function itemDetail(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => ['id', 'verdict', 'verdictState', 'withdrawnReason', 'withdrawnFrom'].includes(key) || !SUMMARY_KEYS.has(key)));
}

/** The text the view's search matches for an item, lowercased: its #id, title, lane, spec ids and criterion. */
function searchText(item) {
  return ('#' + item.id + ' ' + item.title + ' ' + item.lane + ' ' + item.specs.join(' ') + ' ' + (item.criterion || '')).toLowerCase();
}

/** One cached board build: the full state, its item summaries, its delta fingerprint and the lookups that serve them. */
function snapshotEntry(revision, state, preparedFlow, { inputs = null, itemMeta = new Map(), itemMoveCounts = new Map(), clockWindow = null, comparisonHistory = null } = {}) {
  const summary = { ...state, items: state.items.map(itemSummary) };
  const reportValidator = { json: JSON.stringify(state.proofStats?.flow?.report), expiries: [...new Set(preparedFlow.items.flatMap(item =>
    item.state === 'claimed' ? [item.leaseUntil] : item.state === 'submitted' ? [item.reserve?.until] : []).filter(Number.isFinite))].sort((a, b) => a - b) };
  reportValidator.comparisonEvents = [...new Set((comparisonHistory ?? []).map(event => Date.parse(event.event_at)).filter(Number.isFinite))].sort((a, b) => a - b);
  reportValidator.comparisonWindowMs = state.statsComparison?.durationMinutes * 60_000;
  reportValidator.digest = createHash('sha256').update(reportValidator.json ?? 'null').digest('hex');
  return { revision, sequence: state.sequence, state, summary, preparedFlow, comparisonHistory, reportValidator, summaryFields: prepareStateJson(summary), stateJsonFields: null,
    print: fingerprint(summary), items: new Map(state.items.map((item) => [item.id, item])), itemMeta, itemMoveCounts, inputs, clockWindow, searchTexts: null };
}

/** Per-read projections, including observation time, are not part of a cached build fingerprint. */
const DELTA_WHOLE = new Set([...WHOLE_STATE_DELTA_FIELDS, 'claimOverlaps']);
/** The state lists a delta merges entry by entry, and the field that names each entry. */
const DELTA_KEYS = Object.freeze({ items: 'id', shouts: 'shout_id', asked: 'shout_id', events: 'event_id', agents: 'agent_id', spec: 'id', practice: 'id', milestones: 'name' });
/** How many recent builds of each board a server keeps as possible delta bases. */
const DELTA_BASES = 24;
/** How many item details a server keeps for each board: past a board our size, the least recently read go first. */
const DETAIL_CACHE_ITEMS = 4096;

/** A digest of one value's JSON, which is what a client holds of it. */
function jsonDigest(value) {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('base64');
}

/**
 * Fingerprint a summary build without keeping it: a digest of each field, and for each keyed list
 * its entry order and each entry's digest. A list whose keys repeat or are missing is a whole field.
 */
function fingerprint(state) {
  const fields = new Map();
  const lists = new Map();
  for (const [field, value] of Object.entries(state)) {
    if (DELTA_WHOLE.has(field)) continue;
    const key = Object.hasOwn(DELTA_KEYS, field) ? DELTA_KEYS[field] : null;
    const ids = key && Array.isArray(value) ? value.map((entry) => entry?.[key]) : null;
    if (ids && ids.every((id) => typeof id === 'number' || typeof id === 'string') && new Set(ids).size === ids.length) {
      lists.set(field, { key, ids, digests: new Map(value.map((entry) => [entry[key], jsonDigest(entry)])) });
    } else fields.set(field, jsonDigest(value));
  }
  return { fields, lists };
}

/** Whether two key lists name the same entries in the same order. */
function sameIds(left, right) {
  return left.length === right.length && left.every((id, at) => id === right[at]);
}

/**
 * What changed from each of these bases to the current build. Changed values travel whole, so the
 * delta applied to any one of the bases gives the current state; the request's own fields and the
 * Needs-you lists always come whole. A keyed list sends only its changed entries, and its full key
 * order when entries were added, removed or moved.
 *
 * @param {{ fields: Map<string, string>, lists: Map<string, any> }[]} bases
 * @param {{ fields: Map<string, string>, lists: Map<string, any> }} current
 * @param {any} state The current summary state, projected for this request.
 * @returns {{ replace: object, merge: object, remove?: string[] }}
 */
function stateDelta(bases, current, state) {
  const replace = {};
  const merge = {};
  for (const [field, value] of Object.entries(state)) {
    if (DELTA_WHOLE.has(field)) { replace[field] = value; continue; }
    const list = current.lists.get(field);
    if (list && bases.every((base) => base.lists.get(field)?.key === list.key)) {
      const set = value.filter((entry) => bases.some((base) => base.lists.get(field).digests.get(entry[list.key]) !== list.digests.get(entry[list.key])));
      const moved = bases.some((base) => !sameIds(base.lists.get(field).ids, list.ids));
      if (set.length || moved) merge[field] = { key: list.key, set, ...(moved ? { ids: list.ids } : {}) };
    } else if (list || bases.some((base) => base.fields.get(field) !== current.fields.get(field))) {
      replace[field] = value;
    }
  }
  const remove = [...new Set(bases.flatMap((base) => [...base.fields.keys(), ...base.lists.keys()]))].filter((field) => !Object.hasOwn(state, field));
  return { replace, merge, ...(remove.length ? { remove } : {}) };
}

/** Add the request-specific unread count without mutating the reusable snapshot. */
function stateForRequest(state, root, seen, preparedFlow, refreshFlow, isMain, observedAt, comparisonHistory, boardOpeners, viewFlowSummary) {
  const projection = seen === null ? { unseen: null } : withBoard(root, (board) => ({
    unseen: { since: seen, count: board.db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_id > ?').get(seen).n },
  }), isMain, boardOpeners);
  Object.assign(projection, readProjection(state, root, preparedFlow, refreshFlow, isMain, observedAt, comparisonHistory, boardOpeners, viewFlowSummary));
  return { ...state, ...projection, observedAt: new Date(observedAt).toISOString() };
}

/** The fields a read stamps on a build at its observation time: claim overlaps, capacity and the flow windows. */
function readProjection(state, root, preparedFlow, refreshFlow, isMain, observedAt, comparisonHistory, boardOpeners, viewFlowSummary) {
  const projection = {};
  projection.claimOverlaps = withBoard(root, board => {
    const items = store.listItems(board);
    const overlaps = claimOverlaps(items, recordedClaimWorktrees(items, store.listAgents(board), board));
    return Object.fromEntries([...overlaps].filter(([, value]) => value.overlaps.length || value.outOfScope.length));
  }, isMain, boardOpeners);
  if (state.capacityForecast) projection.capacityForecast = capacityAtRead(state.capacityForecast, observedAt);
  if (refreshFlow && comparisonHistory) projection.statsComparison = compareFlowWindows(comparisonHistory, { now: observedAt, windowMinutes: 120, complete: true });
  if (refreshFlow && preparedFlow) {
    projection.proofStats = {
      ...state.proofStats,
      flow: viewFlowSummary(projectFlowStats(preparedFlow, null, observedAt, state.proofStats)),
    };
  }
  return projection;
}

/** Cache JSON fragments for state fields whose values stay fixed across a cache hit. */
function prepareStateJson(state) {
  const fields = Object.entries(state).map(([key, value]) => {
    if (key === 'claimOverlaps' || key === 'unseen' || key === 'observedAt' || key === 'capacityForecast' || key === 'statsComparison') return { dynamic: key };
    if (key === 'proofStats') {
      const stats = Object.entries(value).filter(([name]) => name !== 'flow').map(([name, entry]) => jsonField(name, entry)).filter(Boolean);
      return { dynamic: key, stats };
    }
    return { static: jsonField(key, value) };
  });
  if (!fields.some((field) => field.dynamic === 'unseen')) fields.push({ dynamic: 'unseen' });
  if (!fields.some((field) => field.dynamic === 'claimOverlaps')) fields.push({ dynamic: 'claimOverlaps' });
  return fields;
}

/** Serialize a state field through JSON.stringify, omitting values JSON would omit. */
function jsonField(key, value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? '' : JSON.stringify(key) + ':' + encoded;
}

/** Count crossed native boundaries without scanning the retained history on every read. */
function crossedBoundaries(values, now) {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= now) low = middle + 1; else high = middle; }
  return low;
}

/** Reuse recorded report material while retaining native leases and sliding-window event membership. */
function reportValidation(entry, now = Date.now()) {
  const { expiries, comparisonEvents, comparisonWindowMs } = entry.reportValidator;
  let crossed = crossedBoundaries(expiries, now);
  if (Number.isFinite(comparisonWindowMs) && comparisonWindowMs > 0) {
    for (const offset of [0, comparisonWindowMs, 2 * comparisonWindowMs]) crossed += crossedBoundaries(comparisonEvents, now - offset);
  }
  return entry.reportValidator.digest + ':' + crossed;
}

/** Normalize only known elapsed-clock measures; counts, unavailable values and future fields stay material. */
function comparisonForValidation(comparison) {
  if (comparison?.available !== true || !Number.isFinite(comparison.durationMinutes) || comparison.durationMinutes <= 0) return comparison;
  const normalized = { ...comparison };
  for (const name of ['current', 'previous', 'change']) {
    const window = comparison[name];
    if (!window || typeof window !== 'object') continue;
    const value = { ...window };
    for (const field of ['since', 'until']) if (typeof value[field] === 'string') value[field] = null;
    for (const field of ['agentHours', 'idleHours', 'idleShare', 'agentHoursPerLanding', 'unknownStageHours']) {
      if (typeof value[field] === 'number') value[field] = 0;
    }
    for (const field of ['idleReasonHours', 'idleReasons', 'stageHours', 'stageShares']) {
      if (value[field] && typeof value[field] === 'object') value[field] = Object.fromEntries(Object.entries(value[field])
        .map(([key, entry]) => [key, typeof entry === 'number' ? 0 : entry]));
    }
    normalized[name] = value;
  }
  return normalized;
}

/** Reuse static state fragments while encoding request-specific unread and flow data. */
function serializeState(state, fields, reportJson, validator = false) {
  if (!fields) return JSON.stringify(state);
  const encoded = fields.map((field) => {
    if (field.static !== undefined) return field.static;
    if (field.dynamic === 'statsComparison' && validator) return jsonField(field.dynamic, comparisonForValidation(state.statsComparison));
    if (field.dynamic === 'claimOverlaps' || field.dynamic === 'unseen' || field.dynamic === 'observedAt' || field.dynamic === 'capacityForecast' || field.dynamic === 'statsComparison') return jsonField(field.dynamic, state[field.dynamic]);
    if (field.dynamic === 'proofStats') {
      const value = state.proofStats?.flow;
      const flow = reportJson === undefined || !value ? jsonField('flow', value)
        : '"flow":{' + Object.entries(value).map(([key, entry]) => key === 'report'
          ? '"report":' + reportJson : jsonField(key, entry)).filter(Boolean).join(',') + '}';
      return '"proofStats":{' + [...field.stats, flow].filter(Boolean).join(',') + '}';
    }
    return '';
  }).filter(Boolean);
  return '{' + encoded.join(',') + '}';
}

/** Require actual native connection providers before any API board discovery or writes. */
function requireBoardOpeners(ports) {
  if (typeof ports?.openBoard !== 'function' || typeof ports.openBoardForRead !== 'function') {
    throw new TypeError('API needs its actual native board openers from the higher composition root');
  }
  return ports;
}

const ADDRESS = '127.0.0.1';
const VERSION = 1;

/** Read a registered board and release its SQLite connection on every path.
 *
 * @param {string} root
 * @param {(board: any, info: any) => any} read
 * @param {boolean} [isMain] Whether the running CLI code comes from the main checkout.
 */
function withBoard(root, read, isMain, boardOpeners) {
  return withProjectGitTimeout(root, () => readProjectBoard(root, read, isMain, boardOpeners));
}

/** Keep every Git read made while projecting a registered board inside its inspection deadline. */
function readProjectBoard(root, read, isMain, boardOpeners) {
  const { openBoard, openBoardForRead } = requireBoardOpeners(boardOpeners);
  const info = repoInfo(root);
  loadConfig(info.root);
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  // A read takes no write lock and never migrates (#1047): main code reads an older board as it is,
  // branch code keeps the schema guard, and a read that writes after all runs again on a write open.
  const opened = openBoardForRead(file);
  const main = () => isMain !== false && codeIsFromMain();
  if (opened && (opened.current || main())) try { return read(opened, info); } catch (error) { if (!store.writeRefused(error)) throw error; } finally { store.closeBoard(opened); }
  else if (opened) store.closeBoard(opened);
  const board = openBoard(file, undefined, { isMain: main() });
  try { return read(board, info); } finally { store.closeBoard(board); }
}

/**
 * Read a board on a read-only connection when it is at this code's schema and event-log version.
 * Why: openBoard migrates, writes the board id and checkpoints the log on close, so every read
 * waited behind agents' writes (#1040). Any other board goes through withBoard, which upgrades or refuses it.
 */
function withReadBoard(root, read, isMain, boardOpeners) {
  return withProjectGitTimeout(root, () => readProjectBoardOnly(root, read, isMain, boardOpeners));
}

/** Preserve the read-only connection contract while applying the project Git bound to its callback too. */
function readProjectBoardOnly(root, read, isMain, boardOpeners) {
  requireBoardOpeners(boardOpeners);
  const info = repoInfo(root);
  loadConfig(info.root);
  let db = null;
  let current = false;
  try {
    db = store.openBoardReadOnly(join(info.commonDir, 'pullboard', 'board.sqlite'));
    current = db.prepare('PRAGMA user_version').get().user_version === store.SCHEMA_VERSION && store.readEventLogVersion(db) === store.EVENT_LOG_VERSION;
  } catch {
    current = false; // A missing, older or newer board: withBoard creates, upgrades or refuses it by name.
  }
  if (!current) {
    db?.close();
    return withBoard(root, read, isMain, boardOpeners);
  }
  try { return read({ db, clock: store.systemClock }, info); } finally { db.close(); }
}

/** Registered boards carry one persistent identity across local and relay addresses. */
export function apiBoards(projects = listApiProjects, isMain, boardOpeners) {
  requireBoardOpeners(boardOpeners);
  return projects().flatMap((project) => {
    try { return [withBoard(project.root, (board) => ({ ...project, id: store.boardId(board) }), isMain, boardOpeners)]; }
    catch { return []; }
  });
}

/**
 * List readable registered boards and retain actionable warnings for entries that failed to open.
 *
 * @param {() => { root: string, name: string, project: string, added: string }[]} projects
 * @returns {{ boards: object[], warnings: object[] }}
 */
export function apiBoardListing(projects = listApiProjects, isMain, refusalDocument, boardOpeners) {
  requireBoardOpeners(boardOpeners);
  if (typeof refusalDocument !== 'function') throw new TypeError('apiBoardListing needs the caller\'s refusalDocument renderer');
  const boards = [];
  const warnings = [];
  for (const project of projects()) {
    try {
      boards.push(withBoard(project.root, (board) => ({ ...project, id: store.boardId(board) }), isMain, boardOpeners));
    } catch (cause) {
      const error = ['EVENT_LOG_VERSION', 'UNMERGED_SCHEMA', 'BOARD_UNAVAILABLE'].includes(cause.code) ? cause : new Refused('BOARD_UNAVAILABLE', `registered project ${project.root} cannot be read; restore the repo or run pullboard forget ${project.root}`);
      warnings.push({ ...project, error: refusalDocument(error) });
    }
  }
  return { boards, warnings };
}

/**
 * Every open person decision of the project the named board belongs to, each with its board id
 * and repo; a board outside any project lists alone. An unreadable member is named, not fatal [N34].
 *
 * @param {string | null} selected a registered board id
 * @param {() => { root: string, name: string, project: string }[]} projects
 * @param {boolean | undefined} isMain
 * @returns {{ version: 1, project: string, decisions: object[], unreadable: string[] }}
 */
function projectDecisionListing(selected, projects, isMain, boardOpeners) {
  if (!selected) throw new Refused('BAD_REQUEST', 'name a registered board with ?board=<id> from GET /api/v1/boards');
  const home = findBoard(selected, projects, isMain, boardOpeners);
  const members = home.project ? projects().filter((entry) => entry.project === home.project) : [home];
  const decisions = [];
  const unreadable = [];
  for (const member of members) {
    try {
      withReadBoard(member.root, (board) => {
        const id = store.boardId(board);
        for (const ask of store.openDecisions(board, store.PERSON)) decisions.push({ ...ask, board: id, repo: member.name });
      }, isMain, boardOpeners);
    } catch { unreadable.push(member.name); }
  }
  return { version: 1, project: home.project ?? '', decisions, unreadable };
}

/** Resolve only registered boards, so a request cannot open an arbitrary path on the machine. */
function findBoard(id, projects, isMain, boardOpeners) {
  // Each request resolves its board, so this opens boards read-only and stops at the match (#1040).
  const board = projects().find((project) => {
    try { return withReadBoard(project.root, (current) => store.boardId(current), isMain, boardOpeners) === id; }
    catch { return false; } // An unreadable board is left out, as the board listing leaves it out.
  });
  if (!board) throw new Refused('NO_BOARD', `no registered board ${id}; run pullboard serve in its repo and use GET /api/v1/boards`);
  return { ...board, id };
}

/** Restrict a local API to exactly one registered repository by its canonical Git common directory.
 * @param {() => any[]} projects
 * @param {{ projectRoot: string } | undefined} scope
 * @returns {{ projects: () => any[], commonDir: string | null }}
 */
function apiProjectScope(projects, scope) {
  if (scope === undefined) return { projects, commonDir: null };
  if (!scope || typeof scope.projectRoot !== 'string' || !scope.projectRoot) {
    throw new TypeError('createLocalApiHandler scope needs a registered projectRoot');
  }
  let commonDir;
  try { commonDir = repoInfo(scope.projectRoot).commonDir; }
  catch { throw new Refused('PROJECT_SCOPE', 'scope the API to a registered project repository or linked worktree'); }
  const scoped = () => projects().filter((project) => {
    try { return sameCommonDir(repoInfo(project.root).commonDir, commonDir); }
    catch { return false; }
  });
  if (scoped().length !== 1) throw new Refused('PROJECT_SCOPE', 'scope the API to exactly one registered project repository or linked worktree');
  return { projects: scoped, commonDir };
}

/** Read events in sequence, including changes made by other processes on the same board. */
function afterEvents(root, after, isMain, boardOpeners) {
  return withBoard(root, (board) => board.db.prepare('SELECT * FROM event WHERE event_id > ? ORDER BY event_id').all(after), isMain, boardOpeners);
}

/** Resolve an authenticated local caller's agent to its own checkout, never another board. */
function agentPath(root, name = COORDINATOR, isMain, boardOpeners) {
  if (typeof name !== 'string' || !name) throw new Refused('BAD_REQUEST', 'agent needs a registered name; omit it to act as the coordinator');
  return withBoard(root, (board, info) => {
    if (name === COORDINATOR && !relayLinked(root)) store.board_ensureCoordinator(board, root);
    const agent = store.listAgents(board).find((entry) => entry.agent_id === name);
    if (!agent) throw new Refused('NO_AGENT', `no registered agent ${name}; use the agents in this board's state or join a worktree first`);
    // A clone shares the coordinator identity, but resolves its main checkout locally.
    if (name === COORDINATOR && relayLinked(root)) return root;
    if (!sameCommonDir(repoInfo(agent.agent_path).commonDir, info.commonDir)) throw new Refused('WRONG_BOARD', `agent ${name}'s worktree belongs to another board; join the agent in this board's worktree`);
    return agent.agent_path;
  }, isMain, boardOpeners);
}

/** Execute one actual CLI command and retain its emitted event without a latest-row race. */
export async function executeMove(root, body, runCommand, isMain, personChannel = 'view', refusalDocument, boardOpeners) {
  if (Object.keys(body).some((key) => !['verb', 'item', 'args', 'agent'].includes(key))) throw new Refused('BAD_REQUEST', 'a move takes only verb, item, args and agent; remove the unknown fields');
  if (typeof boardOpeners?.moveArgs !== 'function') throw new TypeError('executeMove needs moveArgs from the higher composition root');
  const argv = boardOpeners.moveArgs(body);
  let cwd;
  try { cwd = agentPath(root, body.agent, isMain, boardOpeners); } catch (error) {
    if (!(error instanceof Refused) || error.code === 'BAD_REQUEST') throw error;
    if (typeof refusalDocument !== 'function') throw new TypeError(`executeMove needs the caller's refusalDocument renderer to answer ${error.code}`);
    return { status: error.code === 'WRONG_BOARD' ? 403 : 409, body: refusalDocument(error) };
  }
  let output = '';
  let diagnostics = '';
  const events = [];
  const status = await runCommand(argv, {
    cwd,
    personChannel,
    stdout: { isTTY: false, write: (text) => { output += text; } },
    stderr: { write: (text) => { diagnostics += text; } },
    onEvent: (row) => { events.push(row); },
  });
  const result = JSON.parse(output);
  if (status) return { status: 409, body: result };
  if (body.verb === 'next' && result.offer) return { status: 200, body: { version: VERSION, event: null, result, offer: result.offer } };
  const kind = body.verb === 'verify' ? body.args?.decision
    : body.verb === 'done' ? 'submit'
    : body.verb === 'hold' && body.args?.off ? 'unhold' : body.verb;
  const event = events.find((row) => row.event_kind === kind) ?? events.at(-1);
  if (!event && body.verb === 'next') return { status: 200, body: { version: VERSION, event: null, result } };
  if (!event) throw new Error(`move ${body.verb} produced no event${diagnostics ? `: ${diagnostics}` : ''}`);
  return { status: 200, body: { version: VERSION, event, result } };
}

/** Create a person's coordinator request through the view's channel, never a standalone serve key. */
async function createRequest(root, body, isMain, personChannel, boardOpeners) {
  if (personChannel !== 'view') throw new Refused('B26_PERSON_CHANNEL', 'person requests use the terminal or the view; run pullboard view');
  if (typeof body.text !== 'string' || !body.text.trim() || Object.keys(body).some((key) => key !== 'text')) throw new Refused('BAD_REQUEST', 'a request needs {text: "what the coordinator should do"}');
  const message = { from: 'person', to: COORDINATOR, text: body.text, request: true, lanes: laneNames(loadConfig(root)) };
  if (relayLinked(root)) {
    const id = await relayOperation(root, 'shout', [message], { err: () => {}, withOutboxGuard: boardOpeners.withOutboxGuard, replayConflictRecord: boardOpeners.replayConflictRecord, remoteBoardMissing: boardOpeners.remoteBoardMissing, uncertainUploadFailure: boardOpeners.uncertainUploadFailure, decideUncertainBaseline: boardOpeners.decideUncertainBaseline, checkpointPublisher: boardOpeners.checkpointPublisher, relayOrdering: boardOpeners.relayOrdering, checkpointInBackground: boardOpeners.checkpointInBackground, scheduleCheckpoint: boardOpeners.scheduleCheckpoint, requestCheckpointCheck: boardOpeners.requestCheckpointCheck, checkpointWorker: boardOpeners.checkpointWorker, openBoard: boardOpeners.openBoard, nativeBoardPorts: boardOpeners.nativeBoardPorts, outboxFields: boardOpeners.outboxFields, outboxPolicy: boardOpeners.outboxPolicy, flushOutbox: boardOpeners.flushOutbox, queueMove: boardOpeners.queueMove, outboxHasPendingCreatedItem: boardOpeners.outboxHasPendingCreatedItem });
    return withBoard(root, (board) => ({ version: VERSION,
      event: store.events(board).find((event) => JSON.parse(event.event_detail).shout === id),
      result: { id, request: true } }), isMain, boardOpeners);
  }
  return withBoard(root, (board) => {
    const id = store.shout(board, message);
    return { version: VERSION, event: board.lastEvent, result: { id, request: true } };
  }, isMain, boardOpeners);
}

/** Return one unambiguous value for a named request cookie, or null when absent or duplicated. */
function requestCookie(header, name) {
  if (typeof header !== 'string') return null;
  let found = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      if (part.trim() === name) return null;
      continue;
    }
    if (part.slice(0, separator).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

/** Require a canonical base64url cookie token with room for at least 128 random bits. */
function hasCookieEntropyCapacity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length >= 16 && bytes.toString('base64url') === value;
}

/** Compare two credential buffers without exposing their contents or comparing equal-length values ordinarily. */
function credentialMatches(candidate, expected) {
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Accept only canonical dotted-decimal IPv4 literals, without DNS or alternate numeric forms. */
function isLiteralIPv4(host) {
  const octets = host.split('.');
  return octets.length === 4 && octets.every(octet => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255);
}

/**
 * The board-state builds one process keeps, each board's latest build reused while its revision holds and
 * otherwise rebuilt from it, item by item, for the items whose events moved [A2,C7]. The local API handler
 * reads through it on the request; the state materializer runs the same builds on its worker thread, so a
 * read there never builds at all.
 */
export function createStateSnapshots({ projects = listApiProjects, scope, isMain, onStateBuild, onItemBuild, now = () => Date.now(), boardOpeners, viewPorts } = {}) {
  const { openBoard } = requireBoardOpeners(boardOpeners);
  const { projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary } = viewPorts ?? {};
  if ([projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary].some(fn => typeof fn !== 'function')) throw new TypeError('createStateSnapshots needs view projection ports');
  const projectScope = apiProjectScope(projects, scope);
  const apiProjects = projectScope.projects;
  const scopeCommonDir = projectScope.commonDir;
  const codeIsMain = codeIsFromMain() && isMain !== false;
  const stateCache = new Map();
  /** File, identity, HEAD or wire-version changes invalidate the item projector's assumptions: the inputs that moved, or none. */
  function fullRebuildCauses(cached, before) {
    if (!cached || !before.cacheable || cached.sequence > before.event || !cached.inputs) return ['base'];
    const moved = ['identity', 'eventLogVersion'].filter((key) => JSON.stringify(cached.inputs[key]) !== JSON.stringify(before.inputs[key]));
    // An item's projection reads its own rows; HEAD, blocks and sign-offs feed only the whole-board fields every build
    // recomputes, so they never cost a full rebuild, while the config, spec, doctrine and fit files shape items too.
    const kept = new Map((cached.inputs.files ?? []).map(([name, digest]) => [name, digest]));
    for (const [name, digest] of before.inputs.files ?? []) if (/^(?:config|spec|practice|builtin|fit):/u.test(name) && kept.get(name) !== digest) moved.push(name);
    return moved;
  }
  /** Changed lease tuples include eventless claim/review expiry. */
  function changedLeaseItems(cached, before) {
    const oldLeases = new Map((cached?.inputs?.leases ?? []).map((row) => [row[0], JSON.stringify(row)]));
    return new Set((before.inputs.leases ?? []).filter((row) => oldLeases.get(row[0]) !== JSON.stringify(row)).map((row) => row[0]));
  }
  /**
   * Read the current board build through `read(entry, cached)`, reusing the cached build while every
   * input revision holds before and after the read, and building it again when one moved.
   */
  function withSnapshot(board, read, observedAt = now()) {
    const before = boardStateRevision(board.root, board.id, codeIsMain, { projects: apiProjects, scopeCommonDir, observedAt, boardOpeners });
    const cached = stateCache.get(before.cacheId);
    if (before.cacheable && cached?.revision === before.revision && nativeStateClockMatches(cached.clockWindow, observedAt)) {
      const result = read(cached, true);
      const after = boardStateRevision(board.root, board.id, codeIsMain, { projects: apiProjects, scopeCommonDir, observedAt, boardOpeners });
      if (after.cacheable && after.revision === before.revision) {
        cached.clockWindow.observedAt = observedAt; // A backwards request must rebuild even within the prior constant window.
        stateCache.delete(before.cacheId);
        stateCache.set(before.cacheId, cached);
        return result;
      }
    }

    const causes = fullRebuildCauses(cached, before);
    const fullItemRebuild = causes.length > 0;
    // An item whose verdict could not be settled last build is projected again, and only it.
    const changedLeases = fullItemRebuild ? new Set() : new Set([...changedLeaseItems(cached, before), ...(cached.uncertain ?? [])]);
    onStateBuild?.({ board: board.id, full: fullItemRebuild, causes });
    // Keep projection, global fields, event history and sequence in one SQLite read transaction.
    const built = withBoard(board.root, (currentBoard) => buildLocalBoardState(board.root, board.id, currentBoard, codeIsMain, {
      previous: fullItemRebuild ? null : cached,
      previousHistory: cached?.comparisonHistory ?? null,
      fullItemRebuild,
      refreshVerdicts: !fullItemRebuild && JSON.stringify(cached.inputs.trunk) !== JSON.stringify(before.inputs.trunk),
      afterSequence: cached?.sequence ?? 0,
      changedLeases,
      onItemBuild,
      projects: apiProjects,
      scopeCommonDir,
      observedAt,
      localRelayHealth: relayCanaryNeeds(board.root),
      localCapacity: true,
    }, { openBoard, verifiedPasskeyRowDecision, pendingFit, projectFit, projectState, personRequestStatuses, personSigningPresentation, activeViewAgents, viewProofSummary, claimHealthSnapshot }), codeIsMain, boardOpeners);
    // Capture the complete prefix once in this transaction; each read projects its actual observation
    // windows from those cached canonical inputs without another database scan or state rebuild.
    const state = { ...built.state, sequence: built.sequence,
      statsComparison: compareFlowWindows(built.history, { now: observedAt, windowMinutes: 120, complete: true }) };
    const entry = snapshotEntry(before.revision, state, prepareFlowHistory(built.history, { agentIds: new Set(state.agents.filter(isProofAgent).map(agent => agent.agent_id)) }), {
      inputs: before.inputs,
      itemMeta: built.itemMeta,
      itemMoveCounts: built.itemMoveCounts,
      clockWindow: built.clockWindow,
      comparisonHistory: built.history,
    });
    entry.cacheId = before.cacheId;
    const after = boardStateRevision(board.root, board.id, codeIsMain, { projects: apiProjects, scopeCommonDir, observedAt, boardOpeners });
    // Missing Git objects can arrive without a board event or trunk move; retry that uncertainty. A build the
    // board moved under, or one with an unsettled verdict, is never served again as current, but it stays the
    // base the next build extends: why, on a board that moves every second, dropping it made every build full.
    entry.uncertain = state.items.filter(item => item.verdictState?.reason).map(item => item.id);
    if (!(after.cacheable && before.revision === after.revision) || entry.uncertain.length) entry.revision = null;
    if (before.cacheable) {
      stateCache.delete(before.cacheId);
      stateCache.set(before.cacheId, entry);
      while (stateCache.size > 32) stateCache.delete(stateCache.keys().next().value);
    } else {
      stateCache.delete(before.cacheId);
    }
    return read(entry, false);
  }
  /** Each board's recent build prints with their sequences, the bases materialized deltas start from. */
  const builtPrints = new Map();
  /**
   * Build one board's state as text a read only joins: the summary, compact and (once asked for) full JSON,
   * every clock reading stamped at this build and each split around the per-read unread count, with their
   * validators, the shout ids that count, the search texts, and the delta from each held sequence [A2,C7].
   *
   * @param {{ id: string, root: string }} board
   * @param {{ held?: number[], full?: boolean }} [options] The sequences clients hold, and whether to build the full state.
   */
  function materialize(board, { held = [], full = false } = {}) {
    const observedAt = now();
    return withProjectGitTimeout(board.root, () => withGitReadFacts(() => withSnapshot(board, (entry, cached) => {
      const marker = JSON.stringify('pullboard-unseen:' + randomBytes(12).toString('hex'));
      const split = (text) => [text.slice(0, text.indexOf(marker)), text.slice(text.indexOf(marker) + marker.length)];
      const stamped = { ...readProjection(entry.summary, board.root, entry.preparedFlow, cached, codeIsMain, observedAt, entry.comparisonHistory, boardOpeners, viewFlowSummary),
        unseen: JSON.parse(marker), observedAt: new Date(observedAt).toISOString() };
      const reportValidator = reportValidation(entry, observedAt);
      const variant = (base, fields, suffix = '') => ({ json: split(serializeState({ ...base, ...stamped }, fields)),
        validator: split(serializeState({ ...base, ...stamped }, fields, entry.reportValidator.json, true) + '\0report-expiry:' + reportValidator + suffix) });
      const kept = builtPrints.get(entry.cacheId) ?? { builds: [], forgottenThrough: -1 };
      builtPrints.set(entry.cacheId, kept);
      if (!kept.builds.some((build) => build.print === entry.print)) kept.builds.push({ sequence: entry.sequence, print: entry.print });
      while (kept.builds.length > DELTA_BASES) kept.forgottenThrough = Math.max(kept.forgottenThrough, kept.builds.shift().sequence);
      const deltas = {};
      for (const since of new Set([...held, ...kept.builds.slice(-4).map((build) => build.sequence)])) {
        const bases = since > kept.forgottenThrough && since <= entry.sequence ? kept.builds.filter((build) => build.sequence === since).map((build) => build.print) : [];
        if (bases.length) deltas[since] = split(JSON.stringify(stateDelta(bases, entry.print, { ...entry.summary, ...stamped })));
      }
      const compact = entry.compact ??= compactItemSummaries(entry.summary);
      return {
        cacheId: entry.cacheId, sequence: entry.sequence, eventLogVersion: store.EVENT_LOG_VERSION, observedAt, current: entry.revision !== null, reportValidator,
        summary: variant(entry.summary, entry.summaryFields), compact: variant(compact, entry.compactFields ??= prepareStateJson(compact), '\0items:compact-v1'),
        full: full ? variant(entry.state, entry.stateJsonFields ??= prepareStateJson(entry.state)) : null, deltas,
        search: entry.searchTexts ??= entry.state.items.map((item) => [item.id, searchText(item)]),
        shouts: Float64Array.from(withBoard(board.root, (current) => current.db.prepare('SELECT shout_id FROM shout ORDER BY shout_id').all().map((row) => row.shout_id), codeIsMain, boardOpeners)),
      };
    }, observedAt)));
  }
  /** What the next build of a board extends: its latest build's items, their metadata and the inputs it read. */
  function carry(cacheId) {
    const entry = stateCache.get(cacheId);
    return entry ? { cacheId, sequence: entry.sequence, items: entry.items, itemMeta: entry.itemMeta, itemMoveCounts: entry.itemMoveCounts, inputs: entry.inputs, uncertain: entry.uncertain ?? [] } : null;
  }
  /** Resume from a carried build: never served as current, only extended by the next build's events. */
  function restore(value) {
    if (!stateCache.has(value.cacheId)) stateCache.set(value.cacheId, { ...value, revision: null, clockWindow: null });
  }
  /**
   * Where a board's saved build lives: a derived cache beside the board, named by the board, that a missing or
   * stale file only slows (the next build then starts from the board itself).
   */
  function snapshotPlace(board) {
    const { commonDir } = repoInfo(board.root);
    return { cacheId: commonDir + '\0' + board.id, folder: join(commonDir, 'pullboard', 'state-cache') };
  }
  return { withSnapshot, materialize, carry, restore, snapshotPlace, formats: `${store.SCHEMA_VERSION}:${store.EVENT_LOG_VERSION}`, stateCache, codeIsMain };
}

/** Share the local router with the person's view and other local transports; the standalone API explicitly denies person authority.
 * @param {{ secret: string | Buffer, getPort: () => number, runCommand: Function, projects?: () => any[], scope?: { projectRoot: string }, isMain?: boolean, allowedOrigins?: string[], allowedHosts?: string[], onStateBuild?: Function, onItemBuild?: Function, personChannel?: string, stateDetail?: string, now?: () => number, sessionCookie?: {name:string,value:string} }} [options]
 */
export function createLocalApiHandler({ secret, getPort, runCommand, projects = listApiProjects, scope, isMain, allowedOrigins = [], allowedHosts = [], onStateBuild, onItemBuild, personChannel = 'view', stateDetail = 'full', sessionCookie, now = () => Date.now(), settingsProviders, refusalDocument, boardOpeners, costModelPresentation, viewPorts, statePorts, onStateRecord } = {}) {
  const { openBoard } = requireBoardOpeners(boardOpeners);
  const { projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary } = viewPorts ?? {};
  if ([projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary].some(fn => typeof fn !== 'function')) throw new TypeError('createLocalApiHandler needs view projection ports');
  if (typeof now !== 'function') throw new TypeError('createLocalApiHandler needs an observation clock');
  if (typeof getPort !== 'function') throw new TypeError('createLocalApiHandler needs a bound-port getter');
  if (typeof runCommand !== 'function') throw new TypeError('createLocalApiHandler needs the actual CLI entry point as runCommand');
  // A page that still reads each item's detail from the state keeps full items until it opts in.
  if (!['full', 'summary'].includes(stateDetail)) throw new TypeError('createLocalApiHandler stateDetail is full or summary');
  if (sessionCookie !== undefined && (!sessionCookie || typeof sessionCookie.name !== 'string'
    || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(sessionCookie.name)
    || !hasCookieEntropyCapacity(sessionCookie.value))) {
    throw new TypeError('createLocalApiHandler sessionCookie needs a cookie name and a canonical base64url value with at least 128 bits of random capacity');
  }
  const projectScope = apiProjectScope(projects, scope);
  // Other API reads refresh the registry; settings must not prune or rewrite its saved metadata.
  const settingsProjects = projects === listApiProjects
    ? () => (registeredProjectRootsSnapshot() ?? []).map(root => ({ root })) : projects;
  const settingsScope = apiProjectScope(settingsProjects, scope);
  const apiProjects = projectScope.projects;
  const scopeCommonDir = projectScope.commonDir;
  const codeIsMain = codeIsFromMain() && isMain !== false;
  const key = Buffer.from(secret);
  const cookieName = sessionCookie?.name;
  const cookieKey = sessionCookie === undefined ? null : Buffer.from(sessionCookie.value);
  const permittedOrigins = new Set(allowedOrigins);
  // A transport may name exact literal interface addresses; DNS names, ports and wildcards are not authority.
  if (!Array.isArray(allowedHosts) || allowedHosts.some(host => typeof host !== 'string' || !isLiteralIPv4(host) || host === '0.0.0.0')) {
    throw new TypeError('createLocalApiHandler allowedHosts needs literal IPv4 addresses, without ports or wildcard binds');
  }
  const permittedHosts = [...new Set(allowedHosts)];
  const snapshots = createStateSnapshots({ projects, scope, isMain, onStateBuild, onItemBuild, now, boardOpeners, viewPorts });
  const { withSnapshot } = snapshots;
  // With statePorts, a worker keeps each board's state built and a state read only serves its latest text.
  const materializer = statePorts ? startStateMaterializer({ portsModule: statePorts, projects, scope, isMain, onStateBuild, onRecord: onStateRecord, Refused, openRevision: (board) => { const watcher = projectRead(board, () => watchLocalStateRevision(board, { scopeCommonDir })); return { revision: () => projectRead(board, () => watcher.revision()), close: () => watcher.close() }; },
    onFailure: (error) => process.stderr.write(`pullboard: the state worker stopped (${error?.message ?? error}); state reads now build on the request thread\n`) }) : null;
  /**
   * Serve a read from the worker while it runs, and from a direct build once it has stopped, including the reads
   * that were waiting on it: a failed worker never fails a read. A refusal from a running worker's build stands.
   */
  function materialized(fromWorker, direct) {
    if (!materializer?.alive) return direct();
    return fromWorker().catch((error) => { if (materializer.alive) throw error; return direct(); });
  }
  // Each board's item details by item id, and each board's spec-approval view (#1040).
  const detailCache = new Map();
  const approvalCache = new Map();
  // The fingerprints of the summary states each board's clients were sent, least recently sent
  // first, and the latest sequence a forgotten one had. A build only read for an item, a search or
  // a reset was never sent, so no client holds it and it is never a base.
  const deltaBases = new Map();
  /** Keep a summary state just sent, as a snapshot or as a delta's result, forgetting the oldest beyond the limit. */
  function keepSentBase(entry) {
    const kept = deltaBases.get(entry.cacheId) ?? { builds: [], forgottenThrough: -1 };
    kept.builds = kept.builds.filter((build) => build.print !== entry.print);
    kept.builds.push({ sequence: entry.sequence, print: entry.print });
    while (kept.builds.length > DELTA_BASES) kept.forgottenThrough = Math.max(kept.forgottenThrough, kept.builds.shift().sequence);
    deltaBases.set(entry.cacheId, kept);
  }
  /** Return item summaries or every item in full, as asked or by this server's default, and the JSON for either. */
  function localState(board, seen, { detail = null, items = null } = {}) {
    const observedAt = now();
    const compact = items === 'compact';
    const full = !compact && (detail ?? stateDetail) === 'full';
    const sent = withSnapshot(board, (entry, cached) => {
      const base = full ? entry.state : compact ? (entry.compact ??= compactItemSummaries(entry.summary)) : entry.summary;
      const state = stateForRequest(base, board.root, seen, entry.preparedFlow, cached, codeIsMain, observedAt, entry.comparisonHistory, boardOpeners, viewFlowSummary);
      // Full fragments wait for the first full request, so a server sending summaries never builds them.
      const fields = full ? (entry.stateJsonFields ??= prepareStateJson(entry.state))
        : compact ? (entry.compactFields ??= prepareStateJson(base)) : entry.summaryFields;
      const reportValidator = reportValidation(entry, observedAt);
      const validator = serializeState(state, fields, entry.reportValidator.json, true) + '\0report-expiry:' + reportValidator + (compact ? '\0items:compact-v1' : '');
      return { state, json: serializeState(state, fields), validator, reportValidator, entry };
    }, observedAt);
    // Only the build actually returned is sent; a delta extends summaries, never a full state.
    if (!full) keepSentBase(sent.entry);
    return sent;
  }
  /**
   * What changed in the item summaries' state since the summary state this server sent at event
   * `since`. A server that never sent one at `since`, or has forgotten it, answers with a reset that
   * names why instead of guessing; a delta's result is what the client then holds, so it is kept.
   */
  function localDelta(board, seen, { since, eventLogVersion = null }) {
    const observedAt = now();
    /** One build's answer: its delta from the summary states sent at `since`, or a reset naming why there is none. */
    const answerFor = (entry, cached) => {
      const state = stateForRequest(entry.summary, board.root, seen, entry.preparedFlow, cached, codeIsMain, observedAt, entry.comparisonHistory, boardOpeners, viewFlowSummary);
      const answer = { since, sequence: entry.sequence, eventLogVersion: store.EVENT_LOG_VERSION };
      const path = '/api/v1/boards/' + board.id + '/state';
      /** Tell the client to load a fresh snapshot, and why. */
      const reset = (code, message) => ({ ...answer, delta: null, reset: refusalDocument(new Refused(code, message)).error });
      if (eventLogVersion !== null && eventLogVersion !== String(store.EVENT_LOG_VERSION)) {
        return reset('FORMAT_CHANGED', `this server writes event-log format ${store.EVENT_LOG_VERSION}, not ${eventLogVersion}; use GET ${path} for a fresh snapshot`);
      }
      if (since > entry.sequence) return reset('BASE_AHEAD', `this board's latest event is ${entry.sequence}, before ${since}; use GET ${path} for a fresh snapshot`);
      const kept = deltaBases.get(entry.cacheId) ?? { builds: [], forgottenThrough: -1 };
      const bases = since <= kept.forgottenThrough ? [] : kept.builds.filter((build) => build.sequence === since).map((build) => build.print);
      if (!bases.length) return reset('BASE_NOT_KEPT', `this server keeps no snapshot it sent at event ${since}; use GET ${path} for a fresh snapshot`);
      return { ...answer, delta: stateDelta(bases, entry.print, state) };
    };
    const sent = withSnapshot(board, (entry, cached) => ({ entry, answer: answerFor(entry, cached) }), observedAt);
    if (sent.answer.delta) keepSentBase(sent.entry);
    return Object.defineProperty(sent.answer, 'reportValidator', { value: reportValidation(sent.entry, observedAt) });
  }
  /**
   * The spec-approval view one board's details share, kept while the files, HEAD and board records it
   * reads hold: it reads every row decision and sign-off, so building it per detail cost most of one.
   */
  function approvalFor(root, currentBoard, info) {
    const config = loadConfig(root);
    const meta = currentBoard.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key IN ('row_decisions', 'spec_approval_baseline') ORDER BY meta_key").all();
    const key = JSON.stringify([stateFileInputs(info.root, config, { fitFile }).map(fileMarker), fileMarkerForPath(join(info.root, '.mailmap')), resolveCommit(info.root, 'HEAD'), meta]);
    const cacheId = JSON.stringify([info.commonDir, root]);
    const cached = approvalCache.get(cacheId);
    if (cached?.key === key) return cached.approval;
    const approval = specApprovalState(root, { board: currentBoard, config }, { store, verifiedPasskeyRowDecision });
    approvalCache.delete(cacheId);
    approvalCache.set(cacheId, { key, approval });
    while (approvalCache.size > 32) approvalCache.delete(approvalCache.keys().next().value);
    return approval;
  }
  /**
   * One item's detail, or null when the board has no such item. It reads only that item's rows by
   * index, and its detail is kept by the item's last event id with the few facts beyond its own
   * events that a detail shows: its row and live leases, its prerequisites' statuses, the trunk and
   * the spec-approval inputs (#1040).
   */
  function localItem(board, id) {
    return withReadBoard(board.root, (currentBoard, info) => {
      currentBoard.db.exec('BEGIN');
      try {
        const detail = itemDetailIn(board, currentBoard, info, id);
        currentBoard.db.exec('COMMIT');
        return detail;
      } catch (error) {
        try { currentBoard.db.exec('ROLLBACK'); } catch { /* Preserve the projection failure. */ }
        throw error;
      }
    }, codeIsMain, boardOpeners);
  }
  /** Serve an item's cached detail while its key holds, building and keeping it when the key moved. */
  function itemDetailIn(board, currentBoard, info, id) {
    const { db } = currentBoard;
    const row = db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
    if (!row) return null;
    const now = currentBoard.clock.now().toISOString();
    const status = new Map();
    for (const dependency of localDependencyIds(row)) {
      const dependent = db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(dependency);
      if (dependent) status.set(dependency, dependent.item_status);
    }
    for (const ref of store.foreignDependencyStates(currentBoard, row)) status.set(`${ref.repo}#${ref.id}`, ref.status);
    // Detail reads need no new Git process while the trunk holds.
    const tip = trunkRevisionReader(info)();
    const approval = approvalFor(board.root, currentBoard, info);
    const key = JSON.stringify([row, row.item_status === 'claimed' && (row.item_lease_until ?? '') > now,
      row.item_status === 'submitted' && Boolean(row.item_review_by) && (row.item_review_until ?? '') > now,
      db.prepare('SELECT MAX(event_id) AS id FROM event WHERE item_id = ?').get(id).id,
      db.prepare('SELECT MAX(verdict_id) AS id FROM verdict WHERE item_id = ?').get(id).id,
      [...status], db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_check_baseline_${id}`)?.meta_value ?? null, tip]);
    const cacheId = JSON.stringify([info.commonDir, board.id]);
    let details = detailCache.get(cacheId);
    const cached = details?.get(id);
    if (cached?.key === key && cached.approval === approval) return cached.detail;
    const source = store.getItem(currentBoard, id);
    const base = projectItemSpecApprovals(projectItemState(currentBoard, source, status), approval);
    // The projector owns this transaction's connection; only derived values cross requests.
    const verdictState = verdictProjector(board.root, currentBoard, { main: tip }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem }).state(source);
    const projected = {
      ...base,
      ...(verdictState ? { verdictState } : {}),
      check: source.item_check,
      ...(source.item_check_baseline ? { checkBaseline: source.item_check_baseline } : {}),
      thread: store.itemThread(currentBoard, id),
    };
    onItemBuild?.({ board: board.id, itemId: id });
    const detail = itemDetail(projected);
    // Missing Git objects can arrive with no event or trunk move, so an uncertain verdict is read again.
    if (!verdictState?.reason) {
      if (!details) {
        details = new Map();
        detailCache.set(cacheId, details);
        while (detailCache.size > 32) detailCache.delete(detailCache.keys().next().value);
      }
      details.delete(id);
      details.set(id, { key, approval, detail });
      while (details.size > DETAIL_CACHE_ITEMS) details.delete(details.keys().next().value);
    }
    return detail;
  }
  /** The ids of the items the view's search would show for this text, in board-state order. */
  function localSearch(board, text) {
    const words = String(text).trim().toLowerCase();
    return withSnapshot(board, (entry) => {
      entry.searchTexts ??= entry.state.items.map((item) => [item.id, searchText(item)]);
      return entry.searchTexts.filter(([, searched]) => !words || searched.includes(words)).map(([id]) => id);
    });
  }
  /** Keep all later Git reads in a registered board response bounded, including cached projections and watchers. */
  function projectRead(board, read) {
    return withProjectGitTimeout(board.root, () => withGitReadFacts(read));
  }
  const handler = createApiHandler({
    refusalDocument,
    authenticate: (req) => {
      const url = new URL(req.url ?? '/', 'http://' + ADDRESS);
      const authorization = String(req.headers.authorization ?? '');
      const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? (authorization.startsWith('Bearer ') ? authorization.slice(7) : url.searchParams.get('k') ?? '')));
      const bound = getPort();
      const ownHost = req.headers.host === ADDRESS + ':' + bound || req.headers.host === 'localhost:' + bound
        || permittedHosts.some(host => req.headers.host === host + ':' + bound);
      const validKey = credentialMatches(given, key);
      const cookieValue = cookieKey ? requestCookie(req.headers.cookie, cookieName) : null;
      const givenCookie = Buffer.from(cookieValue ?? '');
      const validCookie = cookieKey !== null && cookieValue !== null && credentialMatches(givenCookie, cookieKey);
      const fetchSite = req.headers['sec-fetch-site'];
      const cookieFetchSiteAllowed = fetchSite === undefined || fetchSite === 'same-origin';
      if (!ownHost || (!validKey && (!validCookie || !cookieFetchSiteAllowed))) throw new Refused('AUTH_REQUIRED', 'this API needs its session secret and own host; use the address pullboard serve printed');
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && !permittedOrigins.has(req.headers.origin)) throw new Refused('API_ORIGIN', 'use the API from its own origin');
      return { local: true, privateLocal: !req.headers.origin || req.headers.origin === 'http://' + req.headers.host };
    },
    settings: (selected) => {
      if (!settingsProviders) throw new Refused('SERVICE_ERROR', 'this API was started without its settings providers; start it through pullboard serve or pullboard view');
      return settingsInventory(settingsScope.projects(), selected, settingsProviders);
    },
    boards: () => withGitReadFacts(() => apiBoardListing(apiProjects, codeIsMain, refusalDocument, boardOpeners)),
    decisions: (selected) => withGitReadFacts(() => projectDecisionListing(selected, apiProjects, codeIsMain, boardOpeners)),
    board: (id) => withGitReadFacts(() => findBoard(id, apiProjects, codeIsMain, boardOpeners)),
    state: (board, who, seen, options) => projectRead(board, () => localState(board, seen, options).state),
    stateJson: (board, who, seen, options) => materialized(() => materializer.stateJson(board, seen, { ...options, stateDetail }), () => projectRead(board, () => {
      const sent = localState(board, seen, options);
      return { json: sent.json, validator: sent.validator, reportValidator: sent.reportValidator };
    })),
    watchRevision: (board, who, { signals = true } = {}) => {
      if (!signals) return projectRead(board, () => watchEventSignals(board));
      const watcher = projectRead(board, () => watchLocalStateRevision(board, { scopeCommonDir }));
      const watched = { ...watcher, revision: () => projectRead(board, () => watcher.revision()) };
      return watched;
    },
    delta: (board, who, seen, options) => materialized(() => materializer.delta(board, seen, options, refusalDocument), () => projectRead(board, () => localDelta(board, seen, options))),
    proof: (board, id) => projectRead(board, () => withReadBoard(board.root, current => {
      try { store.itemById(current, id); }
      catch (error) { if (error.code === 'NO_ITEM') return null; throw error; }
      const report = proofStats(current, { now: now() }, { events: store.events, counterProofStats }).flow.report;
      const proof = report?.items?.find(item => item.id === id);
      if (!proof) throw new Refused('ITEM_NOT_AVAILABLE', 'this item exists, but its proof report is unavailable; run a normal writable board command to rebuild the derived report, then retry');
      return proof;
    }, codeIsMain, boardOpeners)),
    item: (board, id) => projectRead(board, () => localItem(board, id)),
    search: (board, text) => materialized(() => materializer.search(board, text), () => projectRead(board, () => localSearch(board, text))),
    shout: (board, id) => projectRead(board, () => relayLinked(board.root)
      ? relayPresentationShout(board.root, id, { verifiedPasskeyRowDecision, pendingFit, projectFit, projectState, personRequestStatuses, personSigningPresentation, activeViewAgents, viewProofSummary, claimHealthSnapshot, fitFile, openBoard })
      : withBoard(board.root, (db) => store.shoutDetails(db, id), codeIsMain, boardOpeners)),
    code: (board, ref) => projectRead(board, () => codeAt(board.root, ref)),
    jobs: (board, body) => withBoard(board.root, current => jobQueueCall(current.db, body, { mode: runnerDispatchMode(), now: now() }), codeIsMain, boardOpeners),
    costAnalytics: (board, window, who) => {
      if (!who.privateLocal || typeof costModelPresentation !== 'function') throw new Refused('ITEM_NOT_AVAILABLE', 'cost analytics is available only in the private local view');
      return projectRead(board, () => withReadBoard(board.root, current => costAnalytics({
      items: store.listItems(current, { all: true }), agents: store.listAgents(current), events: store.events(current),
      window, now: new Date(now()), modelPresentation: costModelPresentation,
      }), codeIsMain, boardOpeners));
    },
    events: (board, after) => withGitReadFacts(() => afterEvents(board.root, after, codeIsMain, boardOpeners)),
    eventLogVersion: () => store.EVENT_LOG_VERSION,
    move: (board, body) => executeMove(board.root, body, runCommand, codeIsMain, personChannel, refusalDocument, boardOpeners),
    request: (board, body) => createRequest(board.root, body, codeIsMain, personChannel, boardOpeners),
    tokens: async (board) => (await relayTokens(board.root, { err() {} })).tokens,
    revokeToken: (board, id) => relayRevoke(board.root, id, { personChannel, withOutboxGuard: boardOpeners.withOutboxGuard, replayConflictRecord: boardOpeners.replayConflictRecord, remoteBoardMissing: boardOpeners.remoteBoardMissing, uncertainUploadFailure: boardOpeners.uncertainUploadFailure, decideUncertainBaseline: boardOpeners.decideUncertainBaseline, checkpointPublisher: boardOpeners.checkpointPublisher, relayOrdering: boardOpeners.relayOrdering, checkpointInBackground: boardOpeners.checkpointInBackground, scheduleCheckpoint: boardOpeners.scheduleCheckpoint, requestCheckpointCheck: boardOpeners.requestCheckpointCheck, checkpointWorker: boardOpeners.checkpointWorker, openBoard: boardOpeners.openBoard, nativeBoardPorts: boardOpeners.nativeBoardPorts, outboxFields: boardOpeners.outboxFields, outboxPolicy: boardOpeners.outboxPolicy, flushOutbox: boardOpeners.flushOutbox, queueMove: boardOpeners.queueMove, outboxHasPendingCreatedItem: boardOpeners.outboxHasPendingCreatedItem, say() {}, err() {} }),
  }, { tagState: true });
  const closeStreams = handler.close;
  handler.close = () => { materializer?.close(); closeStreams?.(); };
  return handler;
}

/**
 * Serve the RFC 0002 API only on loopback, behind the same session-secret boundary as the view. Its
 * state sends item summaries unless asked for detail=full; each item's detail has its own path (A2).
 */
export function serveApi({ port = 0, secret = randomBytes(18).toString('base64url'), runCommand, projects = listApiProjects, isMain, onStateBuild, onItemBuild, stateDetail = 'summary', now = () => Date.now(), scope, settingsProviders, refusalDocument, boardOpeners, viewPorts, statePorts, onStateRecord } = {}) {
  if (typeof runCommand !== 'function') throw new TypeError('serveApi needs the actual CLI entry point as runCommand');
  let bound;
  // A serve key authenticates board access, never a person, even in an ordinary terminal.
  const handler = createLocalApiHandler({ secret, getPort: () => bound, runCommand, projects, isMain, onStateBuild, onItemBuild, personChannel: 'api', stateDetail, now, scope, settingsProviders, refusalDocument, boardOpeners, viewPorts, statePorts, onStateRecord });
  const server = createServer(handler);
  server.requestTimeout = 15_000;
  return new Promise((ready, fail) => {
    server.once('error', (error) => fail(new Refused(error.code === 'EADDRINUSE' ? 'PORT_BUSY' : 'API_LISTEN', `cannot listen on ${ADDRESS}:${port}: ${error.message}; run pullboard serve --port 0 to choose a free port`)));
    server.listen(port, ADDRESS, () => {
      bound = server.address().port;
      ready({
        url: `http://${ADDRESS}:${bound}/api/v1/boards?k=${secret}`,
        port: bound,
        close: () => new Promise((closed) => { handler.close(); server.close(() => closed()); server.closeIdleConnections(); }),
      });
    });
  });
}

/**
 * One verdict as the page shows it.
 *
 * @param {any} row A verdict row from store.verdictsFor.
 * @returns {{ decision: any, reason: any, note: any, by: any, at: any, commit: any }}
 */
function verdictOf(row) {
  return { decision: row.verdict_decision, reason: row.verdict_reason, note: row.verdict_note, by: row.verdict_by, at: row.verdict_at, commit: row.verdict_commit };
}

/**
 * One item as the page and the API show it (A2, N26): its fields, its verdicts, the items it waits on that are not yet
 * verified, and its full history. The API projects one item's detail with it, without building the whole state, so
 * the page and the API never word an item two ways. It only reads: it returns a fresh object and changes neither the
 * row nor the map.
 *
 * @param {any} board
 * @param {any} item The item's current row, as store.listItems reads it.
 * @param {Map<number, string>} status Every current item's status by its id.
 * @returns {any}
 */
export function projectItemState(board, item, status) {
  const verdicts = store.verdictsFor(board, item.item_id).map(verdictOf);
  const history = store.events(board, { itemId: item.item_id }).map(lifecycleEvent);
  const after = dependencyValues(item);
  const foreign = new Map(store.foreignDependencyStates(board, item).map(ref => [`${ref.repo}#${ref.id}`, ref.status]));
  return {
    id: item.item_id,
    title: item.item_title,
    lane: item.item_lane,
    status: item.item_status,
    withdrawnReason: item.item_status === 'withdrawn' ? item.item_withdrawn_reason ?? null : null,
    withdrawnFrom: withdrawnFrom(history, item.item_status),
    route: item.item_route,
    owner: item.item_owner,
    // Who holds the review under a live lease (V15), by the board's own rule.
    reviewer: store.reviewHolder(board, item),
    reviewUntil: item.item_review_until ?? null,
    builtBy: item.item_built_by,
    verifiedBy: item.item_verified_by,
    specs: item.item_spec_ids ? item.item_spec_ids.split(',') : [],
    criterion: item.item_criterion,
    brief: item.item_brief,
    commit: item.item_commit,
    merged: item.item_merged_commit,
    blockedBy: after.filter((id) => (typeof id === 'number' ? status.get(id) : foreign.get(id)) !== 'verified'),
    updatedAt: item.item_updated_at,
    verdict: verdicts.at(-1) ?? null,
    verdicts,
    history,
  };
}

/** The most lines one code reference shows (B23). */
const CODE_LINES = 60;
/** The largest file a code reference reads, in bytes. */
const CODE_BYTES = 2_000_000;

/**
 * The lines a shout's path:lines@commit reference names, as they were at that commit (B23). Git
 * alone reads them, from the commit's own tree: never the working tree, never a path outside the
 * repo, never a revision that is not a plain SHA, never lines past the file's end, and never more
 * than CODE_LINES lines. A reference is one word, so the text written before it on its line may be
 * the start of a longer path that ends in this one: when the commit holds such a file, the reference
 * may mean it, and it is refused rather than opened as a different file.
 *
 * @param {string} root
 * @param {{ path: string, from: number, to: number, commit: string, before?: string }} ref
 * @returns {{ path: string, commit: string, from: number, to: number, lines: string[], more: boolean }}
 */
export function codeAt(root, { path, from, to, commit, before = '' }) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Refused('BAD_REF', `name the commit by its SHA, 7 to 40 hex digits (saw "${commit}")`);
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Refused('BAD_REF', `name a file inside the repo by its path from the top, such as src/serve.js (saw "${path}")`);
  }
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from)) throw new Refused('BAD_REF', 'name the lines as 12, or 12-30');
  const full = resolveCommit(root, commit);
  if (!full) throw new Refused('NO_COMMIT', `no commit ${commit} in this repo`);
  const object = `${full}:${path}`;
  const type = gitSpawnSync(['cat-file', '-t', object], { cwd: root, encoding: 'utf8' });
  if (type.status !== 0 || type.stdout.trim() !== 'blob') throw new Refused('NO_FILE', `no file ${path} at ${commit}`);
  const written = `${before}${path}`;
  const names = gitSpawnSync(['ls-tree', '-r', '-z', '--name-only', full], { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000 }).stdout.split('\0');
  const longer = names.find((name) => name.length > path.length && name.endsWith(path) && written.endsWith(name));
  if (longer) throw new Refused('AMBIGUOUS', `the text before it may make it "${longer}", which a reference cannot name`);
  const size = Number(gitSpawnSync(['cat-file', '-s', object], { cwd: root, encoding: 'utf8' }).stdout);
  if (!(size <= CODE_BYTES)) throw new Refused('TOO_LARGE', `${path} is over ${CODE_BYTES / 1_000_000} MB, too large to show`);
  const lines = gitSpawnSync(['cat-file', 'blob', object], { cwd: root, encoding: 'utf8', maxBuffer: CODE_BYTES + 1 }).stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (to > lines.length) throw new Refused('NO_LINES', `${path} has ${lines.length} lines at ${commit}`);
  const last = Math.min(to, from + CODE_LINES - 1);
  return { path, commit: full, from, to: last, lines: lines.slice(from - 1, last), more: last < to };
}

