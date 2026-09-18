# Work programs — protocol

A **work program** is a multi-session initiative executed by agents, split into
numbered **cards**. The extension owns this protocol: it scaffolds programs,
drives the card pipeline, enforces review, records evidence, and merges card
lanes. The program folder holds the records; the extension holds the process.

## Structure

```
<program-dir>/<slug>/
  plan.md          the north star: context, decisions, phases, card index, rules
  progress.md      dated signal log — one terse line per event, hard-bounded
  atlas.md         scout-built orientation (architecture, module map, per-card pointers)
  tasks/*.md       card files: the unit of work AND the unit of record
  .runtime/        machine state (gitignored): ledger, review texts
```

- `plan.md` must make sense with zero conversation history. Program defaults
  (mode, parallelism, review profile, max cycles, models) live in its YAML
  front matter; per-card overrides live in each card file's front matter.
- Every card declares its dependencies explicitly (`dependsOn` front matter).
  No card starts before its dependencies are `done`.
- Completed programs stay in the tree until the user explicitly closes them out.

## Program atlas

Every program builds an **`atlas.md`**: a scout subagent explores the repo once
(cards + plan in hand) and writes a capped orientation document — architecture,
module map, conventions, integration points, negative knowledge, and per-card
file pointers. Worker, reviewer, captain, and reconciler briefs point at it.

- The **first build gates worker dispatch**: workers start after the scout
  finishes, because starting with the atlas is the entire point. A failed
  build never blocks — workers fall back to exploring, as before.
- Managed and captain programs dispatch the scout automatically. Session-mode
  programs adopt an `atlas.md` you write into the program dir (the session
  drives its own runs there).
- After each card merges, the scout is **resumed** to update the atlas from
  the merge diff (fallback: a fresh scout re-reads the existing atlas and
  verifies it — the file is the source of truth, the session only a cache).
  A failed refresh keeps the existing atlas and retries, throttled.
- The atlas is orientation, not a boundary: briefs tell agents to verify
  before relying on it and to explore beyond it freely.
- Configure via settings (`workPrograms.atlas: { enabled, agent, model,
  thinking }`, default agent `scout`) or per program:
  `work_program({ action: "config", atlasEnabled: false })`.
- An existing `atlas.md` in the program dir is adopted as-is (no rebuild).

## Run telemetry

Every run's token usage is recorded onto its card. Two layers:

- **Session-accurate totals** (authoritative): the child session transcript is
  summed at terminal status — input, cache reads, cache writes, output, cost,
  turns. Resumed runs share one transcript, so a resume **replaces** its
  session's row instead of adding one; card totals are the sum of sessions and
  never double-count a resume chain. Progress lines, harness evidence
  (`usage: 71.0M tok (cache 68.1M) · 266 turns · $1.02`), `status`, and the
  completion summary all use these numbers.
- **Per-run history**: each run's `status.json` numbers are kept for the
  pass-by-pass breakdown (`usageRuns`, bounded), flagged `resumed: true` when
  the run continued a retained session.

Use it to retune: cards that dominate the token budget are candidates for
tighter scope, more Context, or `enhanced` → `light` review.

## Resume vs fresh

Cycles, fixes, and re-reviews normally continue the session that already holds
context — fix passes measure at 3–15% of a fresh worker's exploration tax. But
continuation has a cost curve: a resumed session re-sends its whole history
every turn, so past a point a fresh session is cheaper.

- `resumeMaxWindowPeak` (default **250k tokens**): once a session's context
  peak reaches this, the next continuation is dispatched fresh. The fresh
  agent is told it is continuing an existing lane and must reconstruct state
  from the card Evidence, the lane diff, and the atlas.
- `resumeMaxDepth` (default **3**): consecutive resumes of one session before
  a fresh dispatch; a fresh run resets the chain.
- Both apply independently to worker fixes and reviewer cycles; a skipped
  resume is recorded in `progress.md` with its reason
  (`03 fix: fresh session — session peaked at 390k (limit 250k)`).

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
  Within one card, review cycles 2+ **resume the same reviewer session** — it
  already holds the diff understanding, so re-review covers the fix delta
  instead of re-deriving the whole card (a fresh reviewer per cycle pays that
  cost in full). Independence is per card: the reviewer session is never the
  worker's. Disable with `work_program({ action: "config", reviewerResume: false })`.
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
  card files, rewire front-matter `dependsOn` so nothing points at a card you are deleting,
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
  physical access). Record it as a structured todo instead of guessing or
  stalling — never hand-edit `.operator/todos.json` or `.operator/todo.md`.
- Todos live in `.operator/todos.json` (one `op-NN` id each, with title, why,
  exact steps/commands, and a blocking flag). Manage them entirely from chat:
  `todos` lists, `todo_add` creates, `todo_update` rewrites (title, body,
  steps), `todo_done` completes, `todo_drop` discards.
- A **blocking** todo parks its card: no worker, reviewer, fix, or merge is
  dispatched for it, in-flight completions park instead of advancing, and the
  card shows as blocked with `→ todo_done op-NN when finished`. The operator
  gets an immediate wake-up plus `! op-NN blocks <card>` lines in the brief,
  status, and TUI widget. `todo_done`/`todo_drop` rearm the card on its own.
- Advisory (non-blocking) todos never hold a card: they are listed in
  `status`/`doctor`, the session brief, and the completion summary instead.
- Worker, fix, gate-fix, and captain prompts carry the parking rule: blocked
  workers append to the `.operator/todo.md` inbox (with a `Blocking: yes/no`
  line) and escalate via `contact_supervisor` — the drive imports inbox
  entries into the store automatically. Reviewers are read-only and never
  touch either file.

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
  reviewProfile, maxParallel, parallelExecution, mode, workerAgent,
  workerModel, workerThinking, reviewerAgent, reviewerModel,
  reviewerThinking })`.
- One card is retuned the same way with `card` set: `work_program({
  action: "config", card: "05", maxCycles: 5, reviewProfile: "enhanced"
  })`. Card models work the same way (`workerModel`, `reviewerModel`,
  `thinking`); an empty string clears a card override so it inherits the
  program default. Always use `config` with `card` — never hand-edit card
  front matter.
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
  front matter (so `sync` and session reload keep it), and lands in
  `progress.md` as `config: maxCycles 3→2`. Card-scoped changes
  persist into that card file's front matter the same way.
- `mode` is still refused while runs are in flight (pause first); every other
  knob applies immediately.
- Card **scope** is reshaped through the files, not through this action: edit
  the card/plan text (fold, rewire front-matter `dependsOn`, delete or add cards) and run
  `sync` — see Reshaping the program.

## Decisions and wake-ups

- Open decisions live in every turn's **program brief** (pull) — you always see
  what is open without asking.
- A **decision packet** is a *wake-up* for an idle session, not the primary
  channel. It is queued only when the decision is still open, is older than
  15 seconds, and pi is idle (not processing a run, retry, compaction, or
  queued continuation). A session that never goes idle still receives packets
  once a decision passes 3 minutes, so nothing is starved, and a deferred
  decision is re-evaluated on the next tick.
- Consequence: a decision you answer during your current turn is **never**
  announced afterwards. A packet therefore cannot be a stale duplicate of work
  you just did.
- Each packet states when the decision was raised and when the packet was
  prepared, and says what to do if it arrives stale anyway: if `status` no
  longer lists the decision, it was answered between preparation and delivery —
  ignore it instead of re-answering.

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
  commit it was measured at. During implementation, agents run only fast
  scoped checks (the touched test file, the affected package); full quality
  gates run ONCE at the end of the card's work.
- When gates are configured, the harness runs them and its result is
  authoritative; worker-pasted evidence is supplementary. Reviewers see the
  harness gate results and re-run the gates themselves at the END of their
  review pass (the shipped `work-program-reviewer` agent has bash; the builtin
  pi-subagents `reviewer` does not and cannot run gates).
- Gates are set per program (`gates.card`) and may be overridden per card in
  its front matter (`gates: [...]`, or `gates: []` for gate-free cards).
- Every run has a wall-clock budget (`runTimeoutMs`, default 4h): pi-subagents
  kills single async runs at 30 minutes otherwise. Resumed runs (fixes,
  re-reviews, atlas refreshes) keep the runner's own timeout — the RPC accepts
  no override — so a very long follow-up can still die at 30m; the failure
  path then re-dispatches fresh with the full budget.
- A card is done only when its gate is green (or no gate applies) and its
  review has been triaged.

## Provider quota

- A run that dies on a provider quota/rate-limit error is **held**, not
  escalated: the card is rearmed and parked until the reset time reported in
  the error (plus a minute of slack), with a terse `progress.md` line naming
  the parsed delay (e.g. `01 quota held until 13:42 UTC (1hr 27min)`). The raw
  provider error is never quoted into the log. No decision packet, no
  re-dispatch: one exhausted window no longer asks the supervisor seven times.
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
(card front matter `review: enhanced`, or `work_program({ action: "config",
card: "05", reviewProfile: "enhanced" })`).

At creation time, set `review` and `maxCycles` on every card from difficulty
(trivial: light/1-2, standard: light/3, tricky: enhanced/3-5, critical:
enhanced/5). Leave card models unset to inherit the program/global defaults
unless the operator explicitly asked for card-specific models.

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

`progress.md` is a signal log, not a diary. Every event is exactly one terse
line — telegraphic facts only: card, event, commit SHA. No prose, no
sentences, no quoting of raw model/provider error text; a line says *what
happened*, and the detail lives where it belongs (the card's Evidence section,
the review file, the decision packet).

The extension enforces the bound mechanically, so verbosity cannot return:

- One event = one line, whitespace-collapsed, hard-capped at 200 characters.
- Events are filed under a `## <date>` UTC header; a new day starts a new
  section, so the log scans chronologically.
- The file keeps only the newest ~500 events. Older lines roll off into a
  single `- … N earlier events trimmed` marker; the count stays cumulative.
  `progress.md` is committed at every card completion, so **git history is
  the archive** — the live file stays a scannable log.
- Empty lines are dropped, never recorded. Pure-noise events (retry
  bookkeeping, no-op config changes) are not logged at all.

Recorded signal: card outcomes, review verdicts, merges, blocks, quota holds,
structural plan edits, operator actions. Everything else is noise.

## Human gates

Human gates declared in the plan (migrations, deploys, irreversible operations,
product decisions) are the one thing agents never resolve. The extension
surfaces them to the operator and holds the card until a human answers.
