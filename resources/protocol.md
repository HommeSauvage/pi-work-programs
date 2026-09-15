# Work programs — protocol

A **work program** is a multi-session initiative executed by agents, split into
numbered **cards**. The extension owns this protocol: it scaffolds programs,
drives the card pipeline, enforces review, records evidence, and merges card
lanes. The program folder holds the records; the extension holds the process.

## Structure

```
<program-dir>/<slug>/
  plan.md          the north star: context, decisions, phases, card index, rules
  progress.md      dated lab log — one line per event, bounded
  tasks/*.md       card files: the unit of work AND the unit of record
  .runtime/        machine state (gitignored): ledger, review texts
```

- `plan.md` must make sense with zero conversation history.
- Every card declares its dependencies explicitly. No card starts before its
  dependencies are `done`.
- Completed programs stay in the tree until the user explicitly closes them out.

## Card lifecycle

```
pending → ready → implementing → review_pending → reviewing → triaging
        → fixing → review_pending (next cycle) → done
        → blocked (escalated)
```

- The **worker** implements exactly the card's scope, runs the card's gates,
  appends an `## Evidence` section with exact command output and commit SHAs,
  sets `State: review`, and commits.
- The **reviewer** is a fresh, read-only second pass over the committed work.
  Review is mandatory: a card can never reach `done` without a completed review.
- Review findings are advisory. The orchestrator (session agent or card
  captain) approves, rejects, or defers each finding; approved findings are
  handed back to the **same worker** for a fix pass.
- Review/fix cycles are capped; on exhaustion the program asks for a decision
  instead of silently accepting or looping forever.

## Completion and close-out

- When every card is `done` (and the program gate, if configured, is green),
  the program completes: the work-program UI is cleared and the session agent
  receives a summary packet with per-card outcomes, review stats, and the
  record location.
- The agent replies with a completion summary and asks whether to close the
  program. Closing deletes the program folder and all card lanes; the git
  history keeps every commit.
- Close happens only on explicit operator confirmation
  (`work_program({ action: "close", remove: true })`). If the operator keeps
  talking or says no, the completed program stays quiet — records kept, no
  reactivation — until they say otherwise.
- `close` refuses while any card is not `done`. Closing is only for completed
  programs.

## Evidence

- Evidence is measured, never assumed. Paste exact command output; name the
  commit it was measured at.
- When gates are configured, the harness runs them and its result is
  authoritative; worker-pasted evidence is supplementary.
- A card is done only when its gate is green (or no gate applies) and its
  review has been triaged.

## Review profiles

Two profiles are available, verbatim from the operator's work-program prompts:

- `light` — the standard second pass (correctness, robustness, DRY, error
  handling, bugs, performance, quality, tests).
- `enhanced` — the full adversarial audit with priority levels, clean-code and
  fail-fast guidelines, and required human callouts.

The profile is chosen per program and may be overridden per card
(`Review: enhanced`).

## Parallel execution and lanes

- Ready cards run in parallel up to the program's parallelism limit.
- With `parallelExecution: worktrees` (default), every card gets a lane:
  a git worktree on its own branch, created from the program branch's current
  HEAD. The whole card lifecycle — implement, review, fix, gate — happens in
  the lane.
- Finished lanes enqueue for a strictly serialized merge-back into the program
  branch. Each merge is gated; conflicts go to a reconciler.
- With `parallelExecution: direct`, cards run in the program checkout itself.
  Writer cards are then serialized.
- Writers never touch `plan.md` or `progress.md`. The extension is the single
  writer of program records. Workers only touch their card's Evidence and
  `State: review` line.

## Log hygiene

`progress.md` records only: card outcomes, review verdicts, merge events,
structural plan edits, escalations, and decisions that outlive the session.
One line per event, no check-run detail (that lives in the card's Evidence),
bounded to roughly 500 lines.

## Human gates

Human gates declared in the plan (migrations, deploys, irreversible operations,
product decisions) are the one thing agents never resolve. The extension
surfaces them to the operator and holds the card until a human answers.
