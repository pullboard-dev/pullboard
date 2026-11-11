/** Derived landing waiver reads; ordered waiver receipts retain their released shape [B3,R3,H16]. */
import { PERSON } from '../../../store/index.js';
import { landingBatches } from './batch/history.js';
import { landingWaiverCovers } from '../../../store/index.js';
import { landingWaiverKind } from '../../../store/index.js';

/** Read every person waiver, retaining expired entries as evidence [B3,R3]. */
export function landingWaivers(board, ports) {
  if (typeof ports?.quarantineWaivers !== 'function') throw new TypeError('landing waivers need the explicit quarantine reader');
  return board.db.prepare("SELECT event_by,event_detail FROM event WHERE event_kind = 'landing_waiver' ORDER BY event_id").all()
    .filter((row) => row.event_by === PERSON)
    .map((row) => JSON.parse(row.event_detail).waiver).concat(ports.quarantineWaivers(board)); // A proven flake's quarantine, when on [C7,D1].
}

/** Find a live person's waiver and derive its match kind without rewriting history [B3,R3,H16]. */
export function landingWaiverFor(board, failure, ports) {
  const waiver = landingWaivers(board, ports).findLast((entry) => Date.parse(entry.until) > board.clock.now().getTime()
    && landingWaiverCovers(entry, failure));
  return waiver ? { ...waiver, kind: waiver.kind ?? landingWaiverKind(waiver.test) } : null;
}

/** Validate a distinct waived landing proof without creating an ordinary gate stamp [B3,R3]. */
export function waivedLandingProof(board, tree, ports) {
  return landingBatches(board).findLast((batch) => ['ready', 'pushed', 'landed'].includes(batch.state)
    && batch.proof?.tree === tree && Array.isArray(batch.proof.failures) && batch.proof.failures.length > 0
    && batch.proof.failures.every((failure) => {
      const waiver = landingWaivers(board, ports).find((entry) => entry.id === failure.waiver);
      return waiver && Date.parse(waiver.until) > board.clock.now().getTime()
        && landingWaiverCovers(waiver, failure);
    })) ?? null;
}

