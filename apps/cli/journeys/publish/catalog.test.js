/** The public, versioned JSON surface of every pullboard command (A1); the cases live in tests/fixtures/catalog/cases.js [#8843]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resultCommands } from '../../index.js';
import { JSON_SHAPES } from '../../../../packages/config/index.js';
import { catalogCases } from '../../tests/fixtures/catalog/cases.js';
import { covered } from '../../tests/fixtures/catalog/cases.js';
import { coveredRoots } from '../../tests/fixtures/catalog/cases.js';

test('[A1] every catalog command and subcommand has a real CLI exercise', { concurrency: true }, async (t) => {
  // Every private scenario finishes before the final catalog and root coverage assertions.
  const completed = await Promise.allSettled(catalogCases.map(({ name, run }) => t.test(name, run)));
  for (const result of completed) if (result.status === 'rejected') throw result.reason;

  const missing = Object.keys(JSON_SHAPES.commands).filter((key) => !covered.has(key));
  assert.deepEqual(missing, [], `add real-repo invocations for undocumented coverage gaps: ${missing.join(', ')}`);
  assert.deepEqual([...coveredRoots].sort(), resultCommands(), 'every actual root/factory command has an invocation');
});
