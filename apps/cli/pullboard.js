#!/usr/bin/env node
/**
 * The pullboard command. Node 22 announces that node:sqlite is experimental; that notice is noise
 * for a CLI, so it is dropped before the board module loads. Every other warning still prints.
 */

// The board needs node:sqlite, which Node ships unflagged from 22.13. An older Node fails to load it
// with an error that names no remedy, so say what to install before anything loads (P3, P4).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  const next = 'install it (for example nvm install 22), then run the command again';
  const message = `this is Node ${process.versions.node}, and pullboard needs Node 22.13 or newer: ${next}`;
  const args = process.argv.slice(2);
  const flags = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  if (flags.includes('--json')) {
    // This module is pure output formatting: it never imports the unavailable SQLite module.
    const {
      commandOutput,
      versionedRefusal,
    } = await import('../../packages/config/browser.js');
    const output = commandOutput(args, { stdout: process.stdout, stderr: process.stderr }, { refusalDocument: versionedRefusal });
    output.refusal({ code: 'NODE_TOO_OLD', message, next });
    output.flush(1);
  } else process.stderr.write(`pullboard: [NODE_TOO_OLD] ${message}\n`);
  process.exit(1);
}

// Compiled module code is kept per machine, so a short command re-reads it instead of compiling ~450 ms of small modules again [C7].
// Only a directory this account owns and nobody else can write is used: cached code runs. Any failure leaves the command uncached.
try {
  const { processMachineHome } = await import('../../packages/kernel/light.js');
  const { mkdirSync, statSync } = process.getBuiltinModule('node:fs');
  const directory = `${processMachineHome()}/compile-cache`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const seen = statSync(directory);
  if (seen.isDirectory() && (process.getuid === undefined || seen.uid === process.getuid()) && (seen.mode & 0o022) === 0) {
    process.getBuiltinModule('node:module').enableCompileCache?.(directory);
  }
} catch { /* An unwritable or missing machine home just compiles as before. */ }

const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};

// The gate package runs a timed shell it does not name: this app hands it the runner app's entry, which every child inherits [C7].
process.env.PULLBOARD_TIMED_SHELL ??= new URL('../runner/src/io/shell.js', import.meta.url).pathname;

// A reader that stops early, like head, closes the pipe, and the rest of the output has nowhere to
// go: end quietly, as other command-line tools do, rather than print a stack trace (N24).
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
  process.exit(process.exitCode ?? 0);
});

// A shell left standing in a removed item folder starts here with no working directory: move to the seat checkout (#2456).
try { process.cwd(); } catch { (await import('./src/io/cli-main/live-cwd.js')).liveCwd(undefined); }

// The common version probe needs only the release metadata, not the command dispatcher.
// `--version --json` is the same probe in the document form, so a scripted version check pays for no dispatcher either [C7].
const versionJson = process.argv.length === 4 && process.argv[2] === '--version' && process.argv[3] === '--json';
if (versionJson) {
  const { default: packageData } = await import('../../package.json', { with: { type: 'json' } });
  process.stdout.write(`${JSON.stringify({ version: 1, release: packageData.version }, null, 2)}\n`);
  process.exit(0);
}
if (process.argv.length === 3 && process.argv[2] === '--version') {
  const { default: packageData } = await import('../../package.json', { with: { type: 'json' } });
  // A hook one release back is told its own version, so an upgrade never stops a seat's commit (#7760).
  const { hookProbeVersion } = process.env.GIT_EXEC_PATH ? await import('./src/io/hook/probe.js') : { hookProbeVersion: (release) => release };
  process.stdout.write(`${hookProbeVersion(packageData.version, { cwd: process.cwd(), env: process.env })}\n`);
  process.exit(0);
}

// A commit hook runs as a child of the shim, which times it from process start and stops it after 120 s (#5719).
if (process.argv[2] === 'hook') {
  const shim = await import('./src/io/hook/shim.js');
  if (shim.wantsHookShim(process.argv.slice(2), process.env)) {
    process.exit(await shim.runHookShim(process.argv[1], process.argv.slice(2), { cwd: process.cwd(), env: process.env, stderr: process.stderr }));
  }
}

// A self-hosted pre-commit runs from the staged index with the item's companions applied, never the working tree (#2593).
if (process.argv[2] === 'hook') {
  const composed = await (await import('./src/io/hook/composed.js')).runComposedHook(process.argv[1], process.argv.slice(2), { cwd: process.cwd(), env: process.env });
  if (composed !== null) process.exit(composed);
}

// A bare heartbeat is one sidecar write, so it runs before tool selection and the stale-checkout redirect and loads no dispatcher, resident client or recovery (#3847).
if (process.argv.length === 3 && process.argv[2] === 'heartbeat') {
  const beat = (await import('./src/io/heartbeat/thin.js')).runThinHeartbeat({ cwd: process.cwd(), stderr: process.stderr });
  if (beat !== null) process.exit(beat);
}

// Select immutable tooling before redirecting a stale worktree to today's CLI.
// Only these two small modules load here; the dispatcher loads after the resident path declines, so a warm client stays thin [H24].
const { selectedToolEntry, asksVersion } = await import('./light.js');
if (process.argv[2] !== 'tool-build' && !asksVersion(process.argv.slice(2))) {
  try {
    const selected = await selectedToolEntry(process.cwd(), process.argv[1]);
    if (selected) {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(process.execPath, [selected, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
      process.exit(result.status ?? 1);
    }
  } catch (error) {
    if (process.argv.includes('--json')) {
      const { commandOutput, versionedRefusal } = await import('../../packages/config/browser.js');
      const output = commandOutput(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }, { refusalDocument: versionedRefusal });
      output.refusal({ code: error.code ?? 'TOOL_BUILD_UNAVAILABLE', message: error.message,
        next: 'ask the coordinator to promote a native gated tool build' });
      output.flush(1);
    } else process.stderr.write(`pullboard: [${error.code ?? 'TOOL_BUILD_UNAVAILABLE'}] ${error.message}\n`);
    process.exit(1);
  }
}

// A worktree behind the main checkout runs the main checkout's CLI after checking its own pin.
const handed = (await import('./src/io/current.js')).runCurrentCli(process.argv[1]);
if (handed !== null) process.exit(handed);

// A warm resident board process runs the command when one serves this checkout; otherwise it runs here.
const resident = await (await import('./src/io/resident/client.js')).runResident(process.argv.slice(2));
// A commit hook runs hookCommand alone: no dispatcher, and in an agent session only the checkout lease bind [H24].
// A seat the thin entry cannot name returns null and takes the full path below (#5719).
const thin = resident === null && process.argv[2] === 'hook' && (await import('./src/io/hook/thin-door.js')).isThinHook(process.argv.slice(2), process.env)
  ? await (await import('./src/io/hook/thin.js')).runThinHook(process.argv.slice(2), { cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env })
  : null;
if (resident !== null) process.exitCode = resident;
else if (thin !== null) process.exitCode = thin;
else {
  // Mark this command as the outermost live pullboard for every child it starts, unless a live outer one already
  // did: a pullboard test under a gate, check or landing then blocks and returns its real exit code [C7].
  const outer = Number(process.env.PULLBOARD_CLI_PID);
  let outerAlive = false;
  if (Number.isSafeInteger(outer) && outer > 0 && outer !== process.pid) {
    try { process.kill(outer, 0); outerAlive = true; } catch (error) { outerAlive = error?.code === 'EPERM'; }
  }
  if (!outerAlive) process.env.PULLBOARD_CLI_PID = String(process.pid);
  const { main } = await import('./src/io/main.js');
  const { loadNativeBoard, loadProcessPorts, gateWaitReporter } = await import('./src/io/ports/process.js');
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    loadNativeBoard,
    gateWaitReporter,
    loadProcessPorts,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  });
}
