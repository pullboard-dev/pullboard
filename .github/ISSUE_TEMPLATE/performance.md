---
name: Performance
about: Slower or bigger than it should be
title: ""
labels: performance
assignees: ""
---

The thing that got slower or bigger. By how much. What it blocks.

```yaml
rows:
  - G1.2
env: <Node, OS, local changes>
version: "<pullboard --version>"
metric: <what is measured, with unit>
baseline: <number> at <commit>
measured: <number> at <commit>
since: <first commit or version, if known>
cause: <why, if known>
blocks: <what it stops>
bar:
  - 1: <threshold> [measurement]
check:
  - 1: <command that prints one number>
```
