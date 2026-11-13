/** Find synchronous child processes reachable from board API request handlers, without executing any module [C7]. */
import { callGraph } from './write.js';

/** Where a request enters: every function of the API's own modules, plus the ports `pullboard serve` hands the API. */
const API_FILE = /^packages\/api\/src\/io\/[^/]+\.js$/u;
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
// Calls that block the event loop until a child exits; `gitSpawnSync` is git's own wrapper over spawnSync.
const BLOCKING = /^(?:(?:node:)?child_process#(?:spawnSync|execSync|execFileSync)|.*#(?:gitSpawnSync|gitExecFileSync))$/u;

/**
 * Today's request-path synchronous calls, keyed by the first function outside packages/git that makes them. The set may
 * only shrink: a key that no longer fires fails the check, so a fix must delete its row. Why: one synchronous git
 * inside a request froze the board API for 10 hours on 12 Nov [#6718].
 */
export const KNOWN_REQUEST_BLOCKERS = Object.freeze({
  'packages/activity/src/io/inbox.js#gitPaths': 'state read lists claim worktree files with synchronous git',
  'packages/activity/src/io/inbox.js#diffTreePaths': 'state read diffs a claim worktree tree with synchronous git',
  'packages/activity/src/io/inbox.js#activityWorkingFiles': 'state read asks git for each claim worktree status',
  'packages/api/src/io/code.js#codeAt': 'code viewer request reads a blob with four synchronous git calls',
  'packages/api/src/io/main.js#boardStateRevision': 'state revision request reads the trunk ref with synchronous git',
  'apps/view/src/io/serve.js#computeRowAges': 'projectState, a view port, reads each spec row age through synchronous git',
  'packages/api/src/io/event-signals.js#watchEventSignals': 'event watcher setup resolves the repository with synchronous git',
  'packages/items/src/io/claim.js#itemFolderIdentity': 'gate-receipt submit finds an item folder with synchronous git',
  'packages/items/src/io/patch/compose.js#git': 'gate-receipt submit composes item patches through a synchronous git helper',
  'packages/items/src/io/patch/compose.js#mergeFromOrigin': 'gate-receipt submit merges main with synchronous git',
  'packages/items/src/io/patch/compose.js#composeItemPatches': 'gate-receipt submit composes patches with synchronous git',
  'packages/items/src/io/patch/submit.js#git': 'gate-receipt submit seals the item patch through a synchronous git helper',
  'packages/keys/src/io/relay.js#keychain': 'relay move reads the OS keychain through a synchronous child process',
  'packages/keys/src/io/relay.js#removeKeychainValue': 'relay forget removes a keychain value through a synchronous child process',
  'packages/keys/src/io/relay.js#readBoardKey': 'relay move reads the board key through a synchronous child process',
  'packages/keys/src/io/relay.js#forgetBoardKey': 'relay forget deletes the board key through a synchronous child process',
  'packages/landing/src/io/main/red/receipt.js#treeOf': 'mainReceipts resolves the main tree with synchronous git on every submit-time comparison',
  'packages/landing/src/io/main/red/receipt.js#unchangedDescendants': 'one synchronous git log per cached main candidate file',
  'packages/merge/src/io/only/source.js#deriveMergeOnly': 'merge-only submit reads the main checkout with synchronous git',
  'packages/merge/src/io/only/source.js#readGit': 'merge-only submit captures its source with synchronous git',
  'packages/sandbox/src/io/trusted/policy/committed.js#policyGit': 'mainReceipts reads the main committed policy with synchronous git',
  'packages/spec/src/io/signature.js#runTool': 'spec approval evidence runs a signing tool in a synchronous child process',
  'packages/store/src/io/board/write/lock.js#identities': 'busy-board error text lists lock holders through a synchronous process lookup',
  'packages/verify/src/io/verdict/freshness.js#readGit': 'verdict freshness reads git synchronously while building relay state',
  'packages/verify/src/io/verdict/freshness.js#pathPatchId': 'verdict freshness computes patch ids with synchronous git',
  'packages/verify/src/io/verdict/freshness.js#composesUnchanged': 'verdict freshness compares composes with synchronous git',
  'packages/verify/src/io/verdict/freshness.js#verdictProjector': 'verdict projection asks git for ancestry synchronously',
  'packages/verify/src/io/verdict/freshness.js#ancestryStatus': 'verdict ancestry check runs synchronous git',
});

/**
 * Report blocking child-process calls a board API request can reach, and the known-violation rows that went stale.
 * Reach follows resolved calls between repository functions (named imports, namespaces, re-exports); a callback passed
 * in at run time, such as the CLI's `runCommand`, is not followed.
 * @param {{file:string,source:string}[]} sources Runtime source inventory.
 * @param {{known?:Record<string,string>}} [options] The listed known violations, each with its one-line why.
 * @returns {{file:string,line:number,call:string,owner:string,chain:string[],stale?:boolean}[]}
 */
export function apiRequestIoProblems(sources, { known = KNOWN_REQUEST_BLOCKERS } = {}) {
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
    for (const call of calls(body)) for (const target of targets(file, call.name)) {
      const id = (target.builtin ?? target.file) + '#' + target.name;
      if (BLOCKING.test(id)) {
        const owner = [...chain, key].filter(row => !row.startsWith('packages/git/')).at(-1) ?? key;
        const line = base + body.slice(0, call.at).split('\n').length - 1;
        found.set(owner + ':' + id, { file, line, call: id, owner, chain: [...chain, key] });
      } else if (target.file) walk(target.file, target.name, [...chain, key]);
    }
  }
  for (const [file, model] of modules) {
    if (API_FILE.test(file)) for (const name of model.functions.keys()) walk(file, name, []);
  }
  for (const port of SERVE_PORTS) walk(port.slice(0, port.indexOf('#')), port.slice(port.indexOf('#') + 1), []);
  const lost = [];
  for (const { file, list, what } of CALLBACK_LISTS) {
    const names = list.exec(modules.get(file)?.source ?? '')?.[1];
    if (names === undefined) { lost.push({ file, line: 1, call: `no ${what} list found`, owner: file + '#' + what, chain: [file], stale: true }); continue; }
    for (const name of names.split(',').map(part => part.trim()).filter(Boolean)) {
      for (const target of targets(file, name)) if (target.file) walk(target.file, target.name, [file + '#' + what]);
    }
  }
  walk(RUN_COMMAND.slice(0, RUN_COMMAND.indexOf('#')), RUN_COMMAND.slice(RUN_COMMAND.indexOf('#') + 1), []);
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
