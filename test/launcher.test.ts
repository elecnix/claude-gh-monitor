import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("launcher always supplies the development channel flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-gh-monitor-launcher-"));
  const fakeClaude = join(dir, "claude");
  const capture = join(dir, "args.txt");
  await writeFile(
    fakeClaude,
    `#!/bin/sh
printf '%s\\n' "$@" > "$CAPTURE"
`,
  );
  await chmod(fakeClaude, 0o755);

  const launcher = join(process.cwd(), "bin", "claude-gh-monitor");
  const child = Bun.spawnSync([launcher, "--model", "sonnet"], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      CAPTURE: capture,
    },
  });

  expect(child.exitCode).toBe(0);
  expect((await readFile(capture, "utf8")).trim().split("\n")).toEqual([
    "--dangerously-load-development-channels",
    "plugin:gh-monitor@claude-gh-monitor",
    "--model",
    "sonnet",
  ]);
});
