/** Exercise the shared Chrome launch arguments against an owned clone-producing stand-in [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromeProcess } from '../../../../apps/cli/tests/fixtures/chrome.js';
import { chromeLaunchArgs } from '../../../../apps/cli/tests/fixtures/chrome/args.js';

/** Wait for the private stand-in to finish creating its marker, before killing it. */
async function waitForReady(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('clone stand-in did not become ready');
}

/** The stand-in models clone creation unless the actual shared disabling argument is present. */
const STAND_IN = `
const { writeFileSync } = require('node:fs');
if (!process.argv.includes('--disable-features=MacAppCodeSignClone')) writeFileSync(process.env.CLONE_MARKER, 'clone');
writeFileSync(process.env.READY_MARKER, 'ready');
setInterval(() => {}, 1000);
`;

/** A killed control leaves a clone; the same launch with shared arguments must not. */
export async function assertNoKilledChromeClone() {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-clone-proof-'));
  try {
    for (const control of [true, false]) {
      const profile = join(root, control ? 'control' : 'harness');
      const clone = `${profile}.clone`, ready = `${profile}.ready`;
      const args = chromeLaunchArgs(profile).filter(arg => !control || arg !== '--disable-features=MacAppCodeSignClone');
      const launched = launchChromeProcess({ executable: process.execPath, args: ['-e', STAND_IN, '--', ...args],
        env: { ...process.env, CLONE_MARKER: clone, READY_MARKER: ready } });
      try {
        await waitForReady(ready);
        launched.child.kill('SIGKILL');
        await launched.close();
        assert.equal(existsSync(clone), control, control
          ? 'the unprotected control must leave its clone after SIGKILL'
          : 'the shared Chrome arguments must prevent a clone after SIGKILL');
      } finally { await launched.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
