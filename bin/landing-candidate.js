#!/usr/bin/env node
/** Compose only trusted checker services before the original speculative candidate IPC entry [B3,V4,Q1,Q3]. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landingCandidateEntry } from '../src/landing-candidates.js';
const FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === FILE && process.argv[2] === 'candidate' && process.send) {
  const { openBoardForRead } = await import('../src/native-board.js');
  const { checkAtCommit } = await import('../src/runner-private-check.js');
  const { badgeCounts, writeBadges } = await import('../src/badge.js');
  const { flakeLedger } = await import('../src/flakes.js');
  const { flakeSource, observeNativeFailure } = await import('../src/native-flakes.js');
  const { quarantineWaivers, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns } = await import('../src/quarantine.js');
  const { parseProcessCensus } = await import('../packages/kernel/src/core/process-census.js');
  landingCandidateEntry({ checkAtCommit, openBoardForRead, landingPorts: { badgeCounts, writeBadges, flakeLedger, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus, quarantineVerdictSnapshot, validateQuarantineGate, validateQuarantineLandingProof, gateRuns } });
}
