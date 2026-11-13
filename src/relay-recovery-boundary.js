/** Keep actual native relay and reentrant outbox exclusion through the entire operator recovery [H16,H21]. */
import { locked } from './relay-lock.js';
import { withOutboxGuard } from './relay-outbox-guard.js';

/** Nested helper guard entries share this module's real owner; no recursive relay lock or inode replacement. */
export function withLocalRecoveryBoundary(file, work, io) {
  return locked(file, () => withOutboxGuard(file, work), io);
}
