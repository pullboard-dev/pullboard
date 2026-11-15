/** @pullboard-world-pin reads the package test sources to prove none imports the CLI child fixture. */
/** No package test imports the CLI app's child fixture, which only re-exports the gate's [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const STATIC_IMPORT = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"][^'"]*apps\/cli\/tests\/fixtures\/child\.js['"]/;

/** Named exceptions: tests in cells with no edge to gate, where repointing would add one (#8200); each leaves this list when its cell gains the edge. */
const CLI_SHIM_IMPORTERS = [
  'activity/tests/io/worktrees.test.js',
  'api/tests/io/artifacts.test.js',
  'api/tests/io/gate/companion-autofile.test.js',
  'api/tests/io/gate/detached.test.js',
  'api/tests/io/gate/ordered.test.js',
  'api/tests/io/gate/overtaken.test.js',
  'api/tests/io/gate/pull-settles.test.js',
  'api/tests/io/jobs.test.js',
  'api/tests/io/jobs/claim-order.test.js',
  'api/tests/io/jobs/requested.test.js',
  'api/tests/io/lease.test.js',
  'api/tests/io/progress.test.js',
  'api/tests/io/queue.test.js',
  'api/tests/io/state/kept.test.js',
  'api/tests/io/state/search.test.js',
  'commits/tests/contribution-clauses.test.js',
  'commits/tests/runner/scan/leak.test.js',
  'config/tests/io/compat.test.js',
  'config/tests/logic/settings/busy.test.js',
  'config/tests/logic/settings/comparison.test.js',
  'config/tests/logic/settings/controller-refused.test.js',
  'config/tests/logic/settings/dispatch.test.js',
  'config/tests/logic/settings/door.test.js',
  'config/tests/logic/settings/pilot.test.js',
  'config/tests/logic/settings/require-runner-attribution.test.js',
  'config/tests/submit/guards.test.js',
  'config/tests/submit/infra.test.js',
  'drive/tests/io/file/watchdog/tree.test.js',
  'drive/tests/io/prune.test.js',
  'drive/tests/io/pull/checkout.test.js',
  'drive/tests/io/pull/claims.test.js',
  'drive/tests/io/pull/handled.test.js',
  'drive/tests/io/pull/landing-ref.test.js',
  'drive/tests/io/pull/leftover-chrome.test.js',
  'drive/tests/io/pull/prune-chrome.test.js',
  'drive/tests/io/pull/workers.test.js',
  'drive/tests/io/queue.test.js',
  'drive/tests/offer-binding.test.js',
  'drive/tests/reuse.test.js',
  'drive/tests/scaled.test.js',
  'gate/tests/io/static/style.test.js',
  'git/tests/io/adapter.test.js',
  'git/tests/io/definition.test.js',
  'git/tests/io/journey-contract.test.js',
  'git/tests/io/memo-revs.test.js',
  'git/tests/io/memo.test.js',
  'items/tests/logic/submit/preflight.test.js',
  'items/tests/way.test.js',
  'jobs/tests/io/launch.test.js',
  'jobs/tests/logic/panel.test.js',
  'kernel/tests/logic/seal.test.js',
  'link/tests/io/relay/canary/needs.test.js',
  'link/tests/logic/relay/poll.test.js',
  'merge/tests/logic/carriage.test.js',
  'moves/tests/io/table/backbone-replay.test.js',
  'moves/tests/io/table/read.test.js',
  'moves/tests/io/table/report.test.js',
  'moves/tests/logic/moves/reserveNextReview/durable.test.js',
  'outbox/tests/io/relay.test.js',
  'pin/tests/io/keyed.test.js',
  'pin/tests/io/main.test.js',
  'runners/tests/io/pull/exclusive-timing.test.js',
  'sandbox/tests/io/trusted/policy/ancestry.test.js',
  'seats/tests/io/projects.test.js',
  'seats/tests/registry.test.js',
  'sentinels/tests/io/serve-cli.test.js',
  'sentinels/tests/io/waits.test.js',
  'spec/tests/io/draft-writes.test.js',
  'spec/tests/io/signature.test.js',
  'stats/tests/allowance.test.js',
  'stats/tests/io/cost/session.test.js',
  'stats/tests/logic/pipeline/ledger.test.js',
  'store/tests/io/board/ahead.test.js',
  'sync/tests/io/large.test.js',
  'sync/tests/io/local.test.js',
  'transport/tests/io/main.test.js',
  'transport/tests/io/pull-board.test.js',
  'transport/tests/io/pull-restart.test.js',
  'transport/tests/io/ssh.test.js',
  'verify/tests/io/evidence.test.js',
  'verify/tests/logic/advance.test.js',
];

test('clause 1: no package test imports the CLI app child fixture [C7]', () => {
  const offenders = readdirSync(join(ROOT, 'packages'), { recursive: true })
    .filter((name) => /\.test\.m?js$/.test(name) && !name.split('/').includes('node_modules'))
    .filter((name) => !CLI_SHIM_IMPORTERS.includes(name))
    .filter((name) => STATIC_IMPORT.test(readFileSync(join(ROOT, 'packages', name), 'utf8')));
  assert.deepEqual(offenders, [], 'package tests import packages/gate/tests/fixtures/child.js directly');
});

test('every named exception still imports the CLI child fixture [C7]', () => {
  const stale = CLI_SHIM_IMPORTERS.filter((name) => !STATIC_IMPORT.test(readFileSync(join(ROOT, 'packages', name), 'utf8')));
  assert.deepEqual(stale, [], 'remove an exception once its test is repointed');
});

test('the import pattern catches one-line and multi-line forms [C7]', () => {
  const child = ['apps', 'cli', 'tests', 'fixtures', 'child.js'].join('/');
  assert.match(`import { a } from '../../${child}';`, STATIC_IMPORT);
  assert.match(`import {\n  a,\n  b,\n} from '../../../${child}';`, STATIC_IMPORT);
  assert.doesNotMatch("import { a } from '../../gate/tests/fixtures/child.js';", STATIC_IMPORT);
});
