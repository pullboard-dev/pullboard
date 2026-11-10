/** GitHub refusals name a rate limit as one, never as lost repository access [H5,H16]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAuthHandler } from '../../index.js';
import { createGitHubClient } from '../../index.js';
import { githubFixture } from '../../../cli/tests/fixtures/relay.js';

test('a GitHub rate limit is named as one [H5,H16]', async (t) => {
  const fixture = await githubFixture(t);
  const reset = Math.floor(Date.now() / 1000) + 600;
  const limited = createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
    res.end('{"message":"API rate limit exceeded"}');
  });
  limited.listen(0, '127.0.0.1');
  await once(limited, 'listening');
  t.after(() => { limited.closeAllConnections(); limited.close(); });
  const lines = [];
  const user = { id: '7', login: 'fixture-user' };
  const rateLimited = createGitHubClient({ ...fixture.config, apiBase: 'http://127.0.0.1:' + limited.address().port, log: line => lines.push(line) });
  const resetAt = new Date(reset * 1000).toISOString();
  await assert.rejects(rateLimited.access(user, 'fixture/repository'), (error) => {
    assert.equal(error.code, 'GITHUB_RATE_LIMITED');
    assert.match(error.message, new RegExp(resetAt.replace(/[.]/g, '\\.')));
    return true;
  });
  const relay = createServer(createAuthHandler({ auth: { boardsFor: () => rateLimited.access(user, 'fixture/repository') }, publicOrigin: 'http://127.0.0.1' }));
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const answer = await fetch('http://127.0.0.1:' + relay.address().port + '/auth/boards');
  assert.equal(answer.status, 429);
  assert.equal((await answer.json()).error.code, 'GITHUB_RATE_LIMITED');
  assert.ok(lines.some(line => line.includes('403') && line.includes('x-ratelimit-remaining=0') && line.includes('x-ratelimit-reset=' + reset)), lines.join('\n'));

  fixture.state.installed = false;
  const real = createGitHubClient({ ...fixture.config, log: line => lines.push(line) });
  await assert.rejects(real.access(user, 'fixture/repository'), { code: 'NO_REPO_ACCESS' });
  assert.ok(lines.some(line => line.includes('404')), lines.join('\n'));
});
