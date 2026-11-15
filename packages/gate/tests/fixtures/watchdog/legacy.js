/** Run two native CLI test workers under the legacy watchdog: a noisy one whose child prints, and a quiet hung sibling [C7,V10]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../../src/io/run/tests.js', import.meta.url));

/** Real native CLI workers run together: noisy inherited child output must not mask the quiet sibling. */
export async function runLegacy(t, mode, duration = 8000) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-legacy-watchdog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'a-noisy.test.js'), `import {test} from 'node:test';\nimport {execFileSync} from 'node:child_process';\ntest('noisy child',()=>{execFileSync(process.execPath,['-e',"const end=Date.now()+${duration};const t=setInterval(()=>{console.log('working');if(Date.now()>=end)clearInterval(t)},300)"],{stdio:'inherit'})});\n`);
  writeFileSync(join(root, 'b-hung.test.js'), "import {test} from 'node:test';\ntest('quiet sibling',async()=>{setInterval(()=>{},10000);await new Promise(()=>{})});\n");
  const flags = mode === 'watch' ? ['--watch'] : ['--experimental-test-coverage'];
  const child = spawn(process.execPath, [runner, ...flags, '--test-concurrency=2', join(root, 'a-noisy.test.js'), join(root, 'b-hung.test.js')], {
    cwd: root, detached: true, env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'),
      PULLBOARD_TEST_IDLE_TIMEOUT_MS: '3000', PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: String(duration + 15000), PULLBOARD_TEST_TIMEOUT_MS: String(duration + 10000) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process group may already have exited. */ } reject(new Error('legacy fixture timed out: ' + output)); }, duration + 20000);
    child.once('error', reject);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    if (mode === 'watch') {
      const poll = setInterval(() => {
        if (!/noisy child/u.test(output) || !/HUNG file .*b-hung\.test\.js/u.test(output)) return;
        clearInterval(poll);
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The process group may already have exited. */ }
      }, 100);
      child.once('close', () => clearInterval(poll));
    }
  });
  assert.match(output, /HUNG file .*b-hung\.test\.js/u);
  assert.doesNotMatch(output, /HUNG file .*a-noisy\.test\.js/u);
  assert.match(output, /noisy child/u);
}
