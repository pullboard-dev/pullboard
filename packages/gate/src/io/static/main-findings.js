/** The static findings main itself has, from one run of the static command in a throwaway checkout at main's commit [C7,#10449]. */
import { runProfiledShellAsync } from '../execution.js';
import { staticFindings } from '../../logic/static/findings.js';

/**
 * Run the project's static command in a temporary checkout at `mainCommit` and return the findings of its output.
 * Why: an item's static red that main also has is main's own, so the remainder step needs main's list from a real run [C7,#10449].
 * The checkout comes from the one main-checkout helper (the caller passes the landing cell's `withMainCheckout`, as test runs do),
 * which removes it afterwards even when the run throws.
 * @param {string} root The repository whose object store holds `mainCommit`.
 * @param {{ staticChecks?: string }} config The accepted config; its `staticChecks` is the command.
 * @param {string} mainCommit Main's commit.
 * @param {{ withMainCheckout: Function, runCommand?: Function }} services `runCommand(checkout, command)` returns `{ output }`; it defaults to the gate's shell runner.
 * @returns {Promise<{ rule: string, file: string }[]>} The findings, empty for a green run; rejects when the checkout is unavailable.
 */
export async function staticFindingsOnMain(root, config, mainCommit, { withMainCheckout, runCommand = (checkout, command) => runProfiledShellAsync(checkout, command, { readOnlyGit: true }) } = {}) {
  const command = config.staticChecks?.trim();
  if (!command) return [];
  if (typeof withMainCheckout !== 'function') throw new TypeError('a main static run needs the main checkout helper');
  const found = await withMainCheckout(root, mainCommit, async checkout => ({ output: (await runCommand(checkout, command))?.output ?? '' }));
  if (found?.unavailable) throw new Error(`main's static findings are unavailable: ${found.unavailable}`);
  return staticFindings(found.output);
}
