/** @pullboard-test-input source-tree */
/** The direct private check keeps its gate holder alive while its synchronous runner call blocks [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('runnerPrivateCheck wraps its blocking runOnRunner in the bounded out-of-loop heartbeat and always stops it [C7]', () => {
  const source = readFileSync(new URL('../apps/runner/src/shell/runner-private-check.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function runnerPrivateCheck(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const heartbeat = body.indexOf('keepHeartbeatWhileBlocked(lease, { timeoutMs: frozenCheckCeilingMs(policy.config) })');
  const run = body.indexOf('runOnRunner(root, command,');
  const stop = body.indexOf('finally { stopHeartbeat(); }');
  assert.ok(heartbeat > 0 && heartbeat < run && run < stop, 'the heartbeat starts before the blocking runner call and stops in its finally');
});
