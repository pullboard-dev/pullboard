/** The legacy-quarantine and structured-outcome journeys, and the native same-tree quarantine journey with its slow 20-pass driver, sharing the quarantine fixture [C7,H16]. */
import { defineLegacyQuarantineCase } from '../../../fixtures/cases/quarantine.js';
import { defineNativeQuarantineCase } from '../../../fixtures/cases/quarantine.js';
import { defineOutcomeCases } from '../../../fixtures/cases/quarantine.js';

defineLegacyQuarantineCase();
defineOutcomeCases();

defineNativeQuarantineCase();
