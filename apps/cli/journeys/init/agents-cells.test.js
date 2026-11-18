/** The AGENTS block init writes names docs/cells.md only when the project's doctrine carries PB13 [N26,#8819]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/init/ignore-box.js';

const ROW = '- PB13 [approved, aim] Code is arranged in cells; docs/cells.md maps them.\n';

/** Init a fixture project whose doctrine file holds the given extra text and read the AGENTS block it wrote. */
async function agentsAfterInit(t, extra) {
  const box = fixture(t);
  rmSync(join(box.root, 'pullboard.json'));
  writeFileSync(join(box.root, 'DOCTRINE.md'), `# Doctrine\n\n## P · Git and the gate\n${extra}`);
  const initialized = await box.output('init');
  assert.equal(initialized.code, 0, initialized.stderr);
  return readFileSync(join(box.root, 'AGENTS.md'), 'utf8');
}

test('cli.journeys-init-agents-cells.the-agents-block-init-writes-names: clause 1: the AGENTS block init writes names docs/cells.md when PB13 is in the project doctrine [N26,#8819]', async t => {
  const agents = await agentsAfterInit(t, ROW);
  assert.match(agents, /^## Pullboard$/mu);
  assert.match(agents, /docs\/cells\.md/u);
});

test('cli.journeys-init-agents-cells.the-agents-block-omits-docs-cells: clause 2: the AGENTS block omits docs/cells.md when PB13 is absent from the project doctrine [N26,#8819]', async t => {
  const agents = await agentsAfterInit(t, '- P1 [approved, must] Keep commits small.\n');
  assert.match(agents, /^## Pullboard$/mu);
  assert.doesNotMatch(agents, /docs\/cells\.md/u);
});
