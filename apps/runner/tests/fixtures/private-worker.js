/** Own real private worker children and their files within the Runner test fixture [C7,V18,V2]. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = new URL('../../src/io/private/check/worker.js', import.meta.url);

/** Launch the shipped worker entry with real pipes and its production 100ms + 1000ms watchdog. */
export function privateWorkerFixture(t, files) {
  const root = files.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let serial = 0;
  /** Observe loaded modules and genuine shell spawn without changing worker bytes or import resolution. */
  function runWorker(command, { blockFull = false, path = process.env.PATH } = {}) {
    const name = String(++serial);
    const logPath = join(root, name + '.log');
    const pidFile = logPath + '.pid';
    const report = join(root, name + '.json');
    const observer = join(root, name + '-observer.mjs');
    writeFileSync(observer, `
import { registerHooks } from 'node:module';
import { channel } from 'node:diagnostics_channel';
import { writeFileSync } from 'node:fs';
const modules = new Set();
registerHooks({ load(url, context, next) {
  if (${blockFull} && url.endsWith('/packages/sandbox/index.js')) throw new Error('unrelated Sandbox initialization unavailable');
  if (url.startsWith('file:')) modules.add(url);
  return next(url, context);
} });
channel('child_process').subscribe(({ process: child }) => child.once('spawn', () => {
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ shellPid: child.pid, startupMs: performance.now(), modules: [...modules].sort() }));
}));
`, { flag: 'wx', mode: 0o600 });
    const started = performance.now();
    try {
      const result = spawnSync(process.execPath, ['--import', observer, fileURLToPath(ENTRY)], {
        cwd: root, env: { ...process.env, HOME: root, PULLBOARD_HOME: join(root, 'home'), PATH: path },
        input: JSON.stringify({ command, timeout: 100, pidFile, logPath }), encoding: 'utf8',
        timeout: 1100, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
      });
      return { ...result, elapsedMs: performance.now() - started,
        report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null,
        log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : null,
        reply: result.status === 0 ? JSON.parse(result.stdout) : null };
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* The timed worker already stopped its private group. */ }
        }
      }
    }
  }
  return { runWorker };
}
