/** Test-fixture entry to the injectable Git adapter, kept out of the runner worker's import closure [C7]. */
import { adapters } from './adapter.js';
import { needAdapter } from './adapter.js';
import { realGitAdapter } from './adapter.js';
import { selections } from './adapter.js';

/**
 * Select an implementation for the rest of the current async chain, for a test fixture that cannot wrap the test body.
 *
 * Why: a fixture runs inside the test function, so `withGitAdapter`'s callback shape is out of reach; node:test runs each
 * test in its own async scope, so the choice ends with that test. An audit still forces real Git.
 */
export function enterGitAdapter(adapter) {
  needAdapter(adapter);
  const forced = selections.getStore()?.audit || process.env.PULLBOARD_ADAPTER_AUDIT === '1';
  adapters.enterWith(forced ? realGitAdapter : adapter);
}
