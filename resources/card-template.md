---
dependsOn: {{DEPENDS_YAML}}
kind: write
review: light
maxCycles: 3
---

# Card {{ID}} — {{TITLE}}

**Scope:** {{SCOPE}}

## Context

{{CONTEXT}}

Set difficulty in the front matter above: `review: light|enhanced` and
`maxCycles: 1-5` based on how hard the card is (trivial: light/1-2,
standard: light/3, tricky: enhanced/3-5, critical: enhanced/5). Set it once
here, at plan time: during execution the cycle budget belongs to the
operator, and an agent never raises it — not even for a stuck card. Leave
models unset to inherit the program defaults unless the operator explicitly
asked for card-specific models.

Gates: DISCOVER them, do not invent them. The plan's `gates.card` commands
apply by default (the creating agent fills them from the repository's own
check command — `package.json` scripts, CI workflows, `Makefile`/`justfile`,
`turbo.json`/`nx.json`/`mise.toml`, `AGENTS.md`/`CONTRIBUTING.md`). Override
per card with a front-matter `gates:` list when this card needs a narrower or
extra command (e.g. a perf probe it must keep green), or `gates: []` for a
card that genuinely has no gate (docs, chore cards) — a deliberate
exemption, not a fallback. The harness runs the gates authoritatively at
handoff; the worker runs them once, at the end of its work, never mid-card;
the reviewer runs them last, after reviewing.

Fill `## Context` at plan time so the worker verifies instead of discovering:
the 3-8 files/symbols this card touches, integration points, and gotchas
(dead ends, generated files, required codegen). Prose with path:symbol
references, no code dumps. Write `(none — explore)` when the surface is
genuinely unknown.

## Steps

1. {{STEP}}

## Done when

- {{DONE_WHEN}}

## Evidence

(none yet)

## State: todo
