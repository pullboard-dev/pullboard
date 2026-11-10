---
name: Flaky
about: Passes and fails on one commit
title: ""
labels: flaky
assignees: ""
---

The test that flips. How often. What it blocks.

```yaml
rows:
  - G1.2
env: <Node, OS, local changes>
version: "<pullboard --version>"
test: <test file> > <test name>
rate: 3/20
since: <first commit or version, if known>
cause: <why, if known>
blocks: <what it stops>
bar:
  - 1: <n>/<n> runs pass [measurement]
check:
  - 1: <command that runs the test <n> times>
```
