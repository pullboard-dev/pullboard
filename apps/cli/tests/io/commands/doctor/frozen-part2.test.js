/** Native row approval refreezes every unlanded citation [V2,V3,S19]. */
import { test } from 'node:test';
import { assertSpecCorrectionRefreezesCitations } from "../../../fixtures/refreeze.js";

test('cli.journeys-doctor-frozen.v2-v3-s19-native-row-approval: [V2,V3,S19] native row approval refreezes every unlanded citation', { timeout: 120_000 }, (t) => { // budget: hang ceiling for the real-Git citation fixture across open, claimed, submitted and verified states.
  assertSpecCorrectionRefreezesCitations(t);
});
