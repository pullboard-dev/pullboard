/**
 * Install `runner serve` on a registered runner as a macOS service that restarts on exit, or remove it, over one ssh:
 * the runner then pulls jobs from the board URL with no inbound ssh afterwards [P7]. A board on the local network gets a
 * system LaunchDaemon run as the runner user, which macOS Local Network privacy lets through; any other board gets a
 * login LaunchAgent. Each install is recorded on this machine so pullboard doctor can name a service that cannot reach
 * its board.
 *
 * The runner gets only the service entry and the repo files it imports, checked here, plus the board key in a file
 * only its owner reads; it runs them with its registered Node.
 */
import { execFile } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from '../../../kernel/index.js';
import { lex } from '../../../kernel/index.js';
import { runRunnerScript } from './pull/ssh.js';
import { pullWord } from './pull/scripts.js';
import { localNetworkHost } from '../logic/service.js';
import { serviceForm } from '../logic/service.js';
import { machineHome } from '../../../resources/index.js';

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
    const text = readFileSync(posix.join(root, path), 'utf8');
    files[path] = text;
    bytes += Buffer.byteLength(text);
    if (bytes > SERVICE_BYTES) throw new Refused('RUNNER_SERVICE_SIZE', `the runner service reaches over ${SERVICE_BYTES} bytes of imports from ${entry}; import less from ${entry}`);
    const { code, strings } = lex(text);
    for (const string of strings) {
      if (!IMPORT_BEFORE.test(code.slice(Math.max(0, string.start - 24), string.start))) continue;
      const specifier = string.text;
      if (specifier.startsWith('node:')) continue;
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
 * the files, the key and the launchd job and loads it, or removes them. It prints one JSON line.
 * A LaunchAgent loads in the login session. A LaunchDaemon, chosen for a board on the local network, is loaded at once
 * when this runs as root; otherwise it is staged beside the service with the one sudo command that loads it, since
 * install-serve never runs sudo.
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
  const agentPlist = join(agents, `${plan.label}.plist`);
  const daemonPlist = join(plan.daemons || '/Library/LaunchDaemons', `${plan.label}.plist`);
  const staged = join(dir, `${plan.label}.daemon.plist`);
  const uid = process.getuid();
  const user = userInfo().username;
  const launchctl = (...args) => new Promise((done, fail) => execFile('launchctl', args, error => {
    if (error?.code === 'ENOENT') fail(new Error('launchctl is not on this runner; install-serve needs a macOS runner'));
    else done(!error);
  }));
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const dquote = value => `"${String(value).replace(/["$`\\]/gu, '\\$&')}"`;
  // Stop a running copy first, so a reinstall replaces it and a removal leaves nothing running; system needs root.
  await launchctl('bootout', `gui/${uid}/${plan.label}`);
  await launchctl('bootout', `user/${uid}/${plan.label}`);
  if (uid === 0) await launchctl('bootout', `system/${plan.label}`);
  rmSync(agentPlist, { force: true });
  if (uid === 0) rmSync(daemonPlist, { force: true });
  // A daemon this user cannot remove is left to one sudo line, so no older copy keeps pulling unseen.
  const daemonLeft = uid !== 0 && existsSync(daemonPlist);
  const unload = `launchctl bootout system/${plan.label} 2>/dev/null; rm -f ${quote(daemonPlist)}`;
  if (plan.remove) {
    rmSync(dir, { recursive: true, force: true });
    const sudo = daemonLeft ? `sudo sh -c ${dquote(unload)}` : null;
    process.stdout.write(`${JSON.stringify({ removed: true, plist: daemonLeft ? daemonPlist : agentPlist, dir, sudo })}\n`);
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
  const daemon = plan.form === 'daemon';
  const plist = daemon ? uid === 0 ? daemonPlist : staged : agentPlist;
  const install = `launchctl bootout system/${plan.label} 2>/dev/null; install -m 644 -o root -g wheel ${quote(staged)} ${quote(daemonPlist)} && launchctl bootstrap system ${quote(daemonPlist)}`;
  const sudo = daemon && uid !== 0 ? `sudo sh -c ${dquote(install)}` : daemonLeft ? `sudo sh -c ${dquote(unload)}` : null;
  const host = new URL(plan.board).hostname;
  // What the service logs when the board stays unreachable: the likely macOS block and the exact fix for this form.
  const hint = daemon
    ? `macOS Local Network privacy blocks a LaunchAgent or a process left by ssh from ${host}; ${sudo
      ? `run runner serve as a LaunchDaemon: on this runner run ${sudo}` : 'this LaunchDaemon is allowed, so check that the board is up, or use its Tailscale 100.x address'}`
    : `if ${host} is on the local network, macOS Local Network privacy blocks this LaunchAgent; run pullboard runner install-serve ${plan.host} --board <the board's LAN URL> to install a LaunchDaemon, or use the board's Tailscale 100.x address`;
  const args = [process.execPath, join(app, plan.entry), plan.board, keyFile, join(root, 'pull'), hint];
  const path = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    `  <key>Label</key><string>${xml(plan.label)}</string>`,
    ...(daemon && uid !== 0 ? [`  <key>UserName</key><string>${xml(user)}</string>`] : []),
    '  <key>ProgramArguments</key>', '  <array>', ...args.map(arg => `    <string>${xml(arg)}</string>`), '  </array>',
    '  <key>EnvironmentVariables</key>', `  <dict><key>PATH</key><string>${xml(path)}</string><key>HOME</key><string>${xml(homedir())}</string></dict>`,
    `  <key>WorkingDirectory</key><string>${xml(dir)}</string>`,
    '  <key>RunAtLoad</key><true/>', '  <key>KeepAlive</key><true/>', '  <key>ThrottleInterval</key><integer>10</integer>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`, `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>', '</plist>', ''].join('\n'));
  // A bootout just before may still be settling; an agent tries the GUI session domain first, then the background user domain.
  let domain = null;
  const domains = daemon ? uid === 0 ? ['system'] : [] : [`gui/${uid}`, `user/${uid}`];
  for (const candidate of domains) {
    for (let attempt = 0; attempt < 5 && !domain; attempt++) {
      if (await launchctl('bootstrap', candidate, plist)) domain = candidate;
      else await new Promise(done => setTimeout(done, 500));
    }
    if (domain) break;
  }
  process.stdout.write(`${JSON.stringify({ installed: true, form: daemon ? 'daemon' : 'agent', loaded: domain !== null, domain, plist,
    ...(daemon ? { daemonPlist, user: uid === 0 ? 'root' : user } : {}), sudo, dir, log, args })}\n`);
}

/** The program the runner's Node runs: the installer's own source, with the built-ins it uses. */
function installerProgram() {
  return [
    "import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { homedir, userInfo } from 'node:os';",
    "import { execFile } from 'node:child_process';",
    runnerServiceInstaller.toString(),
    'await runnerServiceInstaller();',
  ].join('\n');
}

/** Where this machine records each runner's installed service, for pullboard doctor. */
function serviceRecordFile() { return join(machineHome(), 'runner-services.json'); }

/** Each runner's last install-serve result by host, or an empty record. */
export function runnerServiceRecords(file = serviceRecordFile()) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

/**
 * The doctor problems for installed runner services that cannot reach their board: a LaunchDaemon still waiting on its
 * sudo line, or a LaunchAgent pointed at a board on the local network, both blocked by macOS Local Network privacy.
 *
 * @param {Record<string, object>} [records]
 * @returns {Array<{ code: string, message: string, next: string }>}
 */
export function runnerServiceProblems(records = runnerServiceRecords()) {
  const problems = [];
  for (const [host, service] of Object.entries(records)) {
    if (!service?.board) continue;
    const board = new URL(service.board).hostname;
    if (service.form === 'daemon' && !service.loaded && service.sudo) {
      problems.push({ code: 'RUNNER_LOCAL_NETWORK', message: `runner ${host}: runner serve is staged as a LaunchDaemon but not loaded, so nothing pulls from ${board}; a LaunchAgent or a process left by ssh is blocked by macOS Local Network privacy`,
        next: `on ${host} run: ${service.sudo}` });
    } else if (service.form !== 'daemon' && localNetworkHost(board)) {
      problems.push({ code: 'RUNNER_LOCAL_NETWORK', message: `runner ${host}: runner serve is a LaunchAgent pulling from ${board} on the local network, which macOS Local Network privacy blocks (its log repeats board unreachable: fetch failed)`,
        next: `pullboard runner install-serve ${host} --board ${service.board}, then run the sudo line it prints on ${host}` });
    }
  }
  return problems;
}

/** Record or clear one runner's install result; a failed write only loses doctor's hint. */
function recordService(host, service, file = serviceRecordFile()) {
  const records = runnerServiceRecords(file);
  if (service) records[host] = service; else delete records[host];
  try { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`); } catch { /* doctor's hint only */ }
}

/**
 * Install runner serve on a registered runner as a service, or remove it.
 *
 * @param {{ host: string, node?: string, root?: string }} runner - The registered runner record.
 * @param {{ board?: string, key?: string, remove?: boolean, ssh?: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<object>} What the runner reported: the form, plist, folder and log, whether launchd loaded it, and
 *   the sudo line a person runs when it could not.
 */
export async function installRunnerService(runner, { board, key, remove = false, ssh = 'ssh', env = process.env } = {}) {
  const plan = { label: SERVICE_LABEL, root: runner.root ?? '', remove, host: runner.host };
  if (!remove) {
    const target = serviceBoard(board);
    const chosen = key ?? target.key;
    if (!chosen) throw new Refused('BOARD_KEY_REQUIRED', 'the runner needs the board key: pass --key, or use the URL pullboard serve printed with its ?k=', 'pullboard runner install-serve <ssh-host> --board <url> --key <board-key>');
    Object.assign(plan, { board: target.url, key: chosen, form: serviceForm(target.url), entry: SERVICE_ENTRY, files: serviceFiles() });
  }
  const script = `exec ${pullWord(runner.node ?? 'node')} --input-type=module -e ${pullWord(installerProgram())}`;
  const run = await runRunnerScript(runner, script, { stdin: JSON.stringify(plan), ssh, env, timeoutMs: INSTALL_MS });
  const line = run.stdout.toString('utf8').trim().split('\n').at(-1) ?? '';
  let reply = null;
  try { reply = JSON.parse(line); } catch { reply = null; }
  if (run.status !== 0 || !reply) {
    throw new Refused('RUNNER_SETUP', `runner ${runner.host} did not ${remove ? 'remove' : 'install'} runner serve: ${run.error ?? (run.stderr.trim().slice(-400) || `status ${run.status}`)}`, 'fix the ssh connection or the runner\'s Node, then run the command again');
  }
  recordService(runner.host, remove ? null : { board: plan.board, form: reply.form, loaded: reply.loaded, sudo: reply.sudo, at: new Date().toISOString() });
  return { host: runner.host, label: SERVICE_LABEL, ...reply };
}
