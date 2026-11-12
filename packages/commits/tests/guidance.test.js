/** Installed guidance makes the board’s recorded checks and verdict the proof [I1,I3,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAgentsBlock } from "../../config/index.js";
import {
  HOOKS,
  hookScript,
} from "../index.js";

/** Inspect the exact bytes the installer writes (installHooks writes hookScript) so template names alone cannot stand in for them. */
function boardProofGuidance(text, surface) {
  assert.match(text, /the frozen check, the gate and the verifier[’']s verdict are the proof/iu,
    `${surface} names the board’s three proof decisions`);
  assert.match(text, /(?:do not|never) (?:keep|create) (?:private )?evidence folders, packets, manifests or custody rules/iu,
    `${surface} forbids an agent’s separate proof collection`);
  assert.match(text, /cite the board[’']s receipts/iu, `${surface} points to the board’s receipts`);
  assert.doesNotMatch(text, /Keep both commands, both commits and both outputs as the evidence/u,
    `${surface} cannot also prescribe an agent-owned evidence collection`);
  assert.doesNotMatch(text, /test the criterion itself, with the strongest proof you can get/u,
    `${surface} cannot also demand an undefined proof system beyond the bar`);
}

test('the guidance names the gate and the verdict as the proof and forbids private evidence folders [I1,I3,V4]', () => {
  boardProofGuidance(renderAgentsBlock({}, ''), 'generated AGENTS');
  for (const hook of HOOKS) {
    boardProofGuidance(hookScript(hook), `installed ${hook} hook`);
  }
});
