# AGENTS.md

Notes for coding agents working in this repository.

## Releasing the plugin

A release is one pull request that changes the version string in four files. Release 0.1.1 ([#2](https://github.com/elecnix/claude-gh-monitor/pull/2)) is the worked example. Users on 0.1.0 didn't receive the launcher until that bump merged.

### Version strings and updates

Claude Code detects a plugin update by comparing version strings. The manifest's `version` comes first, then the marketplace entry's `version`, then the source's commit SHA. A manifest that sets `"version"` keeps every user on the cached copy until the string changes, however many commits you push. See [Versions and updates](https://code.claude.com/docs/en/plugins/loading.md#versions-and-updates). Existing installs ignore a merged change that leaves the version string alone.

### Steps

1. Pick the new version, such as `0.1.2`.
2. Change it in these four places. All four must match.
   - `.claude-plugin/plugin.json`, the `version` field.
   - `.claude-plugin/marketplace.json`, the `version` of the first entry in `plugins`.
   - `package.json`, the `version` field.
   - `src/server.ts`, the `SERVER_VERSION` constant.
3. Update the `serverInfo.version` expectation in `test/server.test.ts`. The MCP server test asserts it.
4. Run the checks CI runs:

   ```sh
   bun install --frozen-lockfile
   bun test
   bun run typecheck
   ```

   `test/version.test.ts` fails when the four places disagree.
5. Open a pull request titled `chore: release plugin <version>`, with a short reason. PR #2 states what the new version delivers.
6. Merge the pull request. Merging to `main` is the release.

### Tags

This repository has no git tags, and release 0.1.1 used none. The marketplace entry has a relative `source` of `./`, so Claude Code reads the plugin from the marketplace repository's default branch. The version string alone triggers the update.

Claude Code has a `claude plugin tag` command that creates a `{name}--v{version}` tag and checks that `plugin.json` and the marketplace entry agree. You don't need to tag. If you tag a release, run `claude plugin tag --dry-run` first.

### Pick up the release on a machine

Refresh the marketplace, then update the plugin, then restart Claude Code:

```sh
claude plugin marketplace update claude-gh-monitor
claude plugin update gh-monitor@claude-gh-monitor
```

The update prints `Restart to apply changes.` A running session keeps the old version until you restart it or run `/reload-plugins`. If the update prints `already at the latest version`, the version string didn't change.

### Verify the installed version

```sh
claude plugin list
```

The entry for the plugin reports the installed version:

```text
  ❯ gh-monitor@claude-gh-monitor
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled
```

After a successful update, `Version:` shows the new string. To check the running channel server instead, look at `serverInfo.version` in its MCP `initialize` response, which comes from `SERVER_VERSION`.
