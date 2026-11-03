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
    } = await import('../packages/config/index.js');
    const output = commandOutput(args, { stdout: process.stdout, stderr: process.stderr }, { refusalDocument: versionedRefusal });
    output.refusal({ code: 'NODE_TOO_OLD', message, next });
    output.flush(1);
  } else process.stderr.write(`pullboard: [NODE_TOO_OLD] ${message}\n`);
  process.exit(1);
}

const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};

// A reader that stops early, like head, closes the pipe, and the rest of the output has nowhere to
// go: end quietly, as other command-line tools do, rather than print a stack trace (N24).
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') throw error;
  process.exit(process.exitCode ?? 0);
});

// A worktree behind the main checkout runs the main checkout's CLI, so landed fixes reach every agent (B17).
const handed = (await import('./current-cli.js')).runCurrentCli(process.argv[1]);
if (handed !== null) process.exit(handed);

// A warm resident board process runs the command when one serves this checkout; otherwise it runs here, as
// before, and the first such command starts one for the next [H24].
const resident = await (await import('./resident-client.js')).runResident(process.argv.slice(2));
if (resident !== null) process.exitCode = resident;
else {
  // Select immutable tooling before dispatch or parsing a newer trunk's configuration.
  const { main, selectedToolEntry } = await import('../src/cli-main.js');
  // Promotion must remain reachable when the published build predates its replacement.
  if (process.argv[2] !== 'tool-build') {
    try {
      const selected = await selectedToolEntry(process.cwd(), process.argv[1]);
      if (selected) {
        const { spawnSync } = await import('node:child_process');
        const result = spawnSync(process.execPath, [selected, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
        process.exit(result.status ?? 1);
      }
    } catch (error) {
      if (process.argv.includes('--json')) {
        const { commandOutput, versionedRefusal } = await import('../packages/config/index.js');
        const output = commandOutput(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }, { refusalDocument: versionedRefusal });
        output.refusal({ code: error.code ?? 'TOOL_BUILD_UNAVAILABLE', message: error.message,
          next: 'ask the coordinator to promote a native gated tool build' });
        output.flush(1);
      } else process.stderr.write(`pullboard: [${error.code ?? 'TOOL_BUILD_UNAVAILABLE'}] ${error.message}\n`);
      process.exit(1);
    }
  }

  // The entry loads only the dispatcher; each command's modules load through its own import() [C7].
  const { loadNativeBoard, loadProcessPorts } = await import('./process-ports.js');
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    loadNativeBoard,
    loadProcessPorts,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  });
}
