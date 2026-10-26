import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";

let child: ChildProcessWithoutNullStreams;
let lines: Interface;
const pending = new Map<number, (value: Record<string, unknown>) => void>();
interface ChannelNotification {
  method: "notifications/claude/channel";
  params: { content: string; meta: Record<string, string> };
  [key: string]: unknown;
}
const notifications: ChannelNotification[] = [];
const channelWaiters: Array<{
  kind: string;
  resolve: (value: ChannelNotification) => void;
}> = [];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-gh-monitor-server-"));
  const bin = join(dir, "fake-gh-monitor");
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' '{"type":"first-poll","message":"ready"}' '{"type":"conflict","message":"Conflict now"}'
`,
  );
  await chmod(bin, 0o755);

  child = spawn("bun", ["run", "src/server.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GH_MONITOR_BIN: bin },
  });
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      [key: string]: unknown;
    };
    if (typeof message.id === "number") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "notifications/claude/channel") {
      const notification = message as unknown as ChannelNotification;
      notifications.push(notification);
      const kind = notification.params.meta.kind ?? "";
      for (const waiter of [...channelWaiters]) {
        if (waiter.kind === kind) {
          channelWaiters.splice(channelWaiters.indexOf(waiter), 1);
          waiter.resolve(notification);
        }
      }
    }
  });
});

afterAll(() => {
  lines.close();
  child.kill("SIGTERM");
});

function request(id: number, method: string, params?: unknown) {
  const response = new Promise<Record<string, unknown>>((resolve) => {
    pending.set(id, resolve);
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
  return response;
}

function waitForChannel(kind: string) {
  const existing = notifications.find(
    (message) => message.params?.meta?.kind === kind,
  );
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise<ChannelNotification>((resolve) => {
    channelWaiters.push({ kind, resolve });
  });
}

describe("MCP server", () => {
  test("advertises the channel capability and gh_monitor tool", async () => {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    expect(initialized.result).toMatchObject({
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: { listChanged: false },
      },
      serverInfo: { name: "claude-gh-monitor", version: "0.1.0" },
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request(2, "tools/list");
    expect(listed.result).toMatchObject({
      tools: [{ name: "gh_monitor" }],
    });

    const status = await request(3, "tools/call", {
      name: "gh_monitor",
      arguments: { action: "status" },
    });
    expect(status.result).toMatchObject({
      content: [{ type: "text", text: "No gh monitors are running." }],
    });

    const started = await request(4, "tools/call", {
      name: "gh_monitor",
      arguments: {
        action: "start",
        url: "owner/repo#42",
        interval: 10,
      },
    });
    expect(started.result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Started monitoring") }],
    });

    const event = await waitForChannel("conflict");
    expect(event.params).toMatchObject({
      content: "Conflict now",
      meta: {
        kind: "conflict",
        repo: "owner/repo",
        pr: "42",
      },
    });
  });
});
