# When the pipeline cannot pass its own fix

Sometimes the gate, review or landing is broken, and the only fix is a change that the broken pipeline cannot pass. This page is the one tested way out.

## When it applies

Use it only when the pipeline cannot pass its own fix: a fix to the gate, review or landing keeps going red or stalling because of the very fault it repairs. If an ordinary resubmit can pass, do that instead.

## The person decides

The person decides, every time. It is never an agent's routine. An agent that thinks the path applies stops and asks:

```
pullboard escalate <id> --note "what was tried"
```

## Prove the fix on runners

Run every test that imports a changed module on a runner, against main:

```
pullboard test --compare-main --wait <files>
```

Reds that main also has are not yours. Any new red blocks the landing.

## Land it by hand

Land the named item at its commit. This uses the same merge and records the same receipts as the automatic lander. Look first:

```
pullboard land --items <id> --commit <sha> --dry-run
pullboard land --items <id> --commit <sha>
```

Then record why the pipeline could not pass it:

```
pullboard escalate <id> --note "why the pipeline could not pass its own fix; the runner proof"
```

Once the fix is on main, the pipeline passes ordinary work again.
