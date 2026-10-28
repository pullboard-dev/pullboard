/** Canonical process-local providers for direct private landing components, matching the actual higher CLI roots. */
import { badgeCounts } from '../src/badge.js';
import { writeBadges } from '../src/badge.js';
import { flakeSource } from '../src/native-flakes.js';
import { observeNativeFailure } from '../src/native-flakes.js';
import { quarantineWaivers } from '../src/quarantine.js';
import { parseProcessCensus } from '../src/process-census.js';

export const landingPorts = Object.freeze({ badgeCounts, writeBadges, flakeSource, observeNativeFailure, quarantineWaivers, parseProcessCensus });
