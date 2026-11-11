/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  fixtureContextCpuCase,
  guiCpuPolicyCase,
  test,
} from '../../../tests/fixtures/scenarios/runners.js';

test('fixture context forwarding is not a CPU-load declaration [C7]', fixtureContextCpuCase);

test('a GUI test with no GUI runner stays local [C7]', guiCpuPolicyCase);
