# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on `ductringuyen-0618/ai-business-support`.

## Tooling

- **Local sessions**: use the `gh` CLI for all operations.
- **Cloud sessions (Claude Code on the web)**: `gh` is not on PATH. Use the GitHub MCP tools (`mcp__github__*`) instead. The mapping below shows the `gh` form first and the MCP equivalent in parentheses.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."` (MCP: `mcp__github__issue_write` with action `create`). Use a heredoc for multi-line bodies when shelling out.
- **Read an issue**: `gh issue view <number> --comments` (MCP: `mcp__github__issue_read`), filtering comments and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` (MCP: `mcp__github__list_issues`) with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."` (MCP: `mcp__github__add_issue_comment`).
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."` (MCP: `mcp__github__issue_write` with the appropriate label fields).
- **Close**: `gh issue close <number> --comment "..."` (MCP: `mcp__github__issue_write` with state `closed`).

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone; the MCP server is already scoped to this repo.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` (or `mcp__github__issue_read`).
