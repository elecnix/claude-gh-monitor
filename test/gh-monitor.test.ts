import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NdjsonParser,
  buildMonitorArgs,
  buildMonitorEnv,
  eventToChannel,
  parseTarget,
  spawnGhMonitor,
} from "../src/gh-monitor";

describe("parseTarget", () => {
  test("parses a github.com pull request", () => {
    expect(parseTarget("https://github.com/acme/api/pull/42")).toEqual({
      kind: "pr",
      owner: "acme",
      repo: "api",
      number: 42,
      host: "github.com",
    });
  });

  test("preserves a subdomain host", () => {
    expect(
      parseTarget("https://github.enterprise.example.com/acme/api/pull/7"),
    ).toEqual({
      kind: "pr",
      owner: "acme",
      repo: "api",
      number: 7,
      host: "github.enterprise.example.com",
    });
  });

  test("uses the supplied host for shorthand", () => {
    expect(parseTarget("acme/api#9", "github.example.com")).toEqual({
      kind: "pr",
      owner: "acme",
      repo: "api",
      number: 9,
      host: "github.example.com",
    });
  });

  test("parses an issue and an actions run", () => {
    expect(parseTarget("https://github.com/acme/api/issues/12")).toMatchObject({
      kind: "issue",
      number: 12,
    });
    expect(
      parseTarget("https://github.com/acme/api/actions/runs/30433642"),
    ).toMatchObject({
      kind: "run",
      number: 0,
      runId: 30433642,
    });
  });

  test("rejects unsupported URLs", () => {
    expect(() => parseTarget("https://github.com/acme/api")).toThrow(
      "Unsupported GitHub URL",
    );
  });
});

describe("buildMonitorArgs", () => {
  const target = {
    kind: "pr" as const,
    owner: "acme",
    repo: "api",
    number: 42,
    host: "github.com",
  };

  test("clamps the interval and forwards custom backends", () => {
    expect(
      buildMonitorArgs(target, {
        interval: 5,
        events: ["conflict", "new-failing-checks"],
        backend: "webhook",
        backendEndpoint: "unix:/tmp/gh-monitor.sock",
      }),
    ).toEqual([
      "-R",
      "acme/api",
      "--interval",
      "10",
      "42",
      "--events",
      "conflict,new-failing-checks",
      "--backend",
      "webhook",
      "--backend-endpoint",
      "unix:/tmp/gh-monitor.sock",
    ]);
  });

  test("uses the run and issue selectors", () => {
    expect(
      buildMonitorArgs(
        { ...target, kind: "run", number: 0, runId: 30433642 },
        { interval: 60 },
      ),
    ).toEqual([
      "-R",
      "acme/api",
      "--interval",
      "60",
      "--run-id",
      "30433642",
    ]);
    expect(
      buildMonitorArgs({ ...target, kind: "issue", number: 12 }, { interval: 60 }),
    ).toEqual(["-R", "acme/api", "--interval", "60", "--issue", "12"]);
  });
});

describe("buildMonitorEnv", () => {
  test("sets GH_HOST for a subdomain and clears it for github.com", () => {
    const base = { PATH: "/bin", GH_HOST: "stale.example.com" };
    expect(
      buildMonitorEnv(base, {
        kind: "pr",
        owner: "acme",
        repo: "api",
        number: 1,
        host: "github.enterprise.example.com",
      }).GH_HOST,
    ).toBe("github.enterprise.example.com");

    expect(
      buildMonitorEnv(base, {
        kind: "pr",
        owner: "acme",
        repo: "api",
        number: 1,
        host: "github.com",
      }).GH_HOST,
    ).toBeUndefined();
  });
});

describe("NdjsonParser", () => {
  test("buffers split lines and flushes a trailing event", () => {
    const parser = new NdjsonParser();
    expect(parser.push('{"type":"first-poll"}\n{"type":"conf')).toEqual([
      { type: "first-poll" },
    ]);
    expect(parser.push('lict","message":"Conflict"}\n')).toEqual([
      { type: "conflict", message: "Conflict" },
    ]);
    expect(parser.push('{"type":"merged","message":"Merged"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: "merged", message: "Merged" }]);
  });

  test("ignores malformed and blank lines", () => {
    const parser = new NdjsonParser();
    expect(parser.push('not-json\n\n{"type":"closed"}\n')).toEqual([
      { type: "closed" },
    ]);
  });
});

describe("eventToChannel", () => {
  const target = {
    kind: "pr" as const,
    owner: "acme",
    repo: "api",
    number: 42,
    host: "github.enterprise.example.com",
  };

  test("builds channel content and string metadata", () => {
    expect(
      eventToChannel(
        {
          type: "new-failing-checks",
          message: "2 checks failed",
          detail: "ci/test: FAILURE\nci/lint: FAILURE",
          commit_short_oid: "abc1234",
        },
        target,
      ),
    ).toEqual({
      content: "2 checks failed\n\nci/test: FAILURE\nci/lint: FAILURE",
      meta: {
        kind: "new-failing-checks",
        host: "github.enterprise.example.com",
        repo: "acme/api",
        pr: "42",
        commit: "abc1234",
      },
    });
  });

  test("suppresses the initial snapshot", () => {
    expect(
      eventToChannel({ type: "first-poll", message: "ready" }, target),
    ).toBeNull();
  });
});

describe("spawnGhMonitor", () => {
  test("parses each child-process line and reports a clean exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-gh-monitor-"));
    const bin = join(dir, "fake-gh-monitor");
    await writeFile(
      bin,
      `#!/bin/sh
printf '%s\\n' '{"type":"first-poll","message":"ready"}' '{"type":"conflict","message":"Conflict now"}'
`,
    );
    await chmod(bin, 0o755);

    const events: Array<{ type: string }> = [];
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve) => {
        spawnGhMonitor(
          {
            kind: "pr",
            owner: "acme",
            repo: "api",
            number: 42,
            host: "github.com",
          },
          { bin, interval: 10 },
          {
            onEvent: (event) => events.push(event),
            onExit: (code, stderr) => resolve({ code, stderr }),
          },
        );
      },
    );

    expect(events.map((event) => event.type)).toEqual([
      "first-poll",
      "conflict",
    ]);
    expect(result).toEqual({ code: 0, stderr: "" });
  });
});
