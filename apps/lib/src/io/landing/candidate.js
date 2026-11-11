#!/usr/bin/env node
/** Compose only trusted checker services before the original speculative candidate IPC entry [B3,V4,Q1,Q3]. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landingCandidateEntry } from '../../../../../packages/landing/index.js';
const FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === FILE && process.argv[2] === 'candidate' && process.send) {
  const { openBoardForRead } = await import('../../../index.js');
  const { checkAtCommit } = await import('../../../../runner/index.js');
  const { badgeCounts, writeBadges } = await import('../../../../view/index.js');
  const { flakeLedger } = await import('../../../../../packages/flakes/index.js');
  const { flakeSource, observeNativeFailure } = await import('../../../../../packages/flakes/index.js');
  const { landingFlakeRatchet } = await import('../../../../../packages/flakes/index.js');
  const { quarantineWaivers, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns } = await import('../../../../../packages/flakes/index.js');
  const { parseProcessCensus } = await import('../../../../../packages/kernel/index.js');
  landingCandidateEntry({ checkAtCommit, openBoardForRead, landingPorts: { badgeCounts, writeBadges, flakeLedger, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns, landingFlakeRatchet } });
}
