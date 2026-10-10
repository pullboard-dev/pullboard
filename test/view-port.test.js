/** Keep the view's exact named-port refusal covered in a core-owned file [N26]. */
import assert from 'node:assert/strict';
import { runFixtureChild } from './fixture-child.js';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

test("a named port that is busy is refused with the way out, not a stack trace [N26]", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-view-port-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const held = createServer();
  await new Promise((done) => held.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => held.close(done)));

  const port = held.address().port;
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'home', '.pullboard'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const result = runFixtureChild(process.execPath, [BIN, 'view', '--no-open', '--port', String(port)], {
    cwd: dir, env, encoding: 'utf8',
  });
  assert.equal(result.status, 1, `a refusal, not a crash or a hang: ${result.stderr}`);
  const json = spawnSync(process.execPath, [BIN, 'view', '--no-open', '--port', String(port), '--json'], {
    cwd: dir, env, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(json.status, 1, json.stderr);
  const refusal = JSON.parse(json.stdout).error;
  assert.equal(refusal.code, 'PORT_BUSY');
  assert.equal(result.stderr.trim(), `pullboard: [PORT_BUSY] port ${port} is in use: name another with --port, or leave --port out to take any free one\nnext: ${refusal.next}`);
});
