# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `FNDEVVE/omp-images-mcp`.
Use the `gh` CLI from this repo; it infers the repository from the remote.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
  Use a heredoc for multi-line bodies.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
  Apply appropriate `--label` and `--state` filters.
- Comment: `gh issue comment <number> --body "..."`.
- Apply/remove labels: `gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.
- Sub-issues: with gh 2.94+, use `gh issue create --parent <parent> ...`
  or `gh issue edit <parent> --add-sub-issue <child>`.
  Otherwise use the GitHub sub-issues API; if unavailable, put
  `Part of #<parent>` at the top of the child body.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. When ambiguous,
try `gh pr view <number>` and fall back to `gh issue view <number>`.

## Skill operations

- "Publish to the issue tracker": create a GitHub issue.
- "Fetch the relevant ticket": read the issue using the command above.

## Wayfinding operations

Used by `/wayfinder`.

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child ticket: link it as a sub-issue. If unavailable, add it to the
  map's task list and put `Part of #<map>` in the child body.
  Use `wayfinder:<type>`: research, prototype, grilling, or task.
- Blocking: use GitHub's native issue dependencies:
  `gh api --method POST repos/FNDEVVE/omp-images-mcp/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Obtain the database ID with
  `gh api repos/FNDEVVE/omp-images-mcp/issues/<number> --jq .id`;
  it is not the issue number or node_id.
  If dependencies are unavailable, use `Blocked by: #<number>` in the body.
- Frontier: choose the first open child in map order with no open
  blockers and no assignee.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the answer, close the issue, then add a
  gist and link to the map's Decisions-so-far.
