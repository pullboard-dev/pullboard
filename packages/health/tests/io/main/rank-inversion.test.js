/** A claim the coordinator reserved or held is not a rank inversion: the sentinel scan skips it [C7,#1479]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "../../../../../apps/cli/tests/fixtures/next/take.js";
import { cli } from "../../../../../apps/cli/tests/fixtures/next/take.js";
import { healthReport } from "../../../index.js";
import { reserveItem } from "../../../../store/index.js";

test("health.io-main-rank-inversion.reserved-or-held-claim-is-skipped: clause 1: healthReport raises no RANK_INVERSION for a live claim whose item has item_reservation_holder set or a hold reason, while the same board without either still raises it [C7,#1479]", async t => {
  const box = await fixture(t);
  const brief = file => `Files: web/${file}.js\nTest: the real board selects the eligible item and retains its ownership.`;
  const ahead = box.add("Ranks ahead and stays free", { brief: brief("ahead") });
  const claimed = box.add("Claimed behind it", { brief: brief("claimed") });
  const taken = await cli(box, box.seats.actor.path, ["claim", String(claimed)]);
  assert.equal(taken.code, 0, taken.out + taken.err);
  const scan = () => healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(), dispatchHealth: () => ({ findings: [] }) })
    .stuck.filter(row => row.cause === "RANK_INVERSION" && row.item === claimed);

  const control = scan();
  assert.equal(control.length, 1, "the control board raises the inversion");
  assert.equal(control[0].detail.ahead, ahead);

  reserveItem(box.board, claimed, { agentId: "coordinator", holder: box.seats.actor.id });
  assert.equal(scan().length, 0, "a coordinator reservation silences it");

  box.board.db.prepare("UPDATE item SET item_reservation_holder=NULL, item_reservation_by=NULL, item_reservation_at=NULL WHERE item_id=?").run(claimed);
  assert.equal(scan().length, 1, "clearing the reservation raises it again");

  box.board.db.prepare("UPDATE item SET item_hold_reason=? WHERE item_id=?").run("coordinator hold", claimed);
  assert.equal(scan().length, 0, "a coordinator hold silences it");
});
