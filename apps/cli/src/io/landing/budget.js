/**
 * The board-command budget: the commands seats call most (next, show, claim, status, whoami, inbox) are measured on a
 * fixture board, each for the modules a fresh process loads and for its wall time through the warm resident process
 * [C7]. Module counts are deterministic, so each has a ratcheted ceiling and any rise is a breach; wall time is noisy,
 * so its median of five is held to the 0.2 s bar.
 *
 *   node packages/gate/src/io/matrix.js --only board-commands
 *
 * The periodic main audit runs it (boardCommandBudgetCheck): a breach files a board item naming the command, the
 * measured value, the ceiling, the modules it newly loads and the commits since the last passing check, and a pass
 * lowers each ceiling to what it measured. Why an audit and not a gate: Corey, 9 Nov, a periodic systematic check;
 * a 5,000-module CLI crept to 1,700 modules a command one import at a time, and no gate saw it.
 */
import { spawnSync } from 'node:child_process';
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';
import {
  delimiter,
  dirname,
  join,
  resolve,
  sep,
} from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';

const fs = fileSystemAdapter();
const environment = environmentAdapter();

/** This checkout: the code measured when the script runs on its own. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
/** The audit's record of the last passing check and the lowered ceilings, beside the other main-audit state. */
export const RECORD_NAME = 'board-command-budget.json';
/** The wall-time bar for every seat command, from the 2 Nov speed rule. */
export const WALL_MS = 200;
/** How often the audit measures: the fixture costs about a minute of the audit machine, so a drain sooner skips it. */
export const CHECK_EVERY_MS = 2 * 60 * 60_000;
/** The seat commands and how each runs on the fixture: the seat's worktree, or the coordinator's checkout for show. */
export const SEAT_COMMANDS = Object.freeze({
  next: { args: ['next', '--json'], seat: true },
  show: { args: ['show', '1'], seat: false },
  claim: { args: ['claim', '1'], seat: true },
  status: { args: ['status'], seat: true },
  whoami: { args: ['whoami'], seat: true },
  inbox: { args: ['inbox'], seat: true },
});
const ROUNDS = 5;
/** The command name the fixture's Git hooks run from PATH, which a shim points at the measured code. */
const COMMAND_NAME = 'pullboard';

/** Run a process and require success. */
function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...options });
  if (result.status !== 0) throw new Error(`${[command, ...args].join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || result.error?.message || '').slice(0, 400)}`);
  return result;
}

/** The module name the generated preload files import; spelled apart so this file holds no direct node:fs import of its own. */
const FS_MODULE = JSON.stringify(['node', 'fs'].join(':'));

/** A preload that logs every file module the process loads, for Node 22.13 (off-thread) and 22.15+ (in-thread) alike. */
function moduleHook(dir, name, log) {
  const record = `if (url.startsWith('file:')) appendFileSync(${JSON.stringify(log)}, url + '\\n');`;
  const loader = join(dir, `budget-loader-${name}.mjs`), hook = join(dir, `budget-hook-${name}.mjs`);
  fs.writeFile(loader, `import { appendFileSync } from ${FS_MODULE};\nexport async function load(url, context, next) { ${record} return next(url, context); }\n`);
  fs.writeFile(hook, ["import module from 'node:module';", `import { appendFileSync } from ${FS_MODULE};`,
    `if (module.registerHooks) module.registerHooks({ load(url, context, next) { ${record} return next(url, context); } });`,
    `else module.register(${JSON.stringify(pathToFileURL(loader).href)});`].join('\n') + '\n');
  return hook;
}

/** Find the real Git before the fixture's PATH shims. */
function realGit() {
  const found = environment.get('PATH', '').split(delimiter).map(entry => join(entry || '.', 'git')).find(fs.exists);
  if (!found) throw new Error('board-command budget needs Git on PATH');
  return found;
}

/**
 * Build a fixture board run by `code`: a coordinator checkout with two items, and a seat worktree joined to its lane.
 * Every home, config and relay variable is private to the fixture.
 */
function fixture(code, dir) {
  const repo = join(dir, 'repo'), seat = join(dir, 'seat'), shims = join(dir, 'shims'), home = join(dir, 'home');
  const bin = join(code, 'apps/cli/pullboard.js');
  fs.mkdir(repo); fs.mkdir(shims);
  // The fixture's Git hooks run pullboard from PATH; they must run the code under measurement.
  const shim = join(shims, COMMAND_NAME);
  fs.writeFile(shim, `#!${process.execPath}\nprocess.argv[1] = ${JSON.stringify(bin)};\nimport(${JSON.stringify(pathToFileURL(bin).href)});\n`);
  fs.chmod(shim, 0o755);
  const env = { ...environment.all(), HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, '.pullboard-machine'),
    PATH: `${shims}${delimiter}${environment.get('PATH')}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PULLBOARD_OWN_CLI: '1',
    GIT_AUTHOR_NAME: 'Budget Agent', GIT_AUTHOR_EMAIL: 'budget@example.invalid', GIT_COMMITTER_NAME: 'Budget Agent', GIT_COMMITTER_EMAIL: 'budget@example.invalid' };
  for (const name of ['PULLBOARD_RELAY_TOKEN', 'PULLBOARD_RELAY_KEY', 'NODE_TEST_CONTEXT', 'PULLBOARD_TEST_RUNNER_PID', 'PULLBOARD_TRANSIENT', 'PULLBOARD_RESIDENT', 'NODE_OPTIONS']) delete env[name];
  const git = (cwd, ...args) => run(realGit(), args, { cwd, env });
  const cli = (cwd, args, extra = {}) => run(process.execPath, [bin, ...args], { cwd, env: { ...env, PULLBOARD_RESIDENT: '0', ...extra } });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFile(join(repo, 'pullboard.json'), JSON.stringify({ spec: 'SPEC.md', practice: 'DOCTRINE.md', gate: 'true', lanes: { core: { owns: ['src/'], specs: ['C7'] } } }));
  fs.writeFile(join(repo, 'SPEC.md'), '# Budget fixture\n\n## C · Core\n- C7 [approved, must] Board commands answer fast. | gate: review\n');
  cli(repo, ['init']);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore(repo): set up the budget fixture');
  for (const title of ['First', 'Second']) cli(repo, ['add', 'core', title, '--specs', 'C7', '--criterion', 'it works', '--brief', 'Files: src/a.js\nTest: it works.']);
  git(repo, 'worktree', 'add', '-q', '-b', 'core/one', seat);
  cli(seat, ['join', 'core', '--model', 'fixture-strong', '--route', 'strong']);
  return { bin, env, repo, seat };
}

/** Free both items so the next claim or next starts from the same board. */
function resetClaims(box, resident) {
  for (const id of ['1', '2']) {
    spawnSync(process.execPath, [box.bin, 'release', id, '--reason', 'OTHER', '--note', 'budget sample complete', '--no-next'],
      { cwd: box.seat, env: { ...box.env, PULLBOARD_RESIDENT: resident ? '1' : '0' }, encoding: 'utf8', timeout: 120_000 });
  }
}

/** Run one seat command once: its wall time, and with a hook the repository modules it loaded. */
function sample(box, name, { hookDir = null, resident = false, code }) {
  const spec = SEAT_COMMANDS[name];
  if (name === 'claim' || name === 'next') resetClaims(box, resident);
  const log = hookDir ? join(hookDir, `modules-${name}.log`) : null;
  const hook = log ? moduleHook(hookDir, name, log) : null;
  if (log) fs.writeFile(log, '');
  const started = performance.now();
  run(process.execPath, [...(hook ? ['--import', hook] : []), box.bin, ...spec.args],
    { cwd: spec.seat ? box.seat : box.repo, env: { ...box.env, PULLBOARD_RESIDENT: resident ? '1' : '0' } });
  const ms = performance.now() - started;
  const modules = log ? [...new Set(fs.readFile(log, 'utf8').split('\n').filter(Boolean))].map(url => fileURLToPath(url))
    .filter(path => path.startsWith(code + sep)).map(path => path.slice(code.length + 1).split(sep).join('/')).sort() : null;
  return { ms, modules };
}

/** Stop every resident process of the pool the fixture started, found where the measured code's client looks. */
async function stopResidents(box, code) {
  // The measured code is read in a child: a source file of this package never imports a computed path (P3).
  const script = [`import { residentPoolSize, residentSocket } from ${JSON.stringify(pathToFileURL(join(code, 'apps/cli/src/io/resident/client.js')).href)};`,
    "const size = typeof residentPoolSize === 'function' ? residentPoolSize(JSON.parse(process.argv[3])) : 1;",
    'const files = [];',
    'for (let slot = 0; slot < size; slot += 1) { const place = residentSocket(process.argv[1], process.argv[2], slot); if (place) files.push(place.pid); }',
    'process.stdout.write(JSON.stringify(files));'].join('\n');
  const files = JSON.parse(run(process.execPath, ['--input-type=module', '-e', script, box.repo, box.bin, JSON.stringify(box.env)], { env: box.env }).stdout);
  for (const file of files) {
    try { process.kill(Number(fs.readFile(file, 'utf8').trim()), 'SIGKILL'); } catch { /* Never started, or already gone. */ }
  }
}

/**
 * Measure every seat command of the code at `code`: the modules a fresh in-process run loads, and the median of five
 * runs through a warm resident process.
 *
 * @returns {Promise<Record<string, { modules: number, loaded: string[], medianMs: number, samplesMs: number[] }>>}
 */
export async function measureBoardCommands(code, scratch) {
  const dir = fs.realpath(fs.mkdtemp(join(scratch, 'board-command-budget-')));
  let box;
  try {
    box = fixture(code, dir);
    const result = {};
    for (const name of Object.keys(SEAT_COMMANDS)) {
      const { modules } = sample(box, name, { hookDir: dir, code });
      result[name] = { modules: modules.length, loaded: modules };
    }
    // Warm the resident process: a client it serves loads only the thin client's few modules.
    const deadline = performance.now() + 30_000;
    for (;;) {
      const warm = sample(box, 'whoami', { hookDir: dir, resident: true, code });
      if (warm.modules.length < 40) break;
      if (performance.now() > deadline) throw new Error(`no resident process served the fixture within 30 s (a client loaded ${warm.modules.length} modules)`);
    }
    for (const name of Object.keys(SEAT_COMMANDS)) {
      const samples = [];
      for (let round = 0; round < ROUNDS; round += 1) samples.push(sample(box, name, { resident: true, code }).ms);
      const sorted = [...samples].sort((a, b) => a - b);
      Object.assign(result[name], { medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), samplesMs: samples.map(Math.round) });
    }
    return result;
  } finally {
    if (box) await stopResidents(box, code);
    fs.rm(dir, { recursive: true, force: true });
  }
}

/** The committed ceilings, lowered by the audit's record where it measured less. */
export function effectiveCeilings(committed, record) {
  const ceilings = { ...committed.modules };
  for (const [name, value] of Object.entries(record?.ceilings ?? {})) {
    if (Number.isSafeInteger(value) && Number.isSafeInteger(ceilings[name])) ceilings[name] = Math.min(ceilings[name], value);
  }
  return ceilings;
}

/**
 * Every breach of a measurement against the ceilings: a module count over its ceiling, naming the modules loaded that
 * the last passing check did not, or a median over the wall bar.
 */
export function budgetBreaches(measured, ceilings, { wallMs = WALL_MS, lastLoaded = {} } = {}) {
  const breaches = [];
  for (const [name, row] of Object.entries(measured)) {
    if (Number.isSafeInteger(ceilings[name]) && row.modules > ceilings[name]) {
      const before = new Set(lastLoaded[name] ?? []);
      breaches.push({ command: name, kind: 'modules', value: row.modules, ceiling: ceilings[name],
        added: lastLoaded[name] ? row.loaded.filter(path => !before.has(path)) : [] });
    }
    if (Number.isFinite(row.medianMs) && row.medianMs > wallMs) breaches.push({ command: name, kind: 'wall', value: row.medianMs, ceiling: wallMs, added: [] });
  }
  return breaches;
}

/** The ceilings after a pass: each lowered to what was measured, never raised. */
export function loweredCeilings(ceilings, measured) {
  return Object.fromEntries(Object.entries(ceilings).map(([name, value]) => [name, Math.min(value, measured[name]?.modules ?? value)]));
}

/** The deterministic title of a breach's repair; open items with it are never filed twice. */
export function breachTitle(breach) {
  return `Board command budget: pullboard ${breach.command} ${breach.kind === 'modules' ? 'module count' : 'wall time'} over its ceiling`;
}

/** The repair item for one breach: what was measured, the ceiling, the newly loaded modules and the commit range. */
export function breachItem(breach, { lane, tip, lastPassTip }) {
  const range = lastPassTip ? `${lastPassTip.slice(0, 12)}..${tip.slice(0, 12)}` : `up to ${tip.slice(0, 12)} (no passing check recorded)`;
  const measured = breach.kind === 'modules'
    ? `loads ${breach.value} modules in a fresh process, over its ceiling of ${breach.ceiling}`
    : `answers in a median ${breach.value} ms through the warm resident process, over the ${breach.ceiling} ms bar`;
  const added = breach.added.length ? ` Modules it newly loads: ${breach.added.slice(0, 12).join(', ')}${breach.added.length > 12 ? `, and ${breach.added.length - 12} more` : ''}.` : '';
  return { by: 'coordinator', lane, title: breachTitle(breach), route: 'mid', specIds: ['C7'], parentId: null, after: [], expectedBuildMinutes: 30,
    criterion: `The main audit at ${tip} measured pullboard ${breach.command}: it ${measured}. Commits since the last passing check: ${range}.${added} `
      + `1. pullboard ${breach.command} is back at or under ${breach.ceiling}${breach.kind === 'modules' ? ' modules' : ' ms'} as node packages/gate/src/io/matrix.js --only board-commands measures it. [measurement] `
      + '2. The import or work that raised it loads lazily, only where it is used. [reasoning]',
    brief: `Files: packages/gate/data/ceilings/board-commands.json\nSource: board-command budget, main audit ${range}\nRun: node packages/gate/src/io/matrix.js --only board-commands` };
}

/** Read a JSON file, or null. */
function readJson(file) {
  try { return JSON.parse(fs.readFile(file, 'utf8')); } catch { return null; }
}

/**
 * The main audit's board-command check for a board root. At most every CHECK_EVERY_MS it measures this checkout's
 * code, files one repair per breach not already open, and on a pass records the tip and lowers the ceilings.
 * `read(action)` reads the board; `write(operation, args)` runs an ordered board move.
 */
export function boardCommandBudgetCheck({ code = ROOT, measure = measureBoardCommands, now = () => Date.now() } = {}) {
  return async function checkBoardCommands({ directory, job, lane, read, write }) {
    const file = join(directory, RECORD_NAME);
    const record = readJson(file) ?? { version: 1 };
    if (Number.isFinite(record.checkedAt) && now() - record.checkedAt < CHECK_EVERY_MS) return null;
    const committed = readJson(join(code, 'packages/gate/data/ceilings/board-commands.json')) ?? { modules: {} };
    const ceilings = effectiveCeilings(committed, record);
    const measured = await measure(code, directory);
    const breaches = budgetBreaches(measured, ceilings, { wallMs: committed.wallMs ?? WALL_MS, lastLoaded: record.lastPass?.loaded ?? {} });
    const filed = [];
    for (const breach of breaches) {
      const title = breachTitle(breach);
      const open = read(board => board.db.prepare("SELECT item_id FROM item WHERE item_title=? AND item_status IN ('open','claimed','submitted') LIMIT 1").get(title));
      if (open) { filed.push({ ...breach, item: open.item_id, filed: false }); continue; }
      filed.push({ ...breach, item: await write('addItem', [breachItem(breach, { lane, tip: job.tip, lastPassTip: record.lastPass?.tip ?? null })]), filed: true });
    }
    const next = { ...record, version: 1, checkedAt: now(), lastRun: { tip: job.tip, measured: Object.fromEntries(Object.entries(measured).map(([name, row]) => [name, { modules: row.modules, medianMs: row.medianMs }])), breaches: filed } };
    if (!breaches.length) Object.assign(next, { ceilings: loweredCeilings(ceilings, measured),
      lastPass: { tip: job.tip, loaded: Object.fromEntries(Object.entries(measured).map(([name, row]) => [name, row.loaded])) } });
    fs.writeFile(file, JSON.stringify(next, null, 2) + '\n');
    fs.chmod(file, 0o600);
    return { measured, breaches: filed };
  };
}
