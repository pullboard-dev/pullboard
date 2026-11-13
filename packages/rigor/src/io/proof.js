/** Commit-bound, observed proof for a noticed failure cause; uncertain execution proves no rule [D1,D3,S1]. */
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from '../../../landing/index.js';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { loadMachineSettings } from '../../../config/index.js';
import { scratchRoot } from '../../../config/index.js';
import {
  isAbsolute,
  join,
  posix,
} from 'node:path';
import {
  literalShellWords,
  resolveExecutable,
} from '../../../gate/index.js';
import {
  cleanGitEnvironment,
  resolveCommit,
  tryGit,
} from '../../../git/index.js';
import { withGateSlot } from '../../../gate/index.js';
import { gateSlotEnvironment } from '../../../resources/index.js';
import { Refused } from '../../../kernel/index.js';
import {
  historyPathMap,
  mappedCheck,
  mappedPath,
  pathAtCommit,
} from '../../../codemap/index.js';

const CHECK_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** Name what a proof lacks and the noticed commits it must use, without interpreting failure prose. */
export function unproven(why, key, receipts = []) {
  return new Refused('RIGOR_UNPROVEN', `${why}; noticed failure commits: ${receipts.join(', ') || 'none'}; a draft needs its proof: pullboard rigor draft "${key}" "<rule>" --check "<command>" --red <noticed failure commit> --green <fix commit>`);
}

/** Quote a literal command word for the derived count check; no text becomes a shell expansion. */
function quote(word) { return `'${word.replaceAll("'", "'\\''")}'`; }

/** Resolve the caller's red to an exact failure receipt of this key before running any command. */
export async function prepareCauseProof(root, cause, { check, red, green }) {
  const receipts = [...new Set(cause.items.flatMap(item => item.commits))];
  const refuse = why => { throw unproven(why, cause.key, receipts); };
  if (!check?.trim()) refuse('no --check names the command that proves it');
  if (!red || !green) refuse(`no ${!red ? '--red' : '--green'} names the commit where the check ${!red ? 'fails' : 'passes'}`);
  const commits = [red, green].map(ref => resolveCommit(root, ref));
  if (!commits[0] || !commits[1]) refuse('both proof references must resolve to commits in this repository');
  if (!receipts.includes(commits[0])) refuse(`${commits[0]} is not a noticed failure receipt for ${cause.key}`);
  const match = /^test:([^:]+)::(.+)$/u.exec(cause.key);
  let runner = null;
  if (match) {
    const [, file, title] = match;
    const pathMap = historyPathMap(root);
    if (isAbsolute(file) || posix.normalize(file) !== file || file.startsWith('../') || file.includes('\\') || /[\0*?\[\]{}]/u.test(file)) refuse('the failing test must name a repository-relative regular file');
    const words = literalShellWords(check);
    const executable = words && resolveExecutable(words[0]);
    let exactNode = false;
    try { exactNode = Boolean(executable) && realpathSync(executable) === realpathSync(process.execPath); } catch { /* No verified executable. */ }
    if (!exactNode || words[1] !== '--test') refuse(`the check for ${file}::${title} must be a literal Node test command: node --test ${quote(file)}; other runners cannot yet provide bound named-test proof`);
    const args = words.slice(2);
    let pattern = null;
    const files = [];
    let fileIndex = -1;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--test-name-pattern') {
        if (pattern !== null || index + 1 === args.length) refuse('the named-test selector is missing or repeated');
        pattern = args[++index];
      } else if (arg.startsWith('--test-name-pattern=')) {
        if (pattern !== null) refuse('the named-test selector is repeated');
        pattern = arg.slice('--test-name-pattern='.length);
      } else if (arg.startsWith('-')) refuse(`the proof does not accept the test option ${arg}; use the exact failing file and optional --test-name-pattern`);
      else { files.push(arg); fileIndex = index + 2; }
    }
    if (files.length !== 1 || mappedPath(pathMap, files[0]) !== mappedPath(pathMap, file)) refuse(`the check must execute exactly the noticed test file ${file}`);
    if (pattern !== null) {
      let selected = false;
      try { selected = new RegExp(pattern).test(title); } catch { /* Invalid selectors cannot prove execution. */ }
      if (!selected) refuse(`the check's selector excludes the noticed test ${title}`);
    }
    const filesAt = {};
    for (const commit of commits) {
      try { filesAt[commit] = pathAtCommit(root, pathMap, file, commit); }
      catch { refuse(`${file} is not an unambiguous regular committed test at ${commit}`); }
    }
    // Force the real runner's machine-readable report; the caller cannot substitute a shell echo.
    runner = { executable, command: words[0], args: ['--test', '--test-reporter=tap', ...args], file, title, fileIndex, filesAt };
  }
  return { key: cause.key, receipts, check: check.trim(), commits, runner };
}

/** Read one positively owned detached process group; an unavailable census is never empty. */
function processCensus(parseProcessCensus) {
  const read = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='], { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  const rows = read.status === 0 ? parseProcessCensus(read.stdout) : null;
  if (!rows) throw new Refused('RIGOR_UNPROVEN', 'the proof process census is unavailable; preserve its worktree and check the owned process before retrying');
  return rows;
}

/** Read live members of one detached group from a locale-stable, validated census. */
function groupMembers(pgid, parseProcessCensus) {
  return [...processCensus(parseProcessCensus).values()].filter(row => row.pgid === pgid && !row.state.startsWith('Z'));
}

/** Stop and drain only a group whose leader still matches the identity captured at spawn. */
async function drainGroup(pgid, anchor, parseProcessCensus) {
  if (!pgid || process.platform === 'win32') {
    if (pgid) throw new Refused('RIGOR_UNPROVEN', 'owned proof process-group drain is unavailable on this platform; the worktree is retained');
    return;
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const members = groupMembers(pgid, parseProcessCensus);
    if (!members.length) return;
    if (!anchor) {
      throw new Refused('RIGOR_UNPROVEN', `owned proof group ${pgid} remains without a captured leader identity; preserve the worktree and recover only after ownership is re-established`);
    }
    const current = processCensus(parseProcessCensus).get(anchor.pid);
    if (!current || current.pgid !== pgid || current.started !== anchor.started || current.processSha256 !== anchor.processSha256) {
      throw new Refused('RIGOR_UNPROVEN', `owned proof group ${pgid} remains but its captured leader identity changed; preserve the worktree and recover only after ownership is re-established`);
    }
    try { process.kill(-pgid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 2000;
    do {
      if (!groupMembers(pgid, parseProcessCensus).length) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
  }
  throw new Refused('RIGOR_UNPROVEN', 'the owned proof process group did not drain; its worktree is retained for recovery');
}

/** Run one bounded direct child (or a work scanner shell), retaining full output for proof evaluation. */
async function runOwnedCheck(tree, check, runner, timeoutMs, gateEnvironment, recoveryPath, parseProcessCensus) {
  if (process.platform === 'win32') throw new Refused('RIGOR_UNPROVEN', 'this proof runner needs POSIX process-group ownership; no proof command was started');
  const environment = { ...cleanGitEnvironment(), ...gateEnvironment };
  // Proof of a named test uses the verified Node executable without externally injected preload code.
  if (runner) delete environment.NODE_OPTIONS;
  // The Node harness marker would silently skip a nested test command.
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(runner?.executable ?? '/bin/sh', runner?.args ?? ['-c', check], {
    cwd: tree, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  let anchor = null;
  try { anchor = processCensus(parseProcessCensus).get(child.pid) ?? null; } catch { /* Without a validated identity, cleanup fails closed and retains the worktree. */ }
  let bytes = 0, failure = null, stopped = null;
  let resolveInterrupted;
  const interrupted = new Promise(resolve => { resolveInterrupted = resolve; });
  /** Stop this owned group once and wake the runner when the bounded drain settles. */
  const stop = reason => {
    failure ??= new Error(reason);
    if (!stopped) {
      stopped = drainGroup(child.pid, anchor, parseProcessCensus);
      stopped.then(() => resolveInterrupted({ stopped: true }), error => resolveInterrupted({ cleanupError: error }));
    }
  };
  /** Retain output within the proof's explicit byte bound; overflow proves nothing. */
  const retain = chunks => part => {
    bytes += part.length;
    if (bytes > OUTPUT_LIMIT) stop('proof output exceeds its bound');
    else chunks.push(part);
  };
  child.stdout.on('data', retain(stdout)); child.stderr.on('data', retain(stderr));
  let closeResolve;
  const closed = new Promise(resolve => { closeResolve = resolve; });
  child.once('error', error => { failure = error; closeResolve({ exit: null }); });
  child.once('close', (exit, signal) => closeResolve({ exit, signal }));
  const timer = setTimeout(() => stop('proof deadline expired'), timeoutMs);
  let result;
  try {
    result = await Promise.race([closed, interrupted]);
  } finally {
    clearTimeout(timer);
    try {
      // A close event may beat the interruption; still finish the drain before worktree removal.
      if (stopped) await stopped;
      else await drainGroup(child.pid, anchor, parseProcessCensus);
    } catch (error) {
      // Preserve captured output, then release only our own pipes/handle so refusal cannot hang the CLI.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      const identity = anchor ? `${anchor.pid}/${anchor.pgid}/${anchor.started}/${anchor.processSha256}` : 'unavailable';
      const refused = new Refused('RIGOR_UNPROVEN', `proof process ${child.pid ?? 'unavailable'} could not be safely drained; preserve worktree ${recoveryPath}; captured leader identity ${identity}`);
      refused.cause = error;
      throw refused;
    }
  }
  if (result.stopped) {
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    result = { exit: child.exitCode, signal: child.signalCode };
  }
  return { ...result, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut: Boolean(failure) };
}

/** Run an immutable commit's check, draining its child group before removing only this owned worktree. */
export async function runCheckAt(root, commit, check, runner = null, { timeoutMs = CHECK_TIMEOUT_MS, gateEnvironment = {}, parseProcessCensus } = {}) {
  if (typeof parseProcessCensus !== 'function') throw new Refused('RIGOR_UNPROVEN', 'supply the process census parser from the proof command owner before preparing its worktree');
  const dir = mkdtempSync(join(scratchRoot(loadMachineSettings()), 'pullboard-rigor-proof-'));
  const tree = join(dir, 'tree');
  const added = tryGit(root, ['worktree', 'add', '--detach', '--quiet', tree, commit]);
  let drained = added.status !== 0;
  try {
    if (added.status !== 0) throw unproven(`cannot check out ${commit}`, 'unknown');
    const selectedRunner = runner?.filesAt?.[commit] ? { ...runner,
      args: runner.args.map((arg, index) => index === runner.fileIndex ? runner.filesAt[commit] : arg) } : runner;
    const run = await runOwnedCheck(tree, runner ? check : mappedCheck(tree, check), selectedRunner, timeoutMs, gateEnvironment, tree, parseProcessCensus);
    drained = true;
    return { commit, ...run, problems: run.stdout.split(/\r?\n/u).filter(line => line.trim()).length };
  } catch (error) {
    if (!drained) {
      const message = `proof worktree retained for recovery: ${tree}; captured process recovery context: ${error instanceof Refused ? error.message : 'owned process state unavailable'}`;
      throw new Refused('RIGOR_UNPROVEN', message);
    }
    throw error;
  } finally {
    if (drained) {
      if (added.status === 0) {
        const removed = tryGit(root, ['worktree', 'remove', '--force', tree]);
        if (removed.status !== 0) throw new Refused('RIGOR_UNPROVEN', `the owned proof worktree at ${tree} could not be removed; clean it before retrying`);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Require complete real Node TAP accounting and one non-skipped result for the exact noticed title. */
function observedTest(run, title, expected) {
  const fields = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const summaries = [...run.stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gmu)];
  if (summaries.length !== fields.length || fields.some(key => summaries.filter(match => match[1] === key).length !== 1)) return false;
  const counts = Object.fromEntries(summaries.map(match => [match[1], Number(match[2])]));
  const records = [...run.stdout.matchAll(/^\s*(not ok|ok) \d+ - (.+)$/gmu)];
  const plans = [...run.stdout.matchAll(/^1\.\.(\d+)$/gmu)];
  const named = records.filter(match => match[2] === title);
  const skipOrTodo = records.some(match => / # (?:SKIP|TODO)(?: |$)/u.test(match[2]));
  const passed = records.filter(match => match[1] === 'ok').length;
  const failed = records.filter(match => match[1] === 'not ok').length;
  const complete = plans.length === 1 && Number(plans[0][1]) > 0
    && counts.tests === records.length && counts.pass === passed && counts.fail === failed
    && passed + failed === counts.tests && !skipOrTodo;
  return complete && named.length === 1 && named[0][1] === expected && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
}

/** Prove this key's exact noticed failure, retaining only summaries in the returned public draft result. */
export async function proveCauseCheck(root, cause, request, { agent, parseProcessCensus } = {}) {
  const prepared = await prepareCauseProof(root, cause, request);
  if (typeof parseProcessCensus !== 'function') throw new Refused('RIGOR_UNPROVEN', 'supply the process census parser from the proof command owner before acquiring its machine lease');
  return await withGateSlot(root, lease => provePreparedCheck(root, cause, prepared, gateSlotEnvironment(lease), parseProcessCensus),
    { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, browser: true, remote: false, agent, kind: 'rigor-proof' });
}

/** Run only an already validated cause proof while its real machine lease remains held. */
async function provePreparedCheck(root, cause, prepared, gateEnvironment, parseProcessCensus) {
  const refuse = why => { throw unproven(why, cause.key, prepared.receipts); };
  const runs = [];
  for (const commit of prepared.commits) runs.push(await runCheckAt(root, commit, prepared.check, prepared.runner, { gateEnvironment, parseProcessCensus }));
  const [red, green] = runs;
  if (runs.some(run => run.timedOut || run.exit === null)) refuse('the check did not complete at both commits');
  if (prepared.runner) {
    if (red.exit === 0 || green.exit !== 0 || !observedTest(red, prepared.runner.title, 'not ok') || !observedTest(green, prepared.runner.title, 'ok')) refuse(`the complete report must fail ${prepared.runner.file}::${prepared.runner.title} at red and pass it at green, without skips`);
  } else {
    const work = cause.reads !== 'product';
    if (work && (![0, 1].includes(red.exit) || ![0, 1].includes(green.exit) || red.problems < 1 || green.problems > 0)) refuse('a work check exits 0 or 1, prints problems at red and none at green');
    if (!work && (red.exit === 0 || green.exit !== 0)) refuse('the test must fail at red and pass at green');
  }
  const summary = ({ commit, exit, problems, timedOut }) => ({ commit, exit,
    problems: prepared.runner ? Number(exit !== 0) : problems, timedOut });
  // The complete original command proved the target red then green. Count just that same target in doctrine,
  // with one line on failure and none on success, independently of TAP verbosity or unrelated tests in its file.
  const exact = prepared.runner?.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const countCheck = prepared.runner
    ? `unset NODE_TEST_CONTEXT; ${[prepared.runner.command, '--test', '--test-reporter=tap', '--test-name-pattern', '^' + exact + '$', prepared.runner.file].map(quote).join(' ')} >/dev/null 2>&1; status=$?; if [ "$status" -ne 0 ]; then printf '%s\\n' 'The noticed test failed.'; fi; exit "$status"`
    : prepared.check;
  return { check: prepared.check, red: summary(red), green: summary(green), countCheck };
}
