/**
 * Install `runner serve` on a registered runner as a macOS login service (a launchd agent that restarts on exit), or
 * remove it, over one ssh: the runner then pulls jobs from the board URL with no inbound ssh afterwards [P7].
 *
 * The runner gets only the service entry and the repo files it imports, checked here, plus the board key in a file
 * only its owner reads; it runs them with its registered Node.
 */
import { execFile } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../kernel/index.js';
import { lex } from '../../../kernel/index.js';
import { runRunnerScript } from './pull/ssh.js';
import { pullWord } from './pull/scripts.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
/** The runner-side program: runner serve on its own, without the CLI. */
export const SERVICE_ENTRY = 'apps/cli/src/io/runner/service.js';
/** The launchd label, so a reinstall replaces the one service and --remove finds it. */
export const SERVICE_LABEL = 'dev.pullboard.runner-serve';
// Budget: the service and what it imports through the drive and landing front doors is about 8 MB; double that is a runaway closure.
const SERVICE_BYTES = 16 * 1024 ** 2;
// Budget: one ssh writes a few files and asks launchd to load them; a minute covers a slow login shell and retries.
const INSTALL_MS = 60_000;
// A string the lexer reads right after `from`, `import` or `import(` is an import; strings and comments elsewhere never count.
const IMPORT_BEFORE = /(?:\bfrom|\bimport\s*\(?)\s*$/u;
// A data file a module reads next to itself is written `new URL('./file', import.meta.url)`; it is part of the closure too.
const URL_BEFORE = /\bnew\s+URL\s*\(\s*$/u;
const URL_AFTER = /^\s*,\s*import\.meta\.url\b/u;

/**
 * The service entry and every repo file it imports, by repo path. Only Node built-ins may be imported from outside the
 * repo, so the runner needs nothing installed but Node.
 *
 * @param {string} [root] - The repo root.
 * @param {string} [entry] - The entry's repo path.
 * @returns {Record<string, string>}
 */
export function serviceFiles(root = REPO, entry = SERVICE_ENTRY) {
  const files = {};
  const pending = [entry];
  let bytes = 0;
  while (pending.length) {
    const path = pending.pop();
    if (files[path] !== undefined) continue;
    // A directory a module lists at run time (`new URL('./', import.meta.url)`) has no text to copy; what it holds is copied when imported.
    if (statSync(posix.join(root, path), { throwIfNoEntry: false })?.isDirectory()) continue;
    let text;
    try { text = readFileSync(posix.join(root, path), 'utf8'); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      throw new Refused('RUNNER_SERVICE_DATA', `the runner service needs ${path}, which is not in the repo; restore ${path} or stop importing it`, 'restore the file, then run the command again');
    }
    files[path] = text;
    bytes += Buffer.byteLength(text);
    if (bytes > SERVICE_BYTES) throw new Refused('RUNNER_SERVICE_SIZE', `the runner service reaches over ${SERVICE_BYTES} bytes of imports from ${entry}; import less from ${entry}`);
    if (!path.endsWith('.js')) continue;
    const { code, strings } = lex(text);
    for (const string of strings) {
      const before = code.slice(Math.max(0, string.start - 24), string.start);
      const isData = URL_BEFORE.test(before) && URL_AFTER.test(code.slice(string.end, string.end + 40));
      if (!isData && !IMPORT_BEFORE.test(before)) continue;
      const specifier = string.text;
      if (specifier.startsWith('node:')) continue;
      if (isData && specifier.includes('${')) continue;
      if (isData && !specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new Refused('RUNNER_SERVICE_IMPORT', `${path} imports ${specifier}; the runner service may import only node: built-ins and repo files`);
      }
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (target.startsWith('../')) throw new Refused('RUNNER_SERVICE_IMPORT', `${path} imports ${specifier}, outside the repo`);
      pending.push(target);
    }
  }
  return files;
}

/**
 * Split a board URL into the address the service keeps (no key in it) and the key it carried.
 *
 * @param {string} board - `http(s)://<host>/api/v1/boards/<board>`, optionally with `?k=<key>`.
 * @returns {{ url: string, key: string | null }}
 */
export function serviceBoard(board) {
  let url;
  try { url = new URL(board); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !/^\/api\/v1\/boards\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)) {
    throw new Refused('USAGE', '--board is the board\'s job URL, http(s)://<host>:<port>/api/v1/boards/<board>, as pullboard serve prints it');
  }
  return { url: `${url.origin}${url.pathname.replace(/\/$/u, '')}`, key: url.searchParams.get('k') || null };
}

/**
 * The installer the runner's Node runs: it reads the plan from stdin, stops any running copy, and then either writes
 * the files, the key and the launchd agent and loads it, or removes them. It prints one JSON line.
 * Why it is a function: its source is sent as the program, so it may use only the built-ins the program header imports,
 * which this module imports too.
 */
export async function runnerServiceInstaller() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const plan = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const root = plan.root || join(homedir(), '.pullboard-runner');
  const dir = join(root, 'serve');
  const agents = join(homedir(), 'Library', 'LaunchAgents');
  const plist = join(agents, `${plan.label}.plist`);
  const uid = process.getuid();
  const launchctl = (...args) => new Promise((done, fail) => execFile('launchctl', args, error => {
    if (error?.code === 'ENOENT') fail(new Error('launchctl is not on this runner; install-serve needs a macOS runner'));
    else done(!error);
  }));
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  // Stop a running copy first, so a reinstall replaces it and a removal leaves nothing running.
  await launchctl('bootout', `gui/${uid}/${plan.label}`);
  await launchctl('bootout', `user/${uid}/${plan.label}`);
  if (plan.remove) {
    rmSync(plist, { force: true });
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({ removed: true, plist, dir })}\n`);
    return;
  }
  const app = join(dir, 'app');
  const next = join(dir, 'app.next');
  rmSync(next, { recursive: true, force: true });
  for (const [path, text] of Object.entries(plan.files)) {
    mkdirSync(dirname(join(next, path)), { recursive: true });
    writeFileSync(join(next, path), text);
  }
  writeFileSync(join(next, 'package.json'), '{ "type": "module" }\n');
  rmSync(app, { recursive: true, force: true });
  renameSync(next, app);
  const keyFile = join(dir, 'board.key');
  writeFileSync(keyFile, `${plan.key}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const log = join(dir, 'serve.log');
  const args = [process.execPath, join(app, plan.entry), plan.board, keyFile, join(root, 'pull')];
  const path = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  mkdirSync(agents, { recursive: true });
  writeFileSync(plist, ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    `  <key>Label</key><string>${xml(plan.label)}</string>`,
    '  <key>ProgramArguments</key>', '  <array>', ...args.map(arg => `    <string>${xml(arg)}</string>`), '  </array>',
    '  <key>EnvironmentVariables</key>', `  <dict><key>PATH</key><string>${xml(path)}</string></dict>`,
    `  <key>WorkingDirectory</key><string>${xml(dir)}</string>`,
    '  <key>RunAtLoad</key><true/>', '  <key>KeepAlive</key><true/>', '  <key>ThrottleInterval</key><integer>10</integer>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`, `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>', '</plist>', ''].join('\n'));
  // A bootout just before may still be settling; the GUI session domain first, then the background user domain.
  let domain = null;
  for (const candidate of [`gui/${uid}`, `user/${uid}`]) {
    for (let attempt = 0; attempt < 5 && !domain; attempt++) {
      if (await launchctl('bootstrap', candidate, plist)) domain = candidate;
      else await new Promise(done => setTimeout(done, 500));
    }
    if (domain) break;
  }
  process.stdout.write(`${JSON.stringify({ installed: true, loaded: domain !== null, domain, plist, dir, log, args })}\n`);
}

/** The program the runner's Node runs: the installer's own source, with the built-ins it uses. */
function installerProgram() {
  return [
    "import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { homedir } from 'node:os';",
    "import { execFile } from 'node:child_process';",
    runnerServiceInstaller.toString(),
    'await runnerServiceInstaller();',
  ].join('\n');
}

/**
 * Install runner serve on a registered runner as a login service, or remove it.
 *
 * @param {{ host: string, node?: string, root?: string }} runner - The registered runner record.
 * @param {{ board?: string, key?: string, remove?: boolean, ssh?: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<object>} What the runner reported: the plist, folder and log, and whether launchd loaded it.
 */
export async function installRunnerService(runner, { board, key, remove = false, ssh = 'ssh', env = process.env } = {}) {
  const plan = { label: SERVICE_LABEL, root: runner.root ?? '', remove };
  if (!remove) {
    const target = serviceBoard(board);
    const chosen = key ?? target.key;
    if (!chosen) throw new Refused('BOARD_KEY_REQUIRED', 'the runner needs the board key: pass --key, or use the URL pullboard serve printed with its ?k=', 'pullboard runner install-serve <ssh-host> --board <url> --key <board-key>');
    Object.assign(plan, { board: target.url, key: chosen, entry: SERVICE_ENTRY, files: serviceFiles() });
  }
  const script = `exec ${pullWord(runner.node ?? 'node')} --input-type=module -e ${pullWord(installerProgram())}`;
  const run = await runRunnerScript(runner, script, { stdin: JSON.stringify(plan), ssh, env, timeoutMs: INSTALL_MS });
  const line = run.stdout.toString('utf8').trim().split('\n').at(-1) ?? '';
  let reply = null;
  try { reply = JSON.parse(line); } catch { reply = null; }
  if (run.status !== 0 || !reply) {
    throw new Refused('RUNNER_SETUP', `runner ${runner.host} did not ${remove ? 'remove' : 'install'} runner serve: ${run.error ?? (run.stderr.trim().slice(-400) || `status ${run.status}`)}`, 'fix the ssh connection or the runner\'s Node, then run the command again');
  }
  return { host: runner.host, label: SERVICE_LABEL, ...reply };
}
