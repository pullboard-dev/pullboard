/** The SSH stand-in lives beside the gate's fixtures, so package tests use it without importing the CLI app; app tests reach it here [C7,O5]. */
import { HOST } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';
export * from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';
export const SSH_STAND_IN_HOST = HOST;
