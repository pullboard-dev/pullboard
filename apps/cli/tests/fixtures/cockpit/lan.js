/** Own one private LAN view process without logging its pairing link [H19,C7]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { BIN } from './harness.js';

/** Start the actual CLI, register cleanup before startup, and keep its private link in memory. */
export async function startLanView(t, box) {
  const child = spawn(process.execPath, [BIN, 'view', '--lan', '--no-open', '--port', '0'], {
    cwd: box.dir, env: { ...box.env, PULLBOARD_VIEW_FOREGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stopped;
  /** Stop only the process this fixture started, including a failed startup. */
  const stop = () => stopped ??= new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once('close', done);
    child.kill('SIGTERM');
  });
  t.after(stop);
  return await new Promise((resolve, reject) => {
    let output = '', failure = '';
    const timer = setTimeout(() => { // budget: hang ceiling covers the CLI's 30s registry lock plus 5s for startup.
      void stop(); reject(new Error('the LAN view did not print its link before the startup deadline'));
    }, 35_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', part => { failure += part; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => {
      output += part;
      const match = /Pullboard view: (http:\/\/[^\s]+\/\?k=[^\s]+)/u.exec(output);
      if (!match) return;
      clearTimeout(timer);
      const link = new URL(match[1]);
      resolve({ link, base: link.origin, key: link.searchParams.get('k'), stop });
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('the LAN view process could not start')); });
    child.once('exit', code => {
      clearTimeout(timer);
      // Startup errors may contain a private link; report only the typed refusal or an option error.
      const reason = /\[([A-Z_]+)\]/u.exec(failure)?.[1]
        ?? (/Unknown option/u.test(failure) ? 'unknown CLI option' : 'unclassified startup failure');
      reject(new Error(`the LAN view exited before startup (${code}; ${reason})`));
    });
  });
}

/** A real HTTP request with an explicit Host, so a refusal cannot be confused with DNS failure. */
export async function lanBoundaryReply(view, path, headers = {}) {
  const { request } = await import('node:http');
  return await new Promise((resolve, reject) => {
    const call = request(new URL(path, view.base), { headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    call.once('error', reject);
    call.setTimeout(10_000, () => call.destroy(new Error('the LAN boundary request did not finish'))); // budget: bounded refusal hang ceiling.
    call.end();
  });
}

/** Refusals must carry neither a board title nor the secret needed to open its view. */
export function assertLanRefusal(reply, view, title) {
  assert.ok([401, 403].includes(reply.status), 'an unauthenticated or foreign-origin request is refused');
  assert.equal(reply.body.includes(title), false, 'the refusal contains no board data');
  assert.equal(reply.body.includes(view.key), false, 'the refusal contains no pairing secret');
}
