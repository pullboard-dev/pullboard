/** @pullboard-test-gui */
/** Cockpit exports contain local socket failures without exposing the session key [C7,N26]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import {
  machine,
  project,
} from '../../tests/fixtures/cockpit/harness.js';

/** Run one isolated raw-fetch control or export treatment with a real first-write socket fault. */
function socketChild(mode, box, root, output) {
  const source = `
    import assert from 'node:assert/strict';
    import { Agent, createServer } from 'node:http';
    import { channel } from 'node:diagnostics_channel';
    import { Socket } from 'node:net';
    import { main } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../tests/fixtures/native.js')).href)};
    const mode = ${JSON.stringify(mode)};
    let firstWriteFault = false, closedBeforeWrite = false;
    process.on('uncaughtExceptionMonitor', error => {
      process.stderr.write(JSON.stringify({ event: 'uncaught', code: error.code, firstWriteFault }) + '\\n');
    });
    channel('undici:client:connected').subscribe(({ socket }) => {
      if (socket.remoteAddress !== '127.0.0.1') return;
      assert.ok(socket instanceof Socket);
      socket.setTypeOfService = function () {
        firstWriteFault = true;
        assert.equal(this.bytesWritten, 0);
        this.destroy();
        throw Object.assign(new Error('controlled first-write socket-option failure'), { code: 'EINVAL' });
      };
    });
    if (mode === 'native') {
      const server = createServer((_request, response) => response.end('ok'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      await fetch('http://127.0.0.1:' + port + '/');
      throw new Error('native fetch unexpectedly completed without its first-write throw');
    }
    const originalCreateConnection = Agent.prototype.createConnection;
    Agent.prototype.createConnection = function (...args) {
      const socket = originalCreateConnection.apply(this, args);
      socket.write = function () {
        assert.ok(socket instanceof Socket);
        assert.equal(socket.bytesWritten, 0);
        const close = () => {
          closedBeforeWrite = true;
          socket.destroy(Object.assign(new Error('controlled socket closed before first write'), { code: 'ECONNRESET' }));
        };
        if (socket.connecting) socket.once('connect', close);
        else close();
        return false;
      };
      return socket;
    };
    let stderr = '';
    let stdout = '';
    try {
      const code = await main(['view', '--export', ${JSON.stringify(output)}], {
        cwd: ${JSON.stringify(root)},
        stdout: { isTTY: false, write: text => { stdout += text; } },
        stderr: { write: text => { stderr += text; } },
      });
      assert.equal(code, 1);
      assert.ok(stderr.includes('[VIEW_UNAVAILABLE] could not read view at http://127.0.0.1:') && /:[0-9]+ while exporting/u.test(stderr));
      assert.doesNotMatch(stderr, /\\?k=/u, 'the refusal does not disclose the view session key');
      assert.equal(closedBeforeWrite, true, 'the export used a real socket closed before its first write');
      assert.equal(firstWriteFault, false, 'the shared local transport did not enter Undici');
      process.stdout.write(JSON.stringify({ event: 'export-refused', code, stdout, stderr, closedBeforeWrite, firstWriteFault }) + '\\n');
    } finally {
      Agent.prototype.createConnection = originalCreateConnection;
    }
  `;
  const sourceDirectory = process.env.PULLBOARD_EXPORT_FETCH_CHILD_SOURCE_DIR ?? box.dir;
  const sourcePath = join(sourceDirectory, `export-fetch-${mode}.mjs`);
  writeFileSync(sourcePath, source, { mode: 0o600 });
  const syntax = spawnSync(process.execPath, ['--check', sourcePath], { cwd: box.dir, encoding: 'utf8', env: box.env });
  assert.equal(syntax.status, 0, `generated ${mode} child syntax: ${syntax.stderr}`);
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.dir, encoding: 'utf8', env: box.env,
  });
}

test('a view export whose socket closes before the first write fails plainly [C7,N26]', () => {
  const box = machine();
  const alpha = project(box, 'exportfetch');
  const output = join(box.dir, 'failed snapshot');
  const bundled = process.binding('natives')['internal/deps/undici/undici'];
  if (bundled.includes('socket.setTypeOfService(request.typeOfService)')) {
    const baseline = socketChild('native', box, alpha.repo, output);
    assert.equal(baseline.status, 1, 'an uncaught Undici first-write throw defeats fetch rejection handling');
    assert.match(baseline.stderr, /"event":"uncaught","code":"EINVAL","firstWriteFault":true/u);
    assert.match(baseline.stderr, /at writeH1/u);
  }

  const treatment = socketChild('local', box, alpha.repo, output);
  assert.equal(treatment.status, 0, treatment.failure ?? treatment.stderr);
  assert.match(treatment.stdout, /"event":"export-refused"/u);
  assert.doesNotMatch(treatment.stderr, /"event":"uncaught"/u);
  assert.equal(existsSync(output), false, 'a refused export writes no partial snapshot');

  const normal = join(box.dir, 'normal snapshot');
  const result = JSON.parse(box.run(alpha.repo, 'view', '--export', normal, '--json'));
  assert.equal(result.path, normal);
  assert.ok(existsSync(join(normal, 'index.html')));
  assert.ok(existsSync(join(normal, 'view.css')));
  const listing = JSON.parse(readFileSync(join(normal, 'api/v1/boards.json'), 'utf8'));
  assert.equal(listing.boards.length, 1, 'a normal export still contains the readable project');
});
