import { landingFlakeRatchet } from '../../../../../packages/flakes/index.js';
import { flakeLedger } from '../../../../../packages/flakes/index.js';
/** Canonical process-local providers for direct private landing components, matching the actual higher CLI roots. */
import { badgeCounts } from '../../../../view/index.js';
import { writeBadges } from '../../../../view/index.js';
import { flakeSource } from '../../../../../packages/flakes/index.js';
import { observeNativeFailure } from '../../../../../packages/flakes/index.js';
import {
  quarantineWaivers,
  quarantineVerdictSnapshot,
  validateQuarantineGate,
  validateQuarantineLandingProof,
  gateRuns,
} from '../../../../../packages/flakes/index.js';
import { parseProcessCensus } from '../../../../../packages/kernel/light.js';

export const landingPorts = Object.freeze({ badgeCounts, writeBadges, flakeLedger, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns, landingFlakeRatchet });
