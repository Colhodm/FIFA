# Working on this repo

## Landing changes
- **Always cut the landing branch fresh from `origin/main`.** This repo squash-merges PRs, so
  any branch that has been merged once will conflict with main forever after. This has burned
  four PRs (#10, #12, #16 refused; #12's failure was silently mistaken for a merge). Recipe:
  `git checkout -b <new> origin/main && git checkout <work-branch> -- . && commit`.
- **Verify a merge actually happened**: check `gh pr view N --json state` says `MERGED` and
  `origin/main`'s hash moved. `gh pr merge` can fail silently in scripts.
- Deploys go live from `main` via the Deploy workflow; verify with a headless load of
  https://colhodm.github.io/FIFA/ afterwards.

## Verification
- `npm run sim` — the deterministic harness (scripts/sim-harness.ts) is the authoritative
  check suite. All measurements live here; add one for any behavioural claim.
- The browser regression (/tmp/pwtest/regression.mjs in past sessions) runs twenty checks
  against ONE continuous live match. **It flakes when a check's window overlaps a goal
  celebration or kickoff** — disjoint single-check failures that pass on re-run (taps, arrow
  vectors, keeper-control windows). Needs an isolation pass; until then, re-run before
  believing a single failure, and never "fix" the game to appease one flaky run.
- Node >= 20.19 required (use the nvm v22 in ~/.nvm); dev server on :5173.

## Traps that have bitten measurement before (eight+ times)
- `activeId` defaults to roster index 0, and the Premier League rosters list the GOALKEEPER
  first. Any scenario must pin its subject explicitly (`world.activeId = me.id` every tick if
  the auto-switcher might move it).
- Whoever controls the ball is also its `lastTouch` — "owner differs from last toucher" can
  never be true.
- Consuming `world.rand()` in per-tick paths shifts every seeded scenario downstream.
- Simultaneous keyups land in one 16ms tick: modifiers must count `.released` too.
- Playwright keyups issued back-to-back arrive in the same event-loop turn — insert human
  latency when probing key combinations.

## Tuning
- Gameplay tunables hot-load from public/config/tuning.json (charge times, spreads, speeds).
- Attribute response curves are deliberately superlinear at the top; see dribbling `skill`.
