/** The Roadmap capture finishes on a release the size of a real one, not only on the five-item demo [I11,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../apps/cli/tests/fixtures/child.js';

const SOURCE = fileURLToPath(new URL('../../', import.meta.url));

test('the Roadmap capture finishes on a release of 350 items [I11,C7]', { timeout: 840_000 }, () => {
  const chrome = process.env.PULLBOARD_CHROME || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find((candidate) => { try { return spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; } });
  assert.ok(chrome, 'the Roadmap capture requires installed headless Chrome');
  const fixture = privateFixtureFiles('rc-');
  try {
    const root = join(fixture.root, 'repo');
    mkdirSync(root);
    for (const directory of ['apps', 'packages', 'skills', 'docs/shots', 'docs/img']) cpSync(join(SOURCE, directory), join(root, directory), { recursive: true });
    for (const file of ['package.json', 'CHANGELOG.md']) cpSync(join(SOURCE, file), join(root, file));
    const shims = join(fixture.root, 'bin');
    mkdirSync(shims);
    const pullboard = join(shims, 'pullboard');
    writeFileSync(pullboard, `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'apps/cli/pullboard.js')}" "$@"\n`);
    chmodSync(pullboard, 0o755);
    const home = join(fixture.root, 'home');
    const env = Object.assign({}, process.env, {
      PATH: [shims, process.env.PATH].filter(Boolean).join(delimiter), PULLBOARD_CHROME: chrome, PULLBOARD_DEMO_FILLER_ITEMS: '350',
      TMPDIR: fixture.root, TMP: fixture.root, TEMP: fixture.root, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home,
    });
    delete env.PULLBOARD_VIEW_FOREGROUND;
    const result = spawnSync(process.execPath, [join(root, 'docs/shots/demo.mjs'), '--roadmap-only'], { cwd: root, env, encoding: 'utf8', timeout: 780_000 });
    assert.equal(result.status, 0, `the Roadmap capture completes on 350 items: ${result.signal ?? ''} ${result.stderr}\n${result.stdout}`);
    for (const theme of ['light', 'dark']) assert.ok(statSync(join(root, 'docs/img', `roadmap-${theme}.png`)).size > 8, `roadmap-${theme}.png was captured`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
