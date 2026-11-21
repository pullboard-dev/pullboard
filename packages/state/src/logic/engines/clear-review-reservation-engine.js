/** The coordinator may clear a held review reservation and end its review lease; boards below this engine never record that clear, so older replays agree [C7]. */
export const CLEAR_REVIEW_RESERVATION_ENGINE = 282;
