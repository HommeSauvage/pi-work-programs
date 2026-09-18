# pi-work-programs

`pi-work-programs` lets Pi run large work as durable, review-gated programs. Use it for anything too big for one session: multi-step migrations, feature builds with dependent pieces, parallel work across cards, and anything that needs a second set of model eyes before it lands.

## Install

```bash
pi install git:github.com/HommeSauvage/pi-work-programs
```

That pulls the extension itself. Work programs also need their two runtime dependencies:

```bash
pi install npm:pi-subagents
pi install npm:pi-intercom
```

`pi-subagents` does the actual spawning (workers, reviewers, captains). `pi-intercom` carries the escalation path (`contact_supervisor`) children use when a plan decision needs a human. If either is missing, `work_program({ action: "doctor" })` tells you exactly which one and how to fix it.

Then restart Pi.

## Try this first

You do not need to write a plan, create cards, or learn the tool actions. For a large request, just ask Pi in plain language — it will propose a program when the work deserves one:

```text
This is a multi-session migration with several dependent pieces. Should this be a work program?
```

```text
Turn this feature into a work program with a card per phase.
```

```text
What's the status of the current work program?
```

That is enough to start. Pi decides whether to call `suggest_work_program`, writes `plan.md` and `tasks/*.md` from the conversation you already had, validates with `finalize_plan`, and then stops for your review. Nothing executes until you explicitly say to start.

## How it works

A **work program** is a multi-session initiative split into numbered **cards**. The extension owns the process: it scaffolds programs, drives the card pipeline, enforces review, records evidence, and merges card lanes. The program folder holds the records; the extension holds the state machine.

When a program is active, every session sees a short brief (`[WORK PROGRAM] slug · mode · done/total`, board line, ready cards, open decisions). A **scout** explores the repo once and writes `atlas.md` (architecture, module map, per-card file pointers); workers start only after it lands, so no worker pays the from-scratch exploration tax again. Workers implement one card at a time. A reviewer checks every card before it can land — resumed across that card's review cycles, so cycle 2+ re-reads only the fix delta instead of the whole card. Findings come back to you as triage decisions — approve, reject, or defer — and approved findings go back to the same worker for a fix pass.

Installing the extension does not start background work. It gives Pi two tools and one command. If you want large requests to become programs by default, say so in your project instructions:

```text
When a request spans multiple sessions or has several dependent deliverables, propose a work program with suggest_work_program before implementing.
```

Rule of thumb: one session and one concern is an ordinary task; several dependent deliverables, parallel tracks, or work that must survive context loss is a program.

## Card lifecycle

```
pending → ready → implementing → review_pending → reviewing → triaging
        → fixing → review_pending (next cycle)
        → approved → verifying → queued → merging → done
                                    (conflict → reconciling)
        → blocked (escalated)
```

After triage approval the harness verifies the card's gates, then the lane queues for its serialized merge-back (a conflict routes through a reconciler before the card is done).

| Role | Does |
|------|------|
| `scout` | Explores the repo once and writes `atlas.md`; resumed after each merge to keep it current. The first build gates worker dispatch; refreshes never gate. |
| `worker` | Implements exactly the card's scope, runs the card gates, appends `## Evidence` with exact output and commit SHAs, sets `State: review`, commits. Never writes `State: done`. |
| `reviewer` | A read-only second pass over the committed lane diff. Mandatory — no card reaches `done` without one. Resumed across a card's cycles (fresh eyes per card, not per cycle). |
| orchestrator (you, or a captain) | Triages every finding: `approve`, `reject`, or `defer`. Approved findings go back to the same worker. |
| `reconciler` | Resolves a lane merge conflict preserving both intents, then completes the merge. |

Review/fix cycles are capped (default 3). On exhaustion the program asks a binary decision — `accept` or `block`; there is no "one more round". Accepting records every approved-but-unfixed finding in the card, so landing at the cap never silently drops debt.

## Orchestration modes

| Mode | Ask for it when you want... |
|------|------------------------------|
| `managed` (default) | The extension to run the loop; you only decide at review checkpoints. Best for most programs. |
| `session` | The current session to dispatch every step; the extension enforces and records. Best when you want your hands on each decision. |
| `captain` | One fresh orchestrator per card (worker → reviewer → triage → fix → gate inside its lane); you handle program gates. Best for long parallel programs you want to supervise, not drive. |

Switch any time: `work_program({ action: "mode", mode: "captain" })` or `/work-program mode captain`.

## Common workflows

| Want | Say, or call |
|------|--------------|
| Propose a program | "Should this be a work program?" — Pi calls `suggest_work_program`, then writes the plan and cards |
| Validate the plan | `work_program({ action: "finalize_plan" })` — strict: every card needs `dependsOn` front matter, every dependency must exist, graph must be acyclic |
| Start execution | "Start the program." — only on your explicit word, Pi calls `work_program({ action: "resume" })` |
| Check status | "What's the program status?" or `work_program({ action: "status" })` |
| List programs | `work_program({ action: "list" })` or `/work-program list` |
| Triage a review | Answer the decision packet with `work_program({ action: "triage", card, verdicts })` — one verdict per finding |
| Unblock a card | `work_program({ action: "unblock", card, resolution })` — `redispatch` retries the pending fix when one exists (and re-adopts an abandoned card), `done` marks it finished, `abandon` drops its scope (branch kept, excluded from completion) |
| Resolve an exhausted cycle | `work_program({ action: "cycle_decision", card, choice })` — `accept` (land it; unfixed findings recorded on the card) or `block`. Extra review rounds are not offered |
| Retune a running program | `work_program({ action: "config", maxCycles, onExhausted, reviewProfile, maxParallel, workerModel, reviewerModel, reviewerResume, atlasEnabled, … })` — applies live and persists into plan.md front matter, so it survives sync and reload |
| Retune one card | `work_program({ action: "config", card: "05", maxCycles: 5, reviewProfile: "enhanced" })` — applies live and persists into that card's front matter (empty-string model clears the override) |
| Resolve a program gate | `work_program({ action: "program_gate", choice })` — `retry` or `block` |
| Merge a reconciled lane | `work_program({ action: "merge_resolved", card })` |
| Operator todos | `work_program({ action: "todos" })` to list, `todo_add` to create (blocking parks the card), `todo_update` to rewrite, `todo_done`/`todo_drop` to resolve (card resumes on its own) |
| Dispatch manually (session mode) | `work_program({ action: "dispatch", card, role })` — `worker`, `reviewer`, or `reconciler` |
| Pause / resume | `/work-program pause` (soft: let runs finish) or `--hard` (stop runs now), `/work-program resume` |
| Sync edits you made on disk | `work_program({ action: "sync" })` |
| Check setup | `work_program({ action: "doctor" })` or `/work-program doctor` |
| Read the full protocol | `work_program({ action: "protocol" })` |

After `finalize_plan`, Pi stops and shows you the plan. That pause is load-bearing: it is your chance to fix card boundaries before workers spawn.

### Live status

`status` shows every card with its live agent heartbeat (run kind, elapsed time, last activity, and the run's latest output tail), the merge queue, any mid-merge state, and an Issues section where each blocked card names its redispatch path. `doctor` reports the same for setup triage, and the TUI widget shows the top in-flight heartbeats. Heartbeats are read-only artifact reads — they never steer, resume, or otherwise disturb a running agent.

## Program records

```
.agents/work-programs/<slug>/
  plan.md          the north star: context, decisions, phases, card index, rules
  progress.md      dated signal log — one terse line per event, capped (~500 lines; git history is the archive)
  atlas.md         scout-built orientation: architecture, module map, per-card pointers
  tasks/*.md       card files: the unit of work AND the unit of record
  .runtime/        machine state (gitignored): ledger, review texts
```

- `plan.md` must make sense with zero conversation history. Program defaults (mode, parallelism, review profile, max cycles, models) live in its YAML front matter — retune via `work_program config`, never by hand-editing.
- Every card declares `dependsOn` front matter explicitly (`[]` when none), `kind: write|recon`, `review: light|enhanced` + `maxCycles` set from difficulty, and a `## State: todo` line. No card starts before its dependencies are `done`.
- Workers never touch `plan.md` or `progress.md`. The extension is the single writer of program records — it even blocks direct `write`/`edit` calls to `progress.md` while a program is active.
- Reshape freely: fold scope into surviving cards, rewire front-matter `dependsOn`, delete dead card files and their plan rows, then `work_program({ action: "sync" })`. Retune cards via `work_program({ action: "config", card })` — never hand-edit front matter. Safe removals are dropped (empty lanes cleaned); unsafe ones are kept and explained (done records, live dependents, lanes holding work). To drop an unfinished card deliberately, `unblock … resolution: "abandon"` — the branch is kept and the card stops counting against completion.
- Program records live outside git when the repo ignores them (e.g. `.agents/` is gitignored): cards still reach `done` on disk, the merge still lands, and the harness warns once that records stay untracked instead of failing.
- When every card is `done`, the program completes: the work-program UI goes quiet and the agent delivers a completion summary, then asks whether to close. Close only on your explicit word — `/work-program close --remove` (or `work_program({ action: "close", remove: true })`) deletes the folder and all card lanes; git history keeps every commit. Until then the records stay put and the program never reactivates on its own.
- Provider/runner blips (502/503/504, admission or capacity outages, runner-startup timeouts) retry in place up to twice before blocking; a review-run failure re-enters review rather than re-running implementation, and a lane that already carries committed work skips the worker entirely.
- Decision packets are wake-ups for an idle session only (a freshly raised decision waits 15s; a session that never idles is woken after 3 min): open decisions are already listed in every turn's program brief, so a decision you answer in the current turn is never announced afterwards as a stale duplicate.
- The drive ticks on a 20-second safety timer (plus events) and drains until quiescent, so a merge can never strand the cards it unblocks; `start` on the loaded program resumes it.
- Provider/runner blips (502/503/504, admission or capacity outages, runner-startup timeouts) retry in place up to twice before blocking; a review-run failure re-enters review rather than re-running implementation, and a lane that already carries committed work skips the worker entirely.
- Provider quota/rate-limit failures **hold** the card until the reset time named in the error (parsed and quoted in `progress.md`) instead of raising a decision the supervisor can only answer with "wait". Repeats extend the hold up to a cap; an unknown reset falls back to a normal block.
- Work that needs human hands lives in `.operator/todos.json` as structured todos (`op-NN` ids, managed entirely from chat: `todos`, `todo_add`, `todo_update`, `todo_done`, `todo_drop` — never hand-edit). A **blocking** todo parks its card (wake-up + `! op-NN blocks <card>` in brief/status/widget) until `todo_done`/`todo_drop` rearms it; advisory todos surface in `status`, `doctor`, and the completion summary without holding anything.

## Evidence and review

Evidence is measured, never assumed. The worker pastes exact command output and the commit SHA it was measured at into the card's `## Evidence` section. When gates are configured, the harness runs them itself and its result is authoritative; worker-pasted evidence is supplementary. A card is done only when its gate is green (or no gate applies) and its review has been triaged.

## Token economy

Measured on real programs, fresh workers spend ~20-25% of their input budget re-exploring the repo before their first edit, and each fresh review cycle re-derives the same understanding. Three mechanisms attack that:

- **Program atlas** (`atlas.md`): one scout explores the repo with the plan and every card in hand, then writes a capped orientation document — architecture, module map, conventions, integration points, negative knowledge, and 3-8 per-card file pointers. The first build gates worker dispatch; after each merge the scout is *resumed* to update the atlas from the diff. The file is the source of truth (a replacement scout re-reads it instead of starting over); the session is only a warm cache. Briefs tell agents the atlas is orientation, not a boundary — verify before relying, explore beyond freely. An `atlas.md` you write yourself in the program dir is adopted as-is.
- **Reviewer resume**: cycle 2+ of a card's review resumes the same reviewer session with just the fix delta (`lastReviewedSha..HEAD`) and the approved-findings list. Disable with `config reviewerResume: false` (or `review.resumeReviewer: false` in settings) to get fresh reviewers every cycle.
- **Run telemetry**: token usage is read from the child session transcript at run completion — input, cache reads/writes, output, cost, turns — and keyed by session. Resumed runs replace their session's row, so card/program totals never double-count a resume chain. `status` shows program totals with the cache breakdown, each done card's harness evidence carries a `usage:` line, and the completion summary totals the program.
- **Adaptive resume**: continuations (fixes, re-reviews) resume the retained session while it is cheap to do so. Once a session's context peak passes `resumeMaxWindowPeak` (default 250k tokens) or `resumeMaxDepth` (default 3) consecutive resumes, the next pass is dispatched fresh with the atlas and a "reconstruct from Evidence + lane diff" brief. Measured: a resumed worker at 390k peak pays ~390k tokens on every remaining turn.
- **Gate discipline**: workers run fast scoped checks during implementation and the full quality gates **once, at the end** of the card — never in a mid-card loop (measured: 110+ bash calls per worker session before this). Reviewers work methodically — card first, diff second, **gates last** — running the gates themselves before writing findings (the shipped `work-program-reviewer` agent carries bash; the builtin pi-subagents `reviewer` does not, and old ledgers migrate to the new default). The harness also runs gates authoritatively at every transition. Per-card `gates:` front matter overrides the program gates; `gates: []` exempts a card.
- **Run timeouts**: every dispatch carries an explicit wall-clock budget (`runTimeoutMs`, default **4h**). pi-subagents kills single async runs at 30 minutes otherwise — and a killed worker re-dispatches fresh and re-explores, so the 30m wall was a token bug, not just a liveness bug. Scout runs get 1h (exploration, not implementation).

Two review profiles, per program with per-card override (card front matter `review: enhanced`, or `work_program({ action: "config", card, reviewProfile })`):

| Profile | What it is |
|---------|------------|
| `light` | The standard second pass: correctness, robustness, DRY, error handling, bugs, performance, quality, tests. |
| `enhanced` | The full adversarial audit: priority levels, clean-code and fail-fast guidelines, required human callouts. |

## Parallel execution and lanes

Ready cards run in parallel up to the program's limit (default 2).

- With `parallelExecution: worktrees` (default), every card gets a lane: a git worktree on its own branch (`{branch}-card-{id}`), cut from the program branch HEAD. Implement, review, fix, and gate all happen in the lane. Finished lanes enqueue for a strictly serialized merge-back; conflicts go to a reconciler.
- With `parallelExecution: direct`, cards run in the program checkout itself and writer cards are serialized.

Writers never touch program records from a lane — they commit only their own files as `wp(<slug>): <card id> <title>`.

## Human gates

Human gates declared in the plan (migrations, deploys, irreversible operations, product decisions) are the one thing agents never resolve. The extension surfaces them to the operator and holds the card until a human answers. If a worker hits a plan contradiction or missing information mid-card, it stops and asks via `contact_supervisor` instead of guessing.

## Tool and command reference

Two tools, `suggest_work_program` (propose + scaffold) and `work_program` (drive + inspect):

| `work_program` action | What it does |
|------------------------|--------------|
| `status`, `list`, `protocol`, `doctor` | Inspect: board + counts, known programs, full protocol text, dependency diagnosis |
| `create`, `start`, `finalize_plan` | Shape: scaffold from title+brief, attach to a slug, validate plan + cards |
| `pause`, `resume`, `mode`, `sync` | Control: hold/resume the loop, switch mode, re-read disk edits |
| `config` | Retune a running program or one card (cycles, profile, parallelism, models) — applies live, persists into front matter |
| `todos`, `todo_add`, `todo_update`, `todo_done`, `todo_drop` | Operator todos: list, create (blocking parks the card), rewrite, resolve (card resumes on its own) |
| `dispatch`, `triage`, `unblock` | Drive cards: start a role run, verdict every finding, resolve a block |
| `cycle_decision`, `program_gate` | Decide: exhausted review loop, program-level gate failure |
| `merge_resolved`, `close` | Finish: accept a reconciled merge, close (optionally delete) the program |

One command mirrors the common half: `/work-program status | list | new <title> | start <slug> | pause [--hard] | resume | mode <session|managed|captain> | sync | todos | doctor | close [--remove]`.

## Configuration

Defaults live in settings under `workPrograms` (user or project `settings.json`); per-program overrides live in the YAML front matter at the top of `plan.md` (legacy `<!-- wp: {...} -->` comments still read, but new writes use front matter). Per-card overrides (`review`, `maxCycles`, `workerModel`, `reviewerModel`, …) live in each card file's front matter:

| Key | Default | What it does |
|-----|---------|--------------|
| `dir` | `.agents/work-programs` | Where programs live |
| `mode` | `managed` | `session`, `managed`, or `captain` |
| `maxParallel` | `2` | Ready cards in flight (1–32) |
| `parallelExecution` | `worktrees` | `worktrees` or `direct` |
| `review.profile` | `light` | `light` or `enhanced` |
| `review.maxCycles` | `3` | Review/fix rounds before asking |
| `review.onExhausted` | `ask` | `ask`, `accept`, or `block` |
| `worker.agent` / `review.agent` | `worker` / `reviewer` | Which subagents to spawn (plus optional `model`/`thinking`) |
| `review.resumeReviewer` | `true` | Resume the same reviewer across a card's cycles; `false` = fresh reviewer every cycle |
| `atlas.enabled` / `atlas.agent` | `true` / `scout` | Build `atlas.md` via a scout and inject it into briefs (plus optional `model`/`thinking`) |
| `gates.card` / `gates.program` | `[]` | Shell commands run per card / at program end; failures block |
| `runTimeoutMs` | `14400000` | Wall-clock budget per run (default 4h; pi-subagents kills runs at 30m when unset) |
| `resumeMaxWindowPeak` / `resumeMaxDepth` | `250000` / `3` | Stop resuming a session once its context peak or resume count is exceeded — dispatch fresh instead |
| `laneBranchPattern` | `{branch}-card-{id}` | Lane branch naming |
| `worktreeDir` | `~/.pi/agent/work-programs/worktrees/<repo>` | Base directory for lane worktrees |

## If something feels off

```text
/work-program doctor
```

or ask: "Check whether work programs are set up correctly."

Inside subagent children the extension stays inert by design — no tools, no commands, no hooks — so workers and reviewers never drive the program they belong to.

## Developing

```bash
bun run typecheck
bun test
bun run check   # both
```

Layout: `src/` (engine, platform, program, protocol, shared), `resources/` (plan/card templates, protocol, review profiles), `agents/` (`work-program-captain`, `work-program-reconciler`), `test/`.

## License

MIT. See [`LICENSE`](./LICENSE).
