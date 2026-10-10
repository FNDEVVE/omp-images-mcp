# Domain Docs

## Layout

Single-context: `GLOSSARY.md` at the repo root and ADRs in `docs/adr/`.

## Before exploring

Read the root glossary and ADRs relevant to the area being explored.

If either is absent, proceed silently. Do not suggest creating them
upfront. `/domain-modeling`, reached through `/grill-with-docs` and
`/improve-codebase-architecture`, creates them lazily when terms or
decisions are resolved.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and test
names. Avoid synonyms the glossary explicitly excludes.

If a needed concept is missing, reconsider whether it belongs to the
domain; otherwise note the gap for `/domain-modeling`.

## ADR conflicts

Explicitly flag any proposal that contradicts an existing ADR,
identifying the decision and why it merits reopening.
