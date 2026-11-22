# RFC 0016: Recursive governance

- Status: proposed, 21 November 2026. By Corey Olson.
- **Blocked on RFC 0012:** no approval until 0012 is accepted and its generated checks are built and measured.
- Depends on RFC 0012. Builds on RFC 0007 and draft rows E32-E42.
- Ids in brackets (GV1…) become spec rows with new ids on approval.

## Summary

Rules flow down linked boards, and verified evidence flows up.

1. **Parent:** a board's approved standing rules bind the boards linked below it.
2. **Child:** a child compiles those rules into its own bars.
3. **Promote:** a child's result rises only through authorized, verified evidence.

Why:
- A rule decided once needs no agent below to remember it.
- A child loosens a rule only by a signed, expiring waiver.
- The parent trusts evidence it verified, not the child's report.

## Motivation

- Work can span several boards: process, product and experiments.
- A change proven on one board is handed to another by hand.
- Experiments can run on scratch boards with no link back.

This RFC links them without widening what a link may carry.

## Design

| Design id | Existing rows |
|---|---|
| GV1 Link and offer | E32, E35, E40 |
| GV2 Inherited rules | E36, E37, E38, E42 |
| GV3 Evidence up | E33, E34, E42; SC20-SC25 |
| GV4 Depth | E36, E39, E41 |
| GV5 Records | E33, E34, E42, SC21, SC22; cross-record link is new |

### Link and offer [GV1]
- A board can start a child board for one objective.
- Starting, linking and offering work are separate moves.
- Linked per E32: approvers on both sides sign.
- The link names the rule set the child inherits.
- A signature counts only if its verified signer is authorized for that link and scope.
- **Offer (E35):** a parent offers an item downward.
- The child accepts it as a child item or declines with a reason. This is not E15's re-home.
- **Planning repo (E40):** its board may sit above team boards, with members from its writers.

### Inherited rules [GV2]
- The parent's approved standing rules in scope bind the child.
- This reads E36's "rule set" as standing rows, a proposed clarification of E36.
- Rules arrive as E38's signed, versioned bundle, verifiable offline.
- The bundle carries every ancestor's in-scope rules, with origin board and version.
- RFC 0012 CB8 treats a verified bundle row as approved.
- The child compiles them into its bars (RFC 0012).
- A new bundle version applies to later claims. A frozen bar does not change (V2).
- Each link pins its accepted bundle generation and refuses an older one.
- A bundle outside the link's freshness policy admits no claim or landing, even offline.
- A child can add rules.

**Waivers (E37)**
- A child loosens an inherited rule only by a signed, expiring waiver.
- An approver of the board that owns the rule signs a grant or revocation.
- Expiry or revocation stops new claims from compiling under the waiver.
- A bar frozen under a waiver stays as evidence, and its receipt names the waiver.
- It cannot land once the waiver expires or is revoked.
- The item restages against an approved current bar, then is re-proven and re-reviewed.

**Detach (E42)**
- One atomic move on one named link.
- The child keeps that link's inherited rules as local rules with provenance.
- Export through it stops. It stays as a historical record.
- Other links are unaffected.

### Evidence up [GV3]
- **Status sync** stays under E33 and E34: states, counts or nothing, never text.
- Status sync carries no receipt hashes.
- **Promotion** is a separate evidence transfer.
- The child's approver authorizes each one, including any artifact lookup.
- Without that transfer, promotion cannot use child proof. The parent proves the work.

Before reuse, the parent:
- verifies every signature, and that the person trusts the signer (SC23);
- recomputes the content hash from its own tree and checks its check inputs (SC22);
- requires a good local verdict. Imported proof skips no review (SC24).

Nothing lands by the child's word.

### Depth [GV4]
- Children can have children. Rules accumulate from all parents (E36, E41).
- A promotion climbs one level at a time.
- On a board with two parents, each promotion names the one signed link it uses.
- If inherited obligations conflict, affected work blocks until approvers decide.
- One common parent: its approver decides.
- Several: the nearest decides. A tie needs an approver from each.
- None: an approver from each board must approve (E39).
- Any waiver still needs the rule-owning board's approver.

### Records [GV5]
- Each board keeps its own record.
- A promotion may include an optional link to the child's record head. This link is new.
- It is used only under GV3's authorization, and its head is verified when used.
- A detached link is historical and carries nothing further.

## Limits
- A wrong parent rule is wrong everywhere below it.
- Inheritance spreads errors as well as structure.
- Every level adds a gate.
- None of this has been built or measured.

## Open questions
- Whether a child board is a lane, separate repo or hosted board (RFC 0006 R3, R41).
- How a parent retires a rule its children still depend on.
- Freshness policy values for offline claims and landings.
