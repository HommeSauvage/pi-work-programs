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
standard: light/3, tricky: enhanced/3-5, critical: enhanced/5). Leave
models unset to inherit the program defaults unless the operator explicitly
asked for card-specific models.

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
