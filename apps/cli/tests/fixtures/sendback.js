/** The cockpit send-back test's setup: a submitted item in a fresh machine, and the board state read after a send-back [C7,U149]. */
import { buildLocal } from './cockpit/harness.js';
import { machine } from './cockpit/harness.js';
import { project } from './cockpit/harness.js';
import { fileFixtureItem } from '../../../../packages/gate/tests/fixtures/testkit.js';

export const NOTE = 'the page needs a greeting';

/** A submitted item #1 in a fresh machine, so each path sends back an identical board. */
export async function submitted() {
  const box = machine();
  const demo = project(box, 'demo');
  // The machine's inProcess returns stdout and refuses a non-zero status, so it is shaped as the testkit's result.
  await fileFixtureItem(box, demo.repo, { lane: 'web', title: 'Greeting', criterion: 'greets', args: ['--specs', 'G1'], run: async (cwd, ...args) => ({ status: 0, stdout: await box.inProcess(cwd, ...args) }) });
  await buildLocal(box, demo, 1, 'greeting.html', { queued: true });
  box.settled(demo.repo, 1);
  return { box, demo };
}

/** The item as the board shows it after the send-back: its settled state and whether the reject note reached it, without ids, times or paths. */
export async function afterwards({ box, demo }) {
  const shown = await box.inProcess(demo.repo, 'show', '1', '--json');
  const item = JSON.parse(shown);
  return { status: item.item_status, title: item.item_title, builtBy: item.item_built_by, criterion: item.item_criterion, noted: shown.includes(NOTE) };
}
