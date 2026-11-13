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

`pullboard land` only batches items that passed the gate, so it cannot land this fix. Merge the item's candidate commit onto main yourself. The landing is the merge commit that `HEAD` points to after the merge, not the candidate sha, so read it and record that:

```
git merge --no-ff <candidate-sha>
git rev-parse HEAD
pullboard merged <id> <HEAD-sha> --forced "why the pipeline could not pass its own fix; the runner proof"
```

`<candidate-sha>` is the item's commit you proved on runners; `<HEAD-sha>` is the new merge commit that contains it.
`--forced` records the work as landed without a verify, and keeps your reason on the item.

Once the fix is on main, the pipeline passes ordinary work again.
