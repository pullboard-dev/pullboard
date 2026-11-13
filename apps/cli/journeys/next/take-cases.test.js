/** The take cases that run beside take.test.js so no file passes the per-file time budget [N2,V1,V2,B3,H16]. */
import { installPostMoveHandoffCases } from '../../tests/fixtures/cases/handoff.js';
import '../../tests/fixtures/next/take/cases.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { test } from 'node:test';
import { proveRequiredReviewFamily } from '../../tests/fixtures/family.js';
import { assertSpecCorrectionRefreezesCitations } from '../../tests/fixtures/refreeze.js';
import { assertSpecRefreezeReplay } from '../../tests/fixtures/refreeze.js';

test('an item required reviewer family is enforced by every dispatch path [V1,V2,B3,H16]',
  t => proveRequiredReviewFamily(t, { fixture, cli }));

test('a spec correction refreezes every unlanded citing item atomically [V2,H16]',
  t => assertSpecCorrectionRefreezesCitations(t));

test('spec correction refreezes replay atomically across imported prefixes [V2,H16]',
  t => assertSpecRefreezeReplay(t, { fixture, cli }));

installPostMoveHandoffCases({ fixture, cli });
