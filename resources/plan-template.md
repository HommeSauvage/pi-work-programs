---
{{WP_FRONTMATTER}}
---

# Work program — {{TITLE}}

**North star:** {{BRIEF}}

**Started:** {{DATE}} · **Owner:** operator + agents

## Why

{{WHY}}

## Decisions

1. {{DECISION}}

## Phases and cards

| # | card | phase | depends on |
| --- | --- | --- | --- |
| 01 | `tasks/01-{{SLUG}}.md` — {{CARD_TITLE}} | 1 | — |

## Execution protocol

The extension owns the process. Cards are implemented by fresh workers,
reviewed by fresh reviewers, and merged lane by lane with gates between.
Evidence before done; one concern per card.

Program defaults live in the front matter above (mode, parallelism, review
profile, max cycles, models). Cards inherit them unless their own front
matter overrides them — see the card template.

## Done when

- {{DONE_WHEN}}
