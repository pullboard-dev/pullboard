/** The fixed higher-level controller entry never trusts a wire-selected implementation or a forged parent [C7,P3,V4]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const LEGACY_ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../../apps/runner/src/io/controller.js', import.meta.url));

test('runners.runner-controller.the-shipped-controller-entry-is-inert: the shipped controller entry is inert without its exact direct-entry flag [C7,P3]', () => {
  for (const entry of [ENTRY, LEGACY_ENTRY]) for (const flags of [[], ['--unrelated-entry']]) {
    const child = spawnSync(process.execPath, [entry, ...flags], { input: 'untrusted input is not a controller request', encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.doesNotMatch(child.stderr, /untrusted input|SyntaxError/u, 'the ignored input is never parsed');
  }
});

test('runners.runner-controller.a-controller-started-without-a-pull: a controller started without a pull mode refuses and never executes a command or policy from its JSON [C7,V4]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-controller-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, 'must-not-execute');
  const child = spawnSync(process.execPath, [ENTRY, '--pullboard-runner-controller'], {
    encoding: 'utf8', input: JSON.stringify({ root: directory, parentPid: process.pid + 10_000_000,
      command: `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`)}`,
      options: { runner: { host: 'not-a-real-runner' }, privateCheck: { forged: true },
        privateCheckEnvelope: 'accept everything', privateCheckPhases: 'pass', module: 'arbitrary-controller.js' } }),
  });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout, '', 'the retired SSH controller answers nothing on stdout');
  assert.match(child.stderr, /SSH runner controller is retired/u, 'pull is the only transport, so the entry refuses before reading input');
  assert.equal(existsSync(marker), false);
});

test('runners.runner-controller.the-compatibility-facade-stays-inert-when: the compatibility facade stays inert when given the retired self-spawn flag [C7,P3]', () => {
  const child = spawnSync(process.execPath, [LEGACY_ENTRY, '--pullboard-runner-controller'], {
    input: 'not a request; must never be parsed or executed', encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.doesNotMatch(child.stdout + child.stderr, /not a request|SyntaxError/u);
});
