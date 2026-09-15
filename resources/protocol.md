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
- Review/fix cycles are capped (default **3**); on exhaustion the program asks
  for a decision instead of silently accepting or looping forever. The only
  answers are `accept` and `block` — there is no "one more round". `accept`
  lands the card and records every finding that was approved and never fixed
  into the card (`## Accepted findings (approved at the review-cycle cap,
  carried unfixed)`) plus a `progress.md` line, so accepting cannot silently
  drop real debt into a merge. `block` parks the card for a human.

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

## Retries, blips, and already-committed lanes

- A run that dies on a **provider/runner blip** (runner-startup control
  timeouts, RPC/socket errors, 502/503/504, "admission is unavailable",
  overloaded/capacity outages) is retried in place up to 2 times on the same
  phase — the card is rearmed (`reviewing`→`review_pending`,
  `implementing`→`pending`, …) and the retry dispatches in the same tick. Past
  the cap it blocks loudly with the provider's error text. A provider quota
  error with a reset hint is **held** instead (see Provider quota).
- A **review-run failure never re-dispatches an implementation worker**:
  redispatch honors the phase the card blocked from, so a dead reviewer
  re-enters review.
- A card whose lane **already carries the committed work** (lane ahead of base
  and the card record still says `State: review`) skips the worker entirely and
  goes straight to review — that also prevents the loop where pi-subagents
  hard-fails a worker for making no edits on already-finished work. If such a
  worker does fail the no-edit guard, the failure is salvaged the same way
  (validation-complete) when the lane has commits.

## Retuning a running program

- The orchestrator can change program behaviour mid-flight instead of working
  around it: `work_program({ action: "config", maxCycles, onExhausted,
  reviewProfile, maxParallel, parallelExecution, mode, workerModel,
  workerThinking, reviewerModel, reviewerThinking })`.
- `maxCycles` is **review cycles before the harness asks** (default 3). Setting
  it low does not silence the question — it makes the question arrive sooner.
  The question is binary: `accept` (land it, with the unfixed findings recorded
  on the card) or `block` (park it). Extra review rounds are deliberately not
  offerable.
- `onExhausted` pre-answers the question: `"accept"` approves exhausted cards —
  recording their unfixed findings — and resolves any **open** cycle decisions
  in the same call; `"block"` pre-answers with a park; `"ask"` (default) raises
  the decision.
- The change applies to the live ledger, is written back into `plan.md`'s
  machine comment (so `sync` and session reload keep it), and lands in
  `progress.md` as `config updated — maxCycles 3→2`.
- `mode` is still refused while runs are in flight (pause first); every other
  knob applies immediately.
- Card **scope** is reshaped through the files, not through this action: edit
  the card/plan text (fold, rewire `Depends on:`, delete or add cards) and run
  `sync` — see Reshaping the program.

## Drive and scheduling

- The drive is event-driven (session start, run completions, operator actions)
  **and** ticks on a 20-second safety timer while a program is active, so a
  missed event can never freeze a live program with a healthy-looking board.
- One tick drains until quiescent: a merge that frees dependencies dispatches
  the dependent cards in the same tick, and the merge queue drains instead of
  advancing one card per event.
- `start` on the already-loaded program means "get moving" and behaves as
  `resume`; asking to start a *different* program names the loaded one and how
  to switch.
- Legacy tombstones (cards abandoned before the `abandoned` flag existed, i.e.
  `blocked` with "abandoned by operator") count as dropped scope: they do not
  block completion, and `sync` removes them when they hold no lane and no live
  dependents.

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
