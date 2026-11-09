# Security

**Report vulnerabilities privately.** Use this repository's Security tab ("Report a vulnerability"). Never use a public issue or PR. The gate hides a public report that looks like one.

## How to report

Run the `pullboard-contribute` skill; it writes a Security record and sends it privately. By hand, use this shape:

> 2-3 short sentences: what's exposed, to whom, how bad.

```yaml
rows: [<spec rows, if known>]
env: <Node, OS>
version: "<version>"
ran: <steps or command>
cause: <if known>
impact: <what an attacker gains; who is exposed>
disclose: <date it may go public; 90 days by default>
bar:
  1: <the attack is refused> [test]
check:
  1: <test file> > <test name>
```

## What happens

- We aim to reply within 7 days.
- We fix it privately and credit you, unless you'd rather not be named.
- It goes public on the `disclose` date, or when the fix ships, whichever comes first.
