/**
 * The clause runner: it runs each bar clause of a contribution record against the base and head commits and reports
 * proven, failed, refused or unverified per clause [CR3].
 *
 * Everything runs in throwaway copies inside one scratch folder the caller owns (the sandbox's folder): base and head
 * come out of git with `git archive`, the repository itself is only read, and nothing is written outside the scratch
 * folder. Tests and commands run on the pinned Node with no shell and a scrubbed environment. The verdict comes from the
 * gate's own test reporter, not the test's output. Every process runs asynchronously, so a lease timer can still fire.
 */
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { sep } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { CLAUSE_LIMIT_NOTE } from '../logic/contribution-clauses.js';
import { DEFAULT_TEST_DIRS } from '../logic/contribution-clauses.js';
import { allowlistedCommand } from '../logic/contribution-clauses.js';
import { exactNamePattern } from '../logic/contribution-clauses.js';
import { inTestDirectory } from '../logic/contribution-clauses.js';
import { judgeCommand } from '../logic/contribution-clauses.js';
import { judgeKeptTest } from '../logic/contribution-clauses.js';
import { judgeMeasurement } from '../logic/contribution-clauses.js';
import { judgeTest } from '../logic/contribution-clauses.js';
import { measurementThreshold } from '../logic/contribution-clauses.js';
import { noneReason } from '../logic/contribution-clauses.js';
import { pairClauses } from '../logic/contribution-clauses.js';
import { parseTestCheck } from '../logic/contribution-clauses.js';
import { testOutcome } from '../logic/contribution-clauses.js';

/** How long one test or command may run before it counts as timed out. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** The most output one run may print before the rest is dropped. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The gate's own node:test reporter: it writes one JSON line per pass, fail and plan event, with the failure's kind.
 * It lives in the scratch folder, outside both copies, so the PR cannot replace it on disk.
 */
const REPORTER_SOURCE = `export default async function* clauseReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail' && event.type !== 'test:plan') continue;
    const data = event.data ?? {};
    const error = data.details?.error;
    yield JSON.stringify({ type: event.type, name: data.name, nesting: data.nesting, skip: Boolean(data.skip), todo: Boolean(data.todo),
      failureType: error?.failureType, causeCode: error?.cause?.code, count: data.count }) + '\\n';
  }
}
`;

/** Run one process without a shell and collect its exit, capped in time and output. */
function launch(file, args, { cwd, env, input, timeoutMs, binary = false }) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let size = 0, timedOut = false, failed = null;
    const keep = into => chunk => { if (size < MAX_OUTPUT_BYTES) { into.push(chunk); size += chunk.length; } };
    child.stdout.on('data', keep(out));
    child.stderr.on('data', keep(err));
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.on('error', error => { failed = error; });
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(out);
      resolve({ status: failed ? null : status, signal, timedOut, error: failed, stdout: binary ? stdout : stdout.toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (input) child.stdin.end(input);
  });
}

/** Read a git repository without the caller's GIT_ variables steering it, refusing when git says no. */
async function git(repo, args, { binary = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = await launch('git', ['-C', repo, ...args], { env, binary });
  if (result.status !== 0) throw new Refused('CLAUSE_GIT', `git ${args[0]} failed in ${repo}: ${result.stderr.trim().slice(0, 200)}`, 'pass a repository that holds both the base and the head commit');
  return result.stdout;
}

/** Write one commit's tree into a fresh folder with git archive, so the repository's own checkout is never touched. */
async function extract(repo, commit, into) {
  mkdirSync(into, { recursive: true });
  const archive = await git(repo, ['archive', '--format=tar', commit], { binary: true });
  const result = await launch('tar', ['-x', '-f', '-', '-C', into], { input: archive });
  if (result.status !== 0) throw new Error(`tar could not unpack ${commit}: ${result.stderr.trim().slice(0, 200)}`);
}

/**
 * Refuse a path whose real location, symlinks resolved, leaves the copy it sits in [CR3].
 *
 * @param {string} root - The copy's root.
 * @param {string} path - A repository path, already checked by its words.
 * @param {string} where - What named the path.
 */
function assertInside(root, path, where) {
  const realRoot = realpathSync(root);
  const full = join(root, path);
  let real;
  try { real = realpathSync(full); } catch { real = null; } // A missing path is checked below as a possible dangling link.
  if (real === null) {
    let link = false;
    try { link = lstatSync(full).isSymbolicLink(); } catch { link = false; } // Nothing there at all: it cannot escape.
    if (!link) return;
    throw new Refused('CLAUSE_PATH', `${where}: "${path}" is a symlink that does not resolve inside the repository`, 'replace the symlink with the file itself');
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Refused('CLAUSE_PATH', `${where}: "${path}" resolves outside the repository`, 'replace the symlink with the file itself, inside the repository');
}

/**
 * Lay another tree's versions of the given paths over a copy: written where the source has them, removed where it does
 * not. Each overlaid path is checked so a symlink cannot reach outside the copy.
 */
function overlay(from, to, paths) {
  for (const path of paths) {
    const target = join(to, path);
    rmSync(target, { force: true, recursive: true });
    let present = false;
    try { lstatSync(join(from, path)); present = true; } catch { present = false; } // Absent in the source: stays removed.
    if (!present) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(from, path), target, { verbatimSymlinks: true });
    assertInside(to, path, 'test-directory change');
  }
}

/**
 * Check the pinned Node: the binary must report the pinned version, so a clause's verdict never depends on whichever
 * node a PATH lookup finds [CR3].
 *
 * @param {{ path?: string, version?: string }} [pin]
 * @returns {Promise<{ path: string, version: string }>}
 */
export async function pinnedNode(pin = {}) {
  const path = pin.path ?? process.execPath;
  const version = pin.version ?? process.version;
  const result = await launch(path, ['--version'], { env: {}, timeoutMs: 30_000 });
  const reported = result.status === 0 ? String(result.stdout).trim() : '';
  if (reported !== version) throw new Refused('CLAUSE_NODE_PIN', `the clause runner pins Node ${version}, but ${path} reports "${reported || 'nothing'}"`, `run the gate with Node ${version}, or pass that binary as the pinned node`);
  return { path, version };
}

/** Refuse a scratch folder the runner may not fill: it must exist, be empty, and sit outside the repository. */
function checkScratch(scratch, repo) {
  const next = 'pass an empty folder outside the repository, such as a fresh sandbox folder';
  if (typeof scratch !== 'string' || !isAbsolute(scratch) || !existsSync(scratch)) throw new Refused('CLAUSE_SCRATCH', 'the scratch folder must be an existing absolute path', next);
  if (readdirSync(scratch).length) throw new Refused('CLAUSE_SCRATCH', `the scratch folder ${scratch} is not empty`, next);
  const real = realpathSync(scratch), realRepo = realpathSync(repo);
  if (real === realRepo || real.startsWith(realRepo + sep)) throw new Refused('CLAUSE_SCRATCH', `the scratch folder ${scratch} is inside the repository`, next);
  return real;
}

/** Run the one named test in a copy with the gate's reporter and read back what it did. */
async function runNamedTest(root, file, name, ctx) {
  assertInside(root, file, 'test file');
  const out = join(ctx.scratch, `report-${ctx.runs++}.jsonl`);
  const exit = await launch(ctx.node.path, [`--test-reporter=${ctx.reporter}`, `--test-reporter-destination=${out}`, `--test-name-pattern=${exactNamePattern(name)}`, file], { cwd: root, env: ctx.env, timeoutMs: ctx.timeoutMs });
  const events = existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; } // A torn last line from a killed run says nothing.
  }) : [];
  return testOutcome(events, name, exit);
}

/** Run an allowlisted command in a copy; the pinned node stands in for a leading `node`. */
function runCommand(words, root, ctx) {
  for (const word of words.slice(1)) {
    // A symlinked script is followed by node, so each path argument is resolved, and so is an option value such as --require=./x.cjs.
    const path = word.startsWith('-') ? (word.includes('=') ? word.slice(word.indexOf('=') + 1) : '') : word;
    if (path && (!word.startsWith('-') || /[/\\]/u.test(path))) assertInside(root, path, 'command path');
  }
  const argv = words[0] === 'node' ? [ctx.node.path, ...words.slice(1)] : words;
  return launch(argv[0], argv.slice(1), { cwd: root, env: ctx.env, timeoutMs: ctx.timeoutMs });
}

/** Lazily build the copies a clause needs, once per run: base, head, base plus the PR's tests, head with base's tests. */
function copies(ctx) {
  const made = new Map();
  const testPaths = () => ctx.changed.filter(path => inTestDirectory(path, ctx.testDirs));
  const build = {
    base: async () => { const dir = join(ctx.scratch, 'base'); await extract(ctx.repo, ctx.base, dir); return dir; },
    head: async () => { const dir = join(ctx.scratch, 'head'); await extract(ctx.repo, ctx.head, dir); return dir; },
    baseWithTests: async () => {
      const dir = join(ctx.scratch, 'base-with-tests');
      cpSync(await get('base'), dir, { recursive: true, verbatimSymlinks: true });
      overlay(await get('head'), dir, testPaths());
      return dir;
    },
    headWithBaseTests: async () => {
      const dir = join(ctx.scratch, 'head-with-base-tests');
      cpSync(await get('head'), dir, { recursive: true, verbatimSymlinks: true });
      overlay(await get('base'), dir, testPaths());
      return dir;
    },
  };
  /** One copy, built the first time a clause asks; a copy that was refused is refused again for every clause. */
  function get(name) {
    if (!made.has(name)) made.set(name, build[name]());
    return made.get(name);
  }
  return get;
}

/** Run one clause by its kind and return its verdict; a Refused from any step becomes the clause's refusal. */
async function runClause(pair, ctx, copy) {
  const { n, clause, kind, check } = pair;
  const result = { n, clause, kind, check };
  try {
    const reason = noneReason(check);
    if (reason !== null) return { ...result, verdict: 'unverified', reason: `not run here: ${reason}; a maintainer decides` };
    if (kind === 'test') {
      const { file, name } = parseTestCheck(check);
      const onBase = await runNamedTest(await copy('baseWithTests'), file, name, ctx);
      const onHead = onBase === 'assertion' ? await runNamedTest(await copy('head'), file, name, ctx) : null;
      return { ...result, ...judgeTest(onBase, onHead, name), onBase, onHead };
    }
    if (kind === 'test, kept') {
      const { file, name } = parseTestCheck(check);
      const onHead = await runNamedTest(await copy('headWithBaseTests'), file, name, ctx);
      const edited = ctx.changed.includes(file);
      return { ...result, ...judgeKeptTest(onHead, name), onHead, edited, ...(edited ? { review: 'the PR edits this kept test; it goes to review' } : {}) };
    }
    if (kind === 'command') {
      const words = allowlistedCommand(check, ctx.allowlist);
      const onBase = await runCommand(words, await copy('base'), ctx);
      const onHead = await runCommand(words, await copy('head'), ctx);
      return { ...result, ...judgeCommand(onBase.status, onHead.status), baseStatus: onBase.status, headStatus: onHead.status };
    }
    if (kind === 'measurement') {
      const threshold = measurementThreshold(clause);
      const words = allowlistedCommand(check, ctx.allowlist);
      const onHead = await runCommand(words, await copy('head'), ctx);
      if (onHead.status !== 0) return { ...result, verdict: 'failed', reason: `the measurement exits ${onHead.status} on head` };
      const judged = judgeMeasurement(onHead.stdout, threshold);
      return { ...result, verdict: judged.ok ? 'proven' : 'failed', reason: judged.reason, value: judged.value };
    }
    throw new Refused('CLAUSE_KIND', `clause ${n} has kind "${kind ?? 'none'}"`, 'end the clause with [test], [test, kept], [command] or [measurement], or give the check as "none: <reason>"');
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return { ...result, verdict: 'refused', reason: error.message, refusal: { code: error.code, message: error.message, next: error.next } };
  }
}

/**
 * Run every bar clause of a record against base and head and report each verdict [CR3].
 * Why: the gate, `pullboard contribute check` and the GitHub Action call this one function, so a clause proves the same
 * thing wherever it runs.
 *
 * @param {object} input
 * @param {string} input.repo - A git repository holding both commits; it is only read.
 * @param {string} input.base - The base commit.
 * @param {string} input.head - The head commit.
 * @param {string[]} input.bar - The record's bar entries, `n: clause [kind]`.
 * @param {string[]} input.check - The record's check entries, `n: command`.
 * @param {string} input.scratch - An empty folder outside the repository that the caller owns and removes; every copy,
 *   report and run's HOME lives here and nothing is written anywhere else.
 * @param {string[]} [input.allowlist] - Allowed command prefixes, as data.
 * @param {{ path?: string, version?: string }} [input.node] - The pinned Node; defaults to the gate's own.
 * @param {string[]} [input.testDirs] - Folder names that hold tests, helpers and fixtures.
 * @param {number} [input.timeoutMs] - The cap on each test or command.
 * @returns {Promise<{ node: string, base: string, head: string, clauses: object[], note: string }>}
 */
export async function runContributionClauses({ repo, base, head, bar, check, scratch, allowlist = [], node, testDirs = DEFAULT_TEST_DIRS, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const pinned = await pinnedNode(node);
  const folder = checkScratch(scratch, repo);
  const baseSha = String(await git(repo, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  const headSha = String(await git(repo, ['rev-parse', '--verify', `${head}^{commit}`])).trim();
  const changed = String(await git(repo, ['diff', '--name-only', '--no-renames', '-z', baseSha, headSha])).split('\0').filter(Boolean);
  const pairs = pairClauses(bar, check);
  mkdirSync(join(folder, 'home'));
  mkdirSync(join(folder, 'tmp'));
  const reporter = join(folder, 'clause-reporter.mjs');
  writeFileSync(reporter, REPORTER_SOURCE);
  const env = { PATH: [dirname(pinned.path), '/usr/bin', '/bin'].join(delimiter), HOME: join(folder, 'home'), TMPDIR: join(folder, 'tmp'), LANG: 'C', NO_COLOR: '1' };
  const ctx = { repo, base: baseSha, head: headSha, allowlist, node: pinned, testDirs, timeoutMs, scratch: folder, reporter, runs: 0, env, changed };
  const copy = copies(ctx);
  const clauses = [];
  for (const pair of pairs) clauses.push(await runClause(pair, ctx, copy));
  return { node: pinned.version, base: baseSha, head: headSha, clauses, note: CLAUSE_LIMIT_NOTE };
}
