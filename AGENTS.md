# AGENTS.md

Notes for coding agents working in this repository.

## Releasing the plugin

A release is one pull request that changes the version string in three files, then a change to the ref that the central marketplace installs. Release 0.1.1 ([#2](https://github.com/elecnix/claude-gh-monitor/pull/2)) is the worked example. Users on 0.1.0 didn't receive the launcher until that bump merged.

### Version strings and updates

Claude Code detects a plugin update by comparing version strings. The manifest's `version` comes first, then the marketplace entry's `version`, then the source's commit SHA. The central marketplace entry doesn't set a `version`, so the manifest decides. A manifest that sets `"version"` keeps every user on the cached copy until the string changes, however many commits you push. See [Versions and updates](https://code.claude.com/docs/en/plugins/loading.md#versions-and-updates). Existing installs ignore a merged change that leaves the version string alone.

### Steps

1. Pick the new version, such as `0.1.2`.
2. Change it in these three places. All three must match.
   - `.claude-plugin/plugin.json`, the `version` field.
   - `package.json`, the `version` field.
   - `src/server.ts`, the `SERVER_VERSION` constant.
3. Update the `serverInfo.version` expectation in `test/server.test.ts`. The MCP server test asserts it.
4. Run the checks CI runs:

   ```sh
   bun install --frozen-lockfile
   bun test
   bun run typecheck
   ```

   `test/version.test.ts` fails when the three places disagree.
5. Open a pull request titled `chore: release plugin <version>`, with a short reason. PR #2 states what the new version delivers.
6. Merge the pull request.
7. Point the `gh-monitor` entry in [elecnix/claude-plugins](https://github.com/elecnix/claude-plugins/blob/main/.claude-plugin/marketplace.json) at a tag that contains the merge. Users install from that ref, so a merge to `main` reaches nobody until the entry moves.

### Tags

This repository is a plugin. [elecnix/claude-plugins](https://github.com/elecnix/claude-plugins) is the one marketplace that lists it, and its entry references this repository at a git `ref`. Claude Code clones that ref, not `main`.

The entry points at the `claude-plugin` tag, which marks release 0.1.1 at d466ae2. A marketplace `ref` can't reference a commit SHA, so a tag is the way to pin a release. Give each new release its own tag rather than moving `claude-plugin`, because a moved tag changes what an existing pin installs.

### Pick up the release on a machine

Refresh the marketplace, then update the plugin, then restart Claude Code:

```sh
claude plugin marketplace update elecnix-plugins
claude plugin update gh-monitor@elecnix-plugins
```

The update prints `Restart to apply changes.` A running session keeps the old version until you restart it or run `/reload-plugins`. If the update prints `already at the latest version`, the version string didn't change.

### Verify the installed version

```sh
claude plugin list
```

The entry for the plugin reports the installed version:

```text
  ❯ gh-monitor@elecnix-plugins
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled
```

After a successful update, `Version:` shows the new string. To check the running channel server instead, look at `serverInfo.version` in its MCP `initialize` response, which comes from `SERVER_VERSION`.
