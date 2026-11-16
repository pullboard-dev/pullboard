/** Find synchronous child processes reachable from board API request handlers, without executing any module [C7]. */
import { callGraph } from './write.js';

/** Where a request enters: every function of the API's own modules, plus the ports `pullboard serve` hands the API. */
const API_FILE = /^packages\/api\/src\/io\/[^/]+\.js$/u;
// The other HTTP servers: the view's server, the relay's handler and the transport pull server each answer requests on the event loop.
export const HTTP_SERVERS = Object.freeze([
  'apps/view/src/io/serve.js#serveView',
  'apps/relay/src/io/service.js#createRelayHandler',
  'apps/relay/src/io/service.js#serveRelay',
  'packages/transport/src/io/pull/http.js#pullServer',
]);
// `pullboard serve` installs these as request-time callbacks, so each is an entry although no api module names it.
const SERVE_PORTS = Object.freeze([
  'apps/cli/src/io/submit/receipt.js#criterionMainReceipts',
  'packages/landing/src/io/main/red/receipt.js#mainReceipts',
  'packages/landing/src/io/main/red/receipt.js#nearbyMainClass',
  'apps/cli/src/io/commands/serve.js#boardStatePorts',
]);
// `pullboard serve` also hands the API functions as arguments, which no api module names: the view's projections
// (`viewPorts`), the settings providers, and the CLI entry the move handlers run (`runCommand`) [#6756]. Each list is
// read from the source that composes it, so a function added to one is walked without editing this check.
const CALLBACK_LISTS = Object.freeze([
  { file: 'apps/view/src/io/ports.js', list: /viewApiPorts\s*=\s*Object\.freeze\(\{([^}]*)\}\)/u, what: 'viewPorts' },
  { file: 'apps/cli/src/io/commands/serve.js', list: /settingsProviders:\s*\{([^}]*)\}/u, what: 'settingsProviders' },
]);
const RUN_COMMAND = 'apps/cli/src/io/main.js#main';
/**
 * Further walk roots a caller may name through `extraRoots`: the materializer worker (every function in its file, as
 * it answers the API off the request path) and the rule-proof append. A root is `file#function`, or a bare `file`
 * for every function in it. The walk only adds these roots when its caller opts in [#9677].
 */
export const EXTRA_REQUEST_ROOTS = Object.freeze([
  'packages/api/src/io/state/materializer/worker.js',
  'packages/verify/src/io/rule/proof/append.js#appendRuleProof',
]);
// Calls that block the event loop: a child until it exits (`gitSpawnSync` is git's own wrapper over spawnSync), a
// whole directory listing, and a thread parked on `Atomics.wait` [#6754].
const BLOCKING = /^(?:(?:node:)?child_process#(?:spawnSync|execSync|execFileSync)|(?:node:)?fs#readdirSync|global:Atomics#wait|.*#(?:gitSpawnSync|gitExecFileSync))$/u;
/** `Atomics.wait` is a global, so no import resolves it: a call by that name is the blocking one unless the module declares its own `Atomics`. */
const ATOMICS_WAIT = Object.freeze({ builtin: 'global:Atomics', name: 'wait' });

/** Blocking calls reachable only through the additional walk roots. */
const EXTRA_REQUEST_BLOCKERS = Object.freeze({
  'packages/api/src/io/state/materializer/worker.js#codeStamp': 'materializer worker lists its source directory synchronously for its code stamp',
  'packages/api/src/io/state/materializer/worker.js#walk': 'materializer worker recurses through its source tree with synchronous directory reads',
});

/**
 * Today's request-path synchronous calls, keyed by the file and function that make the call. The set may
 * only shrink: a key that no longer fires fails the check, so a fix must delete its row. Why: one synchronous git
 * inside a request froze the board API for 10 hours on 12 Nov [#6718].
 */
export const KNOWN_REQUEST_BLOCKERS = Object.freeze({
  'apps/relay/src/io/retention.js#backupFiles': 'relay retention lists its backup files with a whole-directory synchronous read',
  'apps/relay/src/io/retention.js#createRelayRetention': 'relay retention lists its backup folder with a whole-directory synchronous read',
  'packages/activity/src/io/inbox.js#gitPaths': 'state read lists claim worktree files with synchronous git',
  'packages/activity/src/io/inbox.js#diffTreePaths': 'state read diffs a claim worktree tree with synchronous git',
  'packages/api/src/io/code.js#codeAt': 'code viewer request reads a blob with four synchronous git calls',
  'apps/view/src/io/serve.js#computeRowAges': 'projectState, a view port, reads each spec row age through synchronous git',
  'packages/git/src/io/main.js#bareWorktreeFinding': 'state read lists a claim worktree folder with a synchronous directory read',
  'packages/git/src/io/main.js#readMainCheckout': 'merge-only submit reads the main checkout with synchronous git',
  'packages/git/src/io/main.js#gitCall': 'merge-only submit runs git through a synchronous helper',
  'packages/git/src/io/main.js#worktreeStatus': 'state read asks git for each claim worktree status',
  'packages/git/src/io/main.js#git': 'gate-receipt submit finds an item folder through a synchronous git helper',
  'packages/git/src/io/main.js#rawGit': 'code viewer request resolves a commit through a synchronous git helper',
  'packages/git/src/io/main.js#prefetchedShow': 'code viewer request reads a blob through a synchronous git helper',
  'packages/items/src/io/patch/compose.js#git': 'gate-receipt submit composes item patches through a synchronous git helper',
  'packages/items/src/io/patch/compose.js#mergeFromOrigin': 'gate-receipt submit merges main with synchronous git',
  'packages/items/src/io/patch/compose.js#composeItemPatches': 'gate-receipt submit composes patches with synchronous git',
  'packages/items/src/io/patch/submit.js#git': 'gate-receipt submit seals the item patch through a synchronous git helper',
  'packages/keys/src/io/relay.js#keychain': 'relay move reads the OS keychain through a synchronous child process',
  'packages/keys/src/io/relay.js#removeKeychainValue': 'relay forget removes a keychain value through a synchronous child process',
  'packages/keys/src/io/relay.js#readBoardKey': 'relay move reads the board key through a synchronous child process',
  'packages/keys/src/io/relay.js#forgetBoardKey': 'relay forget deletes the board key through a synchronous child process',
  'packages/keys/src/io/relay.js#scrubLegacyPersonSessions': 'relay move lists legacy person sessions with a synchronous directory read',
  'packages/landing/src/io/main/red/receipt.js#treeOf': 'mainReceipts resolves the main tree with synchronous git on every submit-time comparison',
  'packages/landing/src/io/main/red/receipt.js#unchangedDescendants': 'one synchronous git log per cached main candidate file',
  'packages/link/src/io/relay/lock.js#locked': 'relay lock check lists the lock folder with a synchronous directory read',
  'packages/link/src/io/relay/machine.js#readRelayMachine': 'relay machine read lists its folder with a synchronous directory read',
  'packages/link/src/io/relay/machine.js#updateRelayMachine': 'relay machine update lists its folder with a synchronous directory read',
  'packages/merge/src/io/only/source.js#readGit': 'merge-only submit captures its source with synchronous git',
  'packages/sandbox/src/io/trusted/policy/committed.js#policyGit': 'mainReceipts reads the main committed policy with synchronous git',
  'packages/spec/src/io/signature.js#runTool': 'spec approval evidence runs a signing tool in a synchronous child process',
  'packages/store/src/io/board/busy.js#beginImmediateQueued': 'a queued board write parks the thread on Atomics.wait between retries',
  'packages/store/src/io/board/submit.js#recordedBaseRows': 'gate-receipt submit lists the recorded base rows with a whole-directory synchronous read',
  'packages/store/src/io/board/write/lock.js#boardWriteHolderText': 'busy-board error text lists lock holders with a synchronous directory read',
  'packages/store/src/io/board/write/lock.js#identities': 'busy-board error text lists lock holders through a synchronous process lookup',
  'packages/verify/src/io/verdict/freshness.js#readGit': 'verdict freshness reads git synchronously while building relay state',
  'packages/verify/src/io/verdict/freshness.js#pathPatchId': 'verdict freshness computes patch ids with synchronous git',
  'packages/verify/src/io/verdict/freshness.js#composesUnchanged': 'verdict freshness compares composes with synchronous git',
  'packages/verify/src/io/verdict/freshness.js#verdictProjector': 'verdict projection asks git for ancestry synchronously',
  'packages/verify/src/io/verdict/freshness.js#ancestryStatus': 'verdict ancestry check runs synchronous git',
  ...EXTRA_REQUEST_BLOCKERS,
});

const BASE_REQUEST_BLOCKERS = Object.freeze(Object.fromEntries(
  Object.entries(KNOWN_REQUEST_BLOCKERS).filter(([owner]) => !(owner in EXTRA_REQUEST_BLOCKERS)),
));

const REQUEST_FILE = 'packages/gate/src/io/board/request.js';
const KNOWN_ROW = /^\s*'([\w./-]+\.js#[\w$]+)':\s*(?:'(.*)'|"(.*)"),?\s*$/gmu;

/** Read one blocker list from the candidate source without executing candidate tooling. */
function readBlockerList(source, name) {
  const start = source.indexOf(name + ' = Object.freeze({');
  if (start < 0) return null;
  const body = source.slice(start, source.indexOf('\n});', start));
  return Object.fromEntries([...body.matchAll(KNOWN_ROW)].map(row => [row[1], row[2] ?? row[3]]));
}

/**
 * Read the candidate tree's known blockers so it can remove a blocker together with its row [#7340].
 * @param {{file:string,source:string}[]} sources Runtime source inventory of the candidate tree.
 * @param {{includeExtra?:boolean}} [options] Include the known blockers for the extra roots.
 * @returns {Record<string,string>} Owner to why.
 */
export function candidateKnownBlockers(sources, { includeExtra = false } = {}) {
  const source = sources.find(row => row.file === REQUEST_FILE)?.source ?? '';
  const base = readBlockerList(source, 'KNOWN_REQUEST_BLOCKERS') ?? BASE_REQUEST_BLOCKERS;
  if (!includeExtra) return base;
  return { ...base, ...(readBlockerList(source, 'EXTRA_REQUEST_BLOCKERS') ?? {}) };
}

/**
 * Report blocking child-process calls a board API request can reach, and the known-violation rows that went stale.
 * Reach follows resolved calls between repository functions (named imports, namespaces, re-exports); a callback passed
 * in at run time, such as the CLI's `runCommand`, is not followed.
 * @param {{file:string,source:string}[]} sources Runtime source inventory.
 * @param {{known?:Record<string,string>,extraRoots?:string[]}} [options] The listed known violations, each with its one-line why; `extraRoots` names further walk roots (default none).
 * @returns {{file:string,line:number,call:string,owner:string,chain:string[],stale?:boolean}[]}
 */
export function apiRequestIoProblems(sources, { known = BASE_REQUEST_BLOCKERS, extraRoots = [] } = {}) {
  const { modules, targets } = callGraph(sources, { barrels: true });
  const seen = new Set(), found = new Map();
  /** Walk one function's calls; the first path to a function is the chain reported for it. */
  function walk(file, name, chain) {
    const key = file + '#' + name;
    if (seen.has(key)) return;
    seen.add(key);
    const model = modules.get(file), fn = model?.functions.get(name);
    if (!fn) return;
    const body = model.code.slice(fn.bodyStart, fn.end), base = model.source.slice(0, fn.bodyStart).split('\n').length;
    for (const call of calls(body)) for (const target of call.name === 'Atomics.wait' && !model.imports.has('Atomics') ? [ATOMICS_WAIT] : targets(file, call.name)) {
      const id = (target.builtin ?? target.file) + '#' + target.name;
      if (BLOCKING.test(id)) {
        const owner = key; // the call site itself, so the row never depends on which caller reached it first [#6755]
        const line = base + body.slice(0, call.at).split('\n').length - 1;
        found.set(owner + ':' + id, { file, line, call: id, owner, chain: [...chain, key] });
      } else if (target.file) walk(target.file, target.name, [...chain, key]);
    }
  }
  for (const [file, model] of modules) {
    if (API_FILE.test(file)) for (const name of model.functions.keys()) walk(file, name, []);
  }
  for (const port of [...SERVE_PORTS, ...HTTP_SERVERS]) walk(port.slice(0, port.indexOf('#')), port.slice(port.indexOf('#') + 1), []);
  const lost = [];
  for (const { file, list, what } of CALLBACK_LISTS) {
    const names = list.exec(modules.get(file)?.source ?? '')?.[1];
    if (names === undefined) { lost.push({ file, line: 1, call: `no ${what} list found`, owner: file + '#' + what, chain: [file], stale: true }); continue; }
    for (const name of names.split(',').map(part => part.trim()).filter(Boolean)) {
      for (const target of targets(file, name)) if (target.file) walk(target.file, target.name, [file + '#' + what]);
    }
  }
  walk(RUN_COMMAND.slice(0, RUN_COMMAND.indexOf('#')), RUN_COMMAND.slice(RUN_COMMAND.indexOf('#') + 1), []);
  for (const root of extraRoots) {
    const at = root.indexOf('#'), file = at < 0 ? root : root.slice(0, at);
    for (const name of at < 0 ? modules.get(file)?.functions.keys() ?? [] : [root.slice(at + 1)]) walk(file, name, []);
  }
  const rows = [...lost, ...[...found.values()].filter(row => !(row.owner in known))];
  const owners = new Set([...found.values()].map(row => row.owner));
  for (const owner of Object.keys(known)) {
    if (!owners.has(owner)) rows.push({ file: owner.slice(0, owner.indexOf('#')), line: 1, call: 'stale known violation', owner, chain: [owner], stale: true });
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.call.localeCompare(b.call));
}

/** Direct calls in lexed code: a name, its offset, and no member-of-call chains. */
function calls(code) {
  return [...code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\?\.)?\(/gu)]
    .filter(match => !/\bfunction\s*$/u.test(code.slice(Math.max(0, match.index - 20), match.index)))
    .map(match => ({ name: match[1], at: match.index }));
}
