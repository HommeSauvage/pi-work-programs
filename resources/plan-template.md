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

The extension owns the process. A scout builds `atlas.md` once (workers wait
for it), then cards are implemented by fresh workers oriented by the atlas,
reviewed by reviewers that resume across a card's cycles, and merged lane by
lane with gates between. Evidence before done; one concern per card.

Program defaults live in the front matter above (mode, parallelism, review
profile, max cycles, models, gates). Cards inherit them unless their own front
matter overrides them — see the card template.

Gates are discovered from the repository, never invented: the creating agent
reads `package.json` scripts, CI workflows, `Makefile`/`justfile`,
`turbo.json`/`nx.json`/`mise.toml` and `AGENTS.md`/`CONTRIBUTING.md`, then
writes the canonical check command under `gates.card` here. Declaring none
leaves every card's claims unverified (`gate: no gates configured`).

## Done when

- {{DONE_WHEN}}
