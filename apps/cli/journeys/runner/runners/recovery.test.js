/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: the real pinned-worker probe that recovers after one failure; the installer and hold cases run in their own files. */
import {
  runnerProbeRecoveryTests,
} from '../../../tests/fixtures/scenarios/runners.js';

runnerProbeRecoveryTests([1]);
