# Issue Tracker: GitHub

Issues and durable engineering proposals for this repository live in GitHub
Issues. Use the `gh` CLI from this clone so the repository is inferred from
`origin`.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open`
- Comment: `gh issue comment <number> --body "..."`
- Close: `gh issue close <number> --comment "..."`

Use heredocs or body files for multiline content. Never include credentials,
private Telegram identifiers, `.env.local` contents, or private local paths in
an issue.

## Pull Requests As A Request Surface

PRs as a request surface: no. Pull requests are delivery and review artifacts;
new work should enter through an issue, Maestro task, or an explicitly approved
follow-up.

When a skill says "publish to the issue tracker", create a GitHub issue. When a
skill says "fetch the relevant ticket", run `gh issue view <number> --comments`.
