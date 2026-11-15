# Contributing

Pullboard aims to help more people start businesses, make projects and think like entrepreneurs. Thanks for helping build it. MIT-licensed.

## How

1. **Install:** `npm i -g pullboard`
2. **Write:** a record in the shape below. Your agent can write it from the issue template.
3. **Send:** once `pullboard contribute check <file>` passes. CI checks again.

Every issue and PR is a record: 2-3 sentences, then YAML. Required. Spec: [RFC 0009](docs/rfcs/0009-contribution-records.md).

> On Windows, `pullboard next` opens a second seat in a lane worktree. The tour stops at step 3.

```yaml
rows: [N2]
env: Node 22.13, Windows 11
version: "0.9.3"
ran: pullboard next
blocks: pullboard tour on Windows
bar:
  - 1: next in a lane worktree reuses its seat [test]
check:
  - 1: <test file> > <test name>
```

| Shape | For |
|---|---|
| Bug | Something broke |
| Ask | Question or feature |
| Flaky | Passes and fails on one commit |
| Performance | Slower or bigger |
| Fix | A PR that fixes or adds |
| Proposal | A PR changing `SPEC.md` rows; the owner approves rows |
| Security | Private: [SECURITY.md](SECURITY.md) |

- **Title:** the outcome.
- **Summary:** ≤3 sentences, ≤20 words each.
- **Never cut:** `forbidden`, `compat`, `status`.
- **Bar:** a check per clause. `[test]` fails on main; `[test, kept]` passes on both.
- **Leave out:** what the diff or gate shows.
- **Big change:** open an issue first. Large PRs may be split.
- **Code:** plain JavaScript, ES modules, Node 22.13+, no new dependencies, match the style.
- **AI-assisted:** fine. You're responsible for it.
- **Ideas:** Pullboard may use ideas from issues freely, with no obligation.

## CLA

- **Sign:** once, by commenting on your first PR: `I have read CLA.md and I agree to it.`
- **Ownership:** you keep it.
- **License:** permanent; Pullboard may use, change, distribute and relicense it; patents included.
- **Origin:** your own work, or you may contribute it.
- **Full text:** [CLA.md](CLA.md), per the Apache Individual CLA v2.2. Pullboard stays MIT.

## After you submit

1. **Reply:** within 7 days (an aim).
2. **Board:** accepted records become items; the issue closes with a link.
3. **Review:** a second reviewer checks your commit. The owner reviews sensitive areas.
4. **Pass:** lands on `main`, credited to you; co-author if we adjusted it. The PR shows merged, or closes with a link.
5. **Fail:** we comment what failed. Update and resubmit.

We may edit, combine, reimplement or decline, with a reason.

## Labels

- `bug`, `feature`, `question`, `docs`
- `needs-format`: check fails; out of triage until fixed.
- `clarify`: closes after 14 days without a reply. Reply to reopen.

## Sensitive areas

These need the owner's approval:
- relay and sealing;
- signing and keys;
- person-only moves;
- git hooks and verification rules;
- the contribution gate, CI and runners.

## Conduct

[Code of Conduct](CODE_OF_CONDUCT.md)
