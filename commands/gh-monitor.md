---
description: Monitor a GitHub pull request through gh monitor
argument-hint: "[PR URL | owner/repo#number]"
---

Use the `gh_monitor` tool with `action: "start"`.

If the argument is non-empty, use it as the `url`:

$ARGUMENTS

If the argument is empty, identify the pull request for the current branch with
`gh pr view --json url -q .url`, then start monitoring that URL.

Keep the monitor running until the pull request merges or closes, or until the
operator explicitly asks to stop it.
