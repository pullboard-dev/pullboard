---
name: Bug
about: Something broke
title: ""
labels: bug
assignees: ""
---

The command or file that broke. Why it matters. What it blocks.

```yaml
rows:
  - G1.2
env: <Node, OS, local changes>
version: "<pullboard --version>"
ran: <the command you ran>
cause: <why, if known>
blocks: <what it stops>
forbidden:
  - <fix you ruled out>
compat:
  - <what must keep working>
bar:
  - 1: <what must hold once fixed> [test]
check:
  - 1: <test file> > <test name>
refusal: |
  <exact refusal or error text>
```
