Every PR is a record: 2-3 sentences, then YAML. Keep one section, delete the other.
Spec: [RFC 0009](../docs/rfcs/0009-contribution-records.md).
Sign the CLA once on your pullboard.dev contributor profile.

## Fix

The thing it changes. Why. What it unblocks.

```yaml
rows:
  - G1.2
refs:
  - 42
draft: false
forbidden:
  - <fix you ruled out>
compat:
  - <what must keep working>
status: not_run
bar:
  - 1: <what must hold> [test]
check:
  - 1: <test file> > <test name>
evidence:
  - 1: <result, for a clause the gate cannot run>
```

## Proposal

The rows it adds or changes. Why. The call needed.

```yaml
rows:
  - G1.2
conflicts_with:
  - G1.3
decision_needed: <the call the owner must make>
draft: true
status: not_claimed
bar:
  - 1: <what the spec change must hold> [command]
check:
  - 1: <command>
later_bar:
  - 1: <what the implementation must prove>
```
