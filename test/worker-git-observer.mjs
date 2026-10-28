/** Observe real fixture-worker Git children without replacing their command or result [C7]. */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';

// The fixture writer substitutes this exact literal path before installing the private preload.
const trace = '__FIXTURE_GIT_TRACE_PATH__';
const actualSpawn = childProcess.spawn;
let ordinal = 0;
/** Forward every spawn unchanged and retain only bounded, non-environment Git evidence. */
childProcess.spawn = function observedSpawn(command, args, options) {
  const suppliedArgs = Array.isArray(args) ? args.slice() : args;
  const child = Reflect.apply(actualSpawn, this, arguments);
  if (command === 'git' && Number.isSafeInteger(child.pid)) {
    const row = { worker: process.pid, ordinal: ++ordinal, child: child.pid, command, args: suppliedArgs, cwd: options?.cwd };
    appendFileSync(trace, JSON.stringify({ phase: 'spawn', ...row }) + '\n');
    child.once('close', (code, signal) => {
      appendFileSync(trace, JSON.stringify({ phase: 'close', ...row, code, signal }) + '\n');
    });
  }
  return child;
};
syncBuiltinESMExports();
