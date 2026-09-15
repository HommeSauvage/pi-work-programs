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

## Reshaping the program

Cards can be folded, added, or dropped without hand-editing the ledger. The
plan and card files stay the source of truth; `sync` reconciles.

- **Folding cards** (e.g. 9 cards down to 5): move the scope into the surviving
  card files, rewire `Depends on:` so nothing points at a card you are deleting,
  delete the dead files and their plan rows, then run
  `work_program({ action: "sync" })`.
- Sync drops a removed card when it is safe: no live dependents, no live run,
  and no lane holding work. An empty lane is cleaned up (worktree removed,
  branch deleted).
- Anything unsafe is **kept and explained** instead: a done card is a record and
  is never dropped, a card with live dependents lists them (rewire first), a
  card with a run is owned by it, and a lane holding work points at its path for
  inspection or an explicit `abandon`.
- **Dropping an unfinished card** deliberately: `work_program({ action:
  "unblock", card: "NN", resolution: "abandon" })`. Abandon is terminal but not
  destructive — the branch is kept for inspection, the record stays, and the
  card stops counting against completion. It refuses while live cards still
  depend on it, while a run owns it, or when its lane has uncommitted work.
  `redispatch` re-adopts an abandoned card.
- Abandoned cards show as `✕` on the board and are listed as dropped in the
  completion summary, so dropped scope is recorded rather than hand-waved.

## Operator todos

- Some work needs human hands (credentials, external approvals, secrets,
  physical access). Park it in `.operator/todo.md` at the repository root
  instead of guessing or stalling.
- The extension creates the file with its header the first time a program
  activates or a worker dispatches; the header's rules bind every writer:
  append-only, one `## <stream>` heading per work stream (work programs use
  their slug), items in the file's format naming the program and card, exact
  commands for every runnable step.
- Worker, fix, gate-fix, and captain prompts all carry this rule. Reviewers
  are read-only and never touch the file.
- Operator edits never pause the merge queue, and open todos never block
  completion — they are listed in `status`/`doctor`, the session brief, and
  the completion summary instead.

## Pause and resume

- Soft pause (default) halts the loop without touching running agents: no new
  workers, reviewers, fixes, or merges are dispatched, in-flight runs keep
  going, and their results reconcile on resume.
- Hard pause stops every in-flight run immediately, then rearms its card so
  resume restarts cleanly (implementing → pending for a fresh worker,
  reviewing → pending review, fixing keeps its fix intent, an open merge is
  reconciled again from the preserved tree). A run that cannot be stopped is
  left running untouched and reconciles on resume.
- Both modes are recorded in `progress.md` (what was stopped, what was
  rearmed); resume logs its own line and restarts the drive.

## Evidence

- Evidence is measured, never assumed. Paste exact command output; name the
  commit it was measured at.
- When gates are configured, the harness runs them and its result is
  authoritative; worker-pasted evidence is supplementary.
- A card is done only when its gate is green (or no gate applies) and its
  review has been triaged.

## Provider quota

- A run that dies on a provider quota/rate-limit error is **held**, not
  escalated: the card is rearmed and parked until the reset time reported in
  the error (plus a minute of slack), with a `progress.md` line naming the
  parsed delay and the error it came from (e.g. `held until 13:42 UTC · quota
  exhausted — parsed "1hr 27min" from: GoUsageLimitError: 5-hour usage limit
  reached. Resets in 1hr 27min`). No decision packet, no re-dispatch: one
  exhausted window no longer asks the supervisor seven times.
- Held cards show in `status` as `held until HH:MM UTC (…)`. When the hold
  expires the drive dispatches them again on its own.
- A repeat quota failure extends the hold (`still exhausted, extended (hold
  n/3)`) rather than escalating to a decision whose only useful answer is
  "wait". Past the extension cap the card blocks with the reset time named.
- An individual hold is capped at 90 minutes; a quota error with **no**
  parseable reset delay blocks as before, quoting the raw error.

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
