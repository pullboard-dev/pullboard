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
import { displayAgentName } from './agent-names.js';
import * as store from './board.js';
import {
  CONFIG_FILE,
  COORDINATOR,
  loadConfig,
} from './config.js';
import {
  codeIsFromMain,
  repoInfo,
  resolveCommit,
  withGitReadFacts,
} from './git.js';
import { refusalDocument } from './json.js';
import {
  relayLinked,
  relayOperation,
  relayRevoke,
  relayTokens,
} from './relay.js';
import { laneNames } from './lanes.js';
import { MACHINE } from './machine.js';
import {
  listApiProjects,
  registryFile,
  registeredProjectRootsSnapshot,
} from './projects.js';
import { milestoneRoadmap } from './roadmap.js';
import { proofStats } from './stats.js';
import {
  ruleProofCounts,
  ruleProofWindow,
} from './rule-proof-counts.js';
import {
  SUMMARY_KEYS,
  itemSummary,
  milestoneNamesByItem,
  withListFields,
} from './item-list.js';
import {
  prepareFlowHistory,
  projectFlowStats,
} from './stats-flow.js';
import { projectRowDecisions } from './row-decisions.js';
import {
  projectItemSpecApprovals,
  projectSpecApprovals,
  specApprovalState,
} from './spec-approval.js';
import {
  fitFile,
  pendingFit,
  projectFit,
} from './blueprint-fit.js';
import { Refused } from './refused.js';
import {
  BLOCKS_FILE,
  personBlockWords,
} from './blocks.js';
import { verdictProjector } from './verdict-freshness.js';
import { trunkRevisionReader } from './trunk-revision.js';
import {
  codeAt,
  projectItemState,
  projectState,
} from './serve.js';
import { relayPresentationShout } from './relay-presentation.js';
import { createApiHandler } from './api-http.js';
import { settingsInventory } from './settings-inventory.js';
import { moveArgs } from './api-moves.js';
import { personRequestStatuses } from './relay-requests.js';
export { moveArgs } from './api-moves.js';

/** Inputs shared by the complete state cache and the lightweight live-change watcher. */
const STATE_REVISION_INPUTS = Object.freeze([
  'identity', 'head', 'trunk', 'files', 'event', 'agents', 'leases', 'requestReceipts', 'milestones', 'externalRoadmap', 'eventLogVersion', 'ruleProofWindow',
]);

/** Serialize named state inputs in one stable order for cache and stream comparisons. */
function stateRevision(inputs) {
  return JSON.stringify(STATE_REVISION_INPUTS.map((name) => [name, inputs[name]]));
}

/** Name project and built-in files separately, even when their basenames collide. */
function stateFileInputs(root, config) {
  return [
    { name: `config:${CONFIG_FILE}`, path: join(root, CONFIG_FILE) },
    { name: `spec:${config.spec}`, path: join(root, config.spec) },
    { name: `practice:${config.practice}`, path: join(root, config.practice) },
    { name: 'builtin:standard-doctrine.md', path: new URL('./standard-doctrine.md', import.meta.url) },
    ...['signoffs.jsonl', 'signers', 'first-commit', 'signers.initial'].map(name => ({ name: `approval:${name}`, path: join(root, '.pullboard', name) })),
    { name: 'fit:blueprint-fit.json', path: fitFile(repoInfo(root).commonDir) },
    // A new block changes Needs you without a board move, so the ledger is a state input [C6].
    { name: 'blocks:blocks.jsonl', path: join(repoInfo(root).commonDir, BLOCKS_FILE) },
  ];
}

/** Hash the exact bytes of one named input, preserving a missing-file marker. */
function fileRevision(file) {
  if (!existsSync(file.path)) return [file.name, null];
  return [file.name, createHash('sha256').update(readFileSync(file.path)).digest('hex')];
}

/**
 * Read this board's own revision inputs from one open connection, for the cache and the watcher alike.
 * nextExpiry is the earliest live claim or review lease, when a lease turns over with no write.
 */
function localRevisionInputs(board, now) {
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
function boardStateRevision(root, id, isMain, { projects = listApiProjects, scopeCommonDir = null } = {}) {
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const files = stateFileInputs(info.root, config).map(fileRevision);
  const local = withBoard(info.root, (board) => {
    const inputs = localRevisionInputs(board, board.clock.now().toISOString());
    const hasExternalMilestones = inputs.milestones.some((milestone) => milestone.items.some((item) => typeof item !== 'number'));
    return { ...inputs, externalMilestones: hasExternalMilestones
      ? scopeCommonDir === null
        ? milestoneRoadmap(info.root, board)
        : milestoneRoadmap(info.root, board, { projects, hideOutOfScope: true })
      : null };
  }, isMain);
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
    try { return repoInfo(project.root).commonDir === scopeCommonDir; }
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
  let files = stateFileInputs(info.root, config);
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

  try {
    dbMarker = fileMarkerForPath(dbPath);
    fileMarkers = files.map(fileMarker);
    fileContent = files.map(fileRevision);
    head = headFileRevision(info);
    dataVersion = db.prepare('PRAGMA data_version').get().data_version;
  } catch (error) {
    db.close();
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
      files = stateFileInputs(info.root, latestConfig);
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
    return stateRevision({
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
    });
  }

  return {
    revision,
    close() {
      if (closed) return;
      closed = true;
      try { external?.close(); } finally { db.close(); }
    },
  };
}

/** Build the complete local API state, including fields that the shared project snapshot omits. */
function buildLocalBoardState(root, boardId, board, codeIsMain, { previous = null, fullItemRebuild = true, afterSequence = 0, changedLeases = new Set(), onItemBuild, projects = listApiProjects, scopeCommonDir = null } = {}) {
  board.db.exec('BEGIN');
  try {
    const sequence = board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id;
    let rebuildAll = fullItemRebuild || (previous && previous.sequence > sequence);
    const eventRows = rebuildAll || !previous ? [] : board.db.prepare('SELECT event_id, item_id FROM event WHERE event_id > ? ORDER BY event_id').all(afterSequence);
    if (!rebuildAll && previous && eventRows.length !== sequence - previous.sequence) rebuildAll = true;
    const dirtyIds = new Set(rebuildAll ? [] : [...changedLeases]);
    for (const event of eventRows) if (event.item_id !== null) dirtyIds.add(event.item_id);

    const currentItems = store.listItems(board, { all: true });
    const currentById = new Map(currentItems.map((item) => [item.item_id, item]));
    const currentDependencies = new Map(currentItems.map((item) => [item.item_id, dependencyIds(item)]));
    const milestoneNames = milestoneNamesByItem(store.milestones(board));
    for (const prior of previous?.itemMeta.values() ?? []) {
      if (!currentById.has(prior.id)) dirtyIds.add(prior.id);
    }
    for (const item of currentItems) {
      const prior = previous?.itemMeta.get(item.item_id);
      if (rebuildAll || !previous?.items.has(item.item_id) || !prior || prior.raw !== JSON.stringify(item)) dirtyIds.add(item.item_id);
      if (prior && prior.milestone !== (milestoneNames.get(item.item_id) ?? null)) dirtyIds.add(item.item_id);
    }
    // A dirty item's status affects the blockedBy list of every direct old or new dependent.
    const changedIds = [...dirtyIds];
    for (const dependent of previous?.itemMeta.values() ?? []) {
      if (changedIds.some((id) => dependent.dependencies.includes(id))) dirtyIds.add(dependent.id);
    }
    for (const [id, dependencies] of currentDependencies) {
      if (changedIds.some((changed) => dependencies.includes(changed))) dirtyIds.add(id);
    }

    const config = loadConfig(root);
    const freshness = verdictProjector(root, board, { main: trunkRevisionReader(repoInfo(root))() });
    const state = projectState(root, { seen: null, board, itemProjector: (item, context) => {
      if (dirtyIds.has(item.item_id)) {
        const projected = context.project();
        const verdictState = freshness.state(item);
        return verdictState ? { ...projected, verdictState } : projected;
      }
      return previous.items.get(item.item_id);
    } });
    state.agents = state.agents.map((agent) => ({ ...agent, model: agent.agent_model ?? 'unknown', displayName: displayAgentName(agent, config.agents.names) }));
    state.board = boardId;
    state.decisionQueue = store.openDecisions(board, COORDINATOR);
    const projectData = {
      requests: store.openRequests(board),
      personRequests: personRequestStatuses(board),
      milestones: scopeCommonDir === null
        ? milestoneRoadmap(root, board)
        : milestoneRoadmap(root, board, { projects, hideOutOfScope: true }),
      rowDecisions: store.rowDecisions(board),
      proofStats: proofStats(board),
    };
    state.proofStats = projectData.proofStats;
    state.requests = projectData.requests;
    state.personRequests = projectData.personRequests;
    state.milestones = projectData.milestones;
    state.blocks = personBlockWords(repoInfo(root).commonDir, board.clock.now()); // Needs you below is recomputed with them [C6].
    const decorated = projectSpecApprovals(projectFit(pendingFit(repoInfo(root).commonDir), projectRowDecisions(projectData.rowDecisions, state)), specApprovalState(root, { board, config }));
    decorated.ruleCounts = ruleProofCounts(root, board, decorated.spec);
    const bases = new Map(decorated.items.map((item) => [item.id, item]));
    for (const id of dirtyIds) {
      if (!currentById.has(id)) continue;
      const item = store.getItem(board, id);
      const base = bases.get(id);
      const full = {
        ...base,
        check: item.item_check,
        ...(item.item_check_baseline ? { checkBaseline: item.item_check_baseline } : {}),
        thread: store.itemThread(board, id),
      };
      bases.set(id, full);
      onItemBuild?.({ board: boardId, itemId: id });
    }
    decorated.items = decorated.items.map((item) => bases.get(item.id) ?? item);
    const leases = new Map(currentItems.map((item) => [item.item_id, item.item_lease_until ?? null]));
    const listFields = withListFields(decorated, leases, { previous, dirtyIds });
    const itemMeta = new Map(currentItems.map((item) => [item.item_id, {
      id: item.item_id,
      raw: JSON.stringify(item),
      dependencies: currentDependencies.get(item.item_id) ?? [],
      milestone: milestoneNames.get(item.item_id) ?? null,
    }]));
    const history = store.events(board);
    board.db.exec('COMMIT');
    return { state: listFields.state, itemMeta, itemMoveCounts: listFields.itemMoveCounts, sequence, history };
  } catch (error) {
    try { board.db.exec('ROLLBACK'); } catch { /* Preserve the projection failure. */ }
    throw error;
  }
}

/** Parse an item's ordered prerequisite IDs from its persisted row. */
function dependencyIds(item) {
  return item.item_after ? item.item_after.split(',').map(Number) : [];
}

/** Everything a summary leaves out, with the latest verdict whole: laid over its summary, it is the full item. */
function itemDetail(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => key === 'id' || key === 'verdict' || key === 'verdictState' || !SUMMARY_KEYS.has(key)));
}

/** The text the view's search matches for an item, lowercased: its #id, title, lane, spec ids and criterion. */
function searchText(item) {
  return ('#' + item.id + ' ' + item.title + ' ' + item.lane + ' ' + item.specs.join(' ') + ' ' + (item.criterion || '')).toLowerCase();
}

/** One cached board build: the full state, its item summaries, its delta fingerprint and the lookups that serve them. */
function snapshotEntry(revision, state, preparedFlow, { inputs = null, itemMeta = new Map(), itemMoveCounts = new Map() } = {}) {
  const summary = { ...state, items: state.items.map(itemSummary) };
  const reportValidator = { json: JSON.stringify(state.proofStats?.flow?.report), expiries: [...new Set(preparedFlow.items.flatMap(item =>
    item.state === 'claimed' ? [item.leaseUntil] : item.state === 'submitted' ? [item.reserve?.until] : []).filter(Number.isFinite))].sort((a, b) => a - b) };
  reportValidator.digest = createHash('sha256').update(reportValidator.json ?? 'null').digest('hex');
  return { revision, sequence: state.sequence, state, summary, preparedFlow, reportValidator, summaryFields: prepareStateJson(summary), stateJsonFields: null,
    print: fingerprint(summary), items: new Map(state.items.map((item) => [item.id, item])), itemMeta, itemMoveCounts, inputs, searchTexts: null };
}

/** State fields every delta carries whole: this request's unread count and flow, and the small Needs-you lists. */
const DELTA_WHOLE = new Set(['unseen', 'proofStats', 'decisions', 'decisionQueue', 'holds', 'requests', 'personRequests']);
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
function stateForRequest(state, root, seen, preparedFlow, refreshFlow, isMain) {
  const projection = seen === null ? { unseen: null } : withBoard(root, (board) => ({
    unseen: { since: seen, count: board.db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_id > ?').get(seen).n },
  }), isMain);
  if (refreshFlow && preparedFlow) {
    projection.proofStats = {
      ...state.proofStats,
      flow: projectFlowStats(preparedFlow, null, Date.now(), state.proofStats),
    };
  }
  return { ...state, ...projection };
}

/** Cache JSON fragments for state fields whose values stay fixed across a cache hit. */
function prepareStateJson(state) {
  const fields = Object.entries(state).map(([key, value]) => {
    if (key === 'unseen') return { dynamic: key };
    if (key === 'proofStats') {
      const stats = Object.entries(value).filter(([name]) => name !== 'flow').map(([name, entry]) => jsonField(name, entry)).filter(Boolean);
      return { dynamic: key, stats };
    }
    return { static: jsonField(key, value) };
  });
  if (!fields.some((field) => field.dynamic === 'unseen')) fields.push({ dynamic: 'unseen' });
  return fields;
}

/** Serialize a state field through JSON.stringify, omitting values JSON would omit. */
function jsonField(key, value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? '' : JSON.stringify(key) + ':' + encoded;
}

/** Reuse recorded report material while retaining genuine native lease-boundary changes. */
function reportValidation(entry, now = Date.now()) {
  const expiries = entry.reportValidator.expiries;
  let low = 0, high = expiries.length;
  while (low < high) { const middle = (low + high) >>> 1; if (expiries[middle] <= now) low = middle + 1; else high = middle; }
  return entry.reportValidator.digest + ':' + low;
}

/** Reuse static state fragments while encoding request-specific unread and flow data. */
function serializeState(state, fields, reportJson) {
  if (!fields) return JSON.stringify(state);
  const encoded = fields.map((field) => {
    if (field.static !== undefined) return field.static;
    if (field.dynamic === 'unseen') return jsonField('unseen', state.unseen);
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

const ADDRESS = '127.0.0.1';
const VERSION = 1;

/** Read a registered board and release its SQLite connection on every path.
 *
 * @param {string} root
 * @param {(board: any, info: any) => any} read
 * @param {boolean} [isMain] Whether the running CLI code comes from the main checkout.
 */
function withBoard(root, read, isMain) {
  const info = repoInfo(root);
  loadConfig(info.root);
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  // A read takes no write lock and never migrates (#1047): main code reads an older board as it is,
  // branch code keeps the schema guard, and a read that writes after all runs again on a write open.
  const opened = store.openBoardForRead(file);
  const main = () => isMain !== false && codeIsFromMain();
  if (opened && (opened.current || main())) try { return read(opened, info); } catch (error) { if (!store.writeRefused(error)) throw error; } finally { store.closeBoard(opened); }
  else if (opened) store.closeBoard(opened);
  const board = store.openBoard(file, undefined, { isMain: main() });
  try { return read(board, info); } finally { store.closeBoard(board); }
}

/**
 * Read a board on a read-only connection when it is at this code's schema and event-log version.
 * Why: openBoard migrates, writes the board id and checkpoints the log on close, so every read
 * waited behind agents' writes (#1040). Any other board goes through withBoard, which upgrades or refuses it.
 */
function withReadBoard(root, read, isMain) {
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
    return withBoard(root, read, isMain);
  }
  try { return read({ db, clock: store.systemClock }, info); } finally { db.close(); }
}

/** Registered boards carry one persistent identity across local and relay addresses. */
export function apiBoards(projects = listApiProjects, isMain) {
  return projects().flatMap((project) => {
    try { return [withBoard(project.root, (board) => ({ ...project, id: store.boardId(board) }), isMain)]; }
    catch { return []; }
  });
}

/**
 * List readable registered boards and retain actionable warnings for entries that failed to open.
 *
 * @param {() => { root: string, name: string, project: string, added: string }[]} projects
 * @returns {{ boards: object[], warnings: object[] }}
 */
export function apiBoardListing(projects = listApiProjects, isMain) {
  const boards = [];
  const warnings = [];
  for (const project of projects()) {
    try {
      boards.push(withBoard(project.root, (board) => ({ ...project, id: store.boardId(board) }), isMain));
    } catch (cause) {
      const error = ['EVENT_LOG_VERSION', 'UNMERGED_SCHEMA'].includes(cause.code) ? cause : new Refused('BOARD_UNAVAILABLE', `registered project ${project.root} cannot be read; restore the repo or run pullboard forget ${project.root}`);
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
function projectDecisionListing(selected, projects, isMain) {
  if (!selected) throw new Refused('BAD_REQUEST', 'name a registered board with ?board=<id> from GET /api/v1/boards');
  const home = findBoard(selected, projects, isMain);
  const members = home.project ? projects().filter((entry) => entry.project === home.project) : [home];
  const decisions = [];
  const unreadable = [];
  for (const member of members) {
    try {
      withReadBoard(member.root, (board) => {
        const id = store.boardId(board);
        for (const ask of store.openDecisions(board, store.PERSON)) decisions.push({ ...ask, board: id, repo: member.name });
      }, isMain);
    } catch { unreadable.push(member.name); }
  }
  return { version: 1, project: home.project ?? '', decisions, unreadable };
}

/** Resolve only registered boards, so a request cannot open an arbitrary path on the machine. */
function findBoard(id, projects, isMain) {
  // Each request resolves its board, so this opens boards read-only and stops at the match (#1040).
  const board = projects().find((project) => {
    try { return withReadBoard(project.root, (current) => store.boardId(current), isMain) === id; }
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
    try { return repoInfo(project.root).commonDir === commonDir; }
    catch { return false; }
  });
  if (scoped().length !== 1) throw new Refused('PROJECT_SCOPE', 'scope the API to exactly one registered project repository or linked worktree');
  return { projects: scoped, commonDir };
}

/** Read events in sequence, including changes made by other processes on the same board. */
function afterEvents(root, after, isMain) {
  return withBoard(root, (board) => board.db.prepare('SELECT * FROM event WHERE event_id > ? ORDER BY event_id').all(after), isMain);
}

/** Resolve an authenticated local caller's agent to its own checkout, never another board. */
function agentPath(root, name = COORDINATOR, isMain) {
  if (typeof name !== 'string' || !name) throw new Refused('BAD_REQUEST', 'agent needs a registered name; omit it to act as the coordinator');
  return withBoard(root, (board, info) => {
    if (name === COORDINATOR && !relayLinked(root)) store.ensureCoordinator(board, root);
    const agent = store.listAgents(board).find((entry) => entry.agent_id === name);
    if (!agent) throw new Refused('NO_AGENT', `no registered agent ${name}; use the agents in this board's state or join a worktree first`);
    // A clone shares the coordinator identity, but resolves its main checkout locally.
    if (name === COORDINATOR && relayLinked(root)) return root;
    if (repoInfo(agent.agent_path).commonDir !== info.commonDir) throw new Refused('WRONG_BOARD', `agent ${name}'s worktree belongs to another board; join the agent in this board's worktree`);
    return agent.agent_path;
  }, isMain);
}

/** Execute one actual CLI command and retain its emitted event without a latest-row race. */
export async function executeMove(root, body, runCommand, isMain, personChannel = 'view') {
  if (Object.keys(body).some((key) => !['verb', 'item', 'args', 'agent'].includes(key))) throw new Refused('BAD_REQUEST', 'a move takes only verb, item, args and agent; remove the unknown fields');
  const argv = moveArgs(body);
  let cwd;
  try { cwd = agentPath(root, body.agent, isMain); } catch (error) {
    if (!(error instanceof Refused) || error.code === 'BAD_REQUEST') throw error;
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
  if (!event) throw new Error(`move ${body.verb} produced no event${diagnostics ? `: ${diagnostics}` : ''}`);
  return { status: 200, body: { version: VERSION, event, result } };
}

/** Create a person's coordinator request through the view's channel, never a standalone serve key. */
async function createRequest(root, body, isMain, personChannel) {
  if (personChannel !== 'view') throw new Refused('B26_PERSON_CHANNEL', 'person requests use the terminal or the view; run pullboard view');
  if (typeof body.text !== 'string' || !body.text.trim() || Object.keys(body).some((key) => key !== 'text')) throw new Refused('BAD_REQUEST', 'a request needs {text: "what the coordinator should do"}');
  const message = { from: 'person', to: COORDINATOR, text: body.text, request: true, lanes: laneNames(loadConfig(root)) };
  if (relayLinked(root)) {
    const id = await relayOperation(root, 'shout', [message], { err: () => {} });
    return withBoard(root, (board) => ({ version: VERSION,
      event: store.events(board).find((event) => JSON.parse(event.event_detail).shout === id),
      result: { id, request: true } }), isMain);
  }
  return withBoard(root, (board) => {
    const id = store.shout(board, message);
    return { version: VERSION, event: board.lastEvent, result: { id, request: true } };
  }, isMain);
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

/** Share the local router with the person's view and other local transports; the standalone API explicitly denies person authority.
 * @param {{ secret: string | Buffer, getPort: () => number, runCommand: Function, projects?: () => any[], scope?: { projectRoot: string }, isMain?: boolean, allowedOrigins?: string[], allowedHosts?: string[], onStateBuild?: Function, onItemBuild?: Function, personChannel?: string, stateDetail?: string, sessionCookie?: {name:string,value:string} }} [options]
 */
export function createLocalApiHandler({ secret, getPort, runCommand, projects = listApiProjects, scope, isMain, allowedOrigins = [], allowedHosts = [], onStateBuild, onItemBuild, personChannel = 'view', stateDetail = 'full', sessionCookie } = {}) {
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
  const stateCache = new Map();
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
  /** File, identity, HEAD or wire-version changes invalidate the item projector's assumptions. */
  function needsFullItemRebuild(cached, before) {
    if (!cached || !before.cacheable || cached.sequence > before.event) return true;
    const previous = cached.inputs;
    const current = before.inputs;
    if (!previous) return true;
    return ['identity', 'head', 'trunk', 'files', 'eventLogVersion'].some((key) => JSON.stringify(previous[key]) !== JSON.stringify(current[key]));
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
  function withSnapshot(board, read) {
    const before = boardStateRevision(board.root, board.id, codeIsMain, { projects: apiProjects, scopeCommonDir });
    const cached = stateCache.get(before.cacheId);
    if (before.cacheable && cached?.revision === before.revision) {
      const result = read(cached, true);
      const after = boardStateRevision(board.root, board.id, codeIsMain, { projects: apiProjects, scopeCommonDir });
      if (after.cacheable && after.revision === before.revision) {
        stateCache.delete(before.cacheId);
        stateCache.set(before.cacheId, cached);
        return result;
      }
    }

    const fullItemRebuild = needsFullItemRebuild(cached, before);
    const changedLeases = fullItemRebuild ? new Set() : changedLeaseItems(cached, before);
    onStateBuild?.({ board: board.id });
    // Keep projection, global fields, event history and sequence in one SQLite read transaction.
    const built = withBoard(board.root, (currentBoard) => buildLocalBoardState(board.root, board.id, currentBoard, codeIsMain, {
      previous: fullItemRebuild ? null : cached,
      fullItemRebuild,
      afterSequence: cached?.sequence ?? 0,
      changedLeases,
      onItemBuild,
      projects: apiProjects,
      scopeCommonDir,
    }), codeIsMain);
    const state = { ...built.state, sequence: built.sequence };
    const entry = snapshotEntry(before.revision, state, prepareFlowHistory(built.history), {
      inputs: before.inputs,
      itemMeta: built.itemMeta,
      itemMoveCounts: built.itemMoveCounts,
    });
    entry.cacheId = before.cacheId;
    const after = boardStateRevision(board.root, board.id, codeIsMain, { projects: apiProjects, scopeCommonDir });
    // Missing Git objects can arrive without a board event or trunk move; retry that uncertainty.
    if (before.cacheable && after.cacheable && before.revision === after.revision &&
        !state.items.some(item => item.verdictState?.reason)) {
      stateCache.set(before.cacheId, entry);
      while (stateCache.size > 32) stateCache.delete(stateCache.keys().next().value);
    } else {
      stateCache.delete(before.cacheId);
    }
    return read(entry, false);
  }
  /** Return item summaries or every item in full, as asked or by this server's default, and the JSON for either. */
  function localState(board, seen, { detail = null } = {}) {
    const full = (detail ?? stateDetail) === 'full';
    const sent = withSnapshot(board, (entry, cached) => {
      const state = stateForRequest(full ? entry.state : entry.summary, board.root, seen, entry.preparedFlow, cached, codeIsMain);
      // Full fragments wait for the first full request, so a server sending summaries never builds them.
      const fields = full ? (entry.stateJsonFields ??= prepareStateJson(entry.state)) : entry.summaryFields;
      const reportValidator = reportValidation(entry);
      const validator = serializeState(state, fields, entry.reportValidator.json) + '\0report-expiry:' + reportValidator;
      return { state, json: serializeState(state, fields), validator, reportValidator, entry };
    });
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
    /** One build's answer: its delta from the summary states sent at `since`, or a reset naming why there is none. */
    const answerFor = (entry, cached) => {
      const state = stateForRequest(entry.summary, board.root, seen, entry.preparedFlow, cached, codeIsMain);
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
    const sent = withSnapshot(board, (entry, cached) => ({ entry, answer: answerFor(entry, cached) }));
    if (sent.answer.delta) keepSentBase(sent.entry);
    return Object.defineProperty(sent.answer, 'reportValidator', { value: reportValidation(sent.entry) });
  }
  /**
   * The spec-approval view one board's details share, kept while the files, HEAD and board records it
   * reads hold: it reads every row decision and sign-off, so building it per detail cost most of one.
   */
  function approvalFor(root, currentBoard, info) {
    const config = loadConfig(root);
    const meta = currentBoard.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key IN ('row_decisions', 'spec_approval_baseline') ORDER BY meta_key").all();
    const key = JSON.stringify([stateFileInputs(info.root, config).map(fileMarker), fileMarkerForPath(join(info.root, '.mailmap')), resolveCommit(info.root, 'HEAD'), meta]);
    const cacheId = JSON.stringify([info.commonDir, root]);
    const cached = approvalCache.get(cacheId);
    if (cached?.key === key) return cached.approval;
    const approval = specApprovalState(root, { board: currentBoard, config });
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
    }, codeIsMain);
  }
  /** Serve an item's cached detail while its key holds, building and keeping it when the key moved. */
  function itemDetailIn(board, currentBoard, info, id) {
    const { db } = currentBoard;
    const row = db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
    if (!row) return null;
    const now = currentBoard.clock.now().toISOString();
    const status = new Map();
    for (const dependency of dependencyIds(row)) {
      const dependent = db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(dependency);
      if (dependent) status.set(dependency, dependent.item_status);
    }
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
    const verdictState = verdictProjector(board.root, currentBoard, { main: tip }).state(source);
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
  return createApiHandler({
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
      return { local: true };
    },
    settings: (selected) => settingsInventory(settingsScope.projects(), selected),
    boards: () => withGitReadFacts(() => apiBoardListing(apiProjects, codeIsMain)),
    decisions: (selected) => withGitReadFacts(() => projectDecisionListing(selected, apiProjects, codeIsMain)),
    board: (id) => withGitReadFacts(() => findBoard(id, apiProjects, codeIsMain)),
    state: (board, who, seen, options) => withGitReadFacts(() => localState(board, seen, options).state),
    stateJson: (board, who, seen, options) => withGitReadFacts(() => {
      const sent = localState(board, seen, options);
      return { json: sent.json, validator: sent.validator, reportValidator: sent.reportValidator };
    }),
    watchRevision: (board) => {
      const watcher = withGitReadFacts(() => watchLocalStateRevision(board, { scopeCommonDir }));
      return { ...watcher, revision: () => withGitReadFacts(() => watcher.revision()) };
    },
    delta: (board, who, seen, options) => withGitReadFacts(() => localDelta(board, seen, options)),
    item: (board, id) => withGitReadFacts(() => localItem(board, id)),
    search: (board, text) => withGitReadFacts(() => localSearch(board, text)),
    shout: (board, id) => withGitReadFacts(() => relayLinked(board.root)
      ? relayPresentationShout(board.root, id)
      : withBoard(board.root, (db) => store.shoutDetails(db, id), codeIsMain)),
    code: (board, ref) => withGitReadFacts(() => codeAt(board.root, ref)),
    events: (board, after) => withGitReadFacts(() => afterEvents(board.root, after, codeIsMain)),
    eventLogVersion: () => store.EVENT_LOG_VERSION,
    move: (board, body) => executeMove(board.root, body, runCommand, codeIsMain, personChannel),
    request: (board, body) => createRequest(board.root, body, codeIsMain, personChannel),
    tokens: async (board) => (await relayTokens(board.root, { err() {} })).tokens,
    revokeToken: (board, id) => relayRevoke(board.root, id, { personChannel, say() {}, err() {} }),
  }, { tagState: true });
}

/**
 * Serve the RFC 0002 API only on loopback, behind the same session-secret boundary as the view. Its
 * state sends item summaries unless asked for detail=full; each item's detail has its own path (A2).
 */
export function serveApi({ port = 0, secret = randomBytes(18).toString('base64url'), runCommand, projects = listApiProjects, isMain, onStateBuild, onItemBuild, stateDetail = 'summary' } = {}) {
  if (typeof runCommand !== 'function') throw new TypeError('serveApi needs the actual CLI entry point as runCommand');
  let bound;
  // A serve key authenticates board access, never a person, even in an ordinary terminal.
  const handler = createLocalApiHandler({ secret, getPort: () => bound, runCommand, projects, isMain, onStateBuild, onItemBuild, personChannel: 'api', stateDetail });
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
