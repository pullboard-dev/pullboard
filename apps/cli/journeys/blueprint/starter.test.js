/** @pullboard-test-input source-tree */
import { test } from 'node:test';
import { freshBoard } from '../../tests/fixtures/blueprint.js';
import { json } from '../../tests/fixtures/blueprint.js';
import { emptyRepo } from '../../tests/fixtures/blueprint.js';
import { assertStarterChecks } from '../../tests/fixtures/blueprint/starter.js';

test("clause 1: every bundled blueprint's starter check runs from its lane's folder and a baseline never reads green for a command that fails on main [I1,V2]", () => assertStarterChecks({ emptyRepo, freshBoard, json }));
