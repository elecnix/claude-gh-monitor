import { spawn, type ChildProcess } from "node:child_process";

export type TargetKind = "pr" | "issue" | "run";

export interface Target {
  kind: TargetKind;
  owner: string;
  repo: string;
  number: number;
  host: string;
  runId?: number;
}

export interface MonitorOptions {
  interval?: number;
  events?: string[];
  backend?: string;
  backendEndpoint?: string;
  instance?: string;
  bin?: string;
}

export interface MonitorEvent {
  type: string;
  message?: string;
  detail?: string;
  commit_short_oid?: string;
  commit_url?: string;
  degraded_surface?: string;
  [key: string]: unknown;
}

export interface ChannelEvent {
  content: string;
  meta: Record<string, string>;
}

export interface SpawnHandlers {
  onEvent: (event: MonitorEvent) => void;
  onExit: (code: number | null, stderr: string) => void;
}

export interface MonitorHandle {
  child: ChildProcess;
  stop: () => void;
}

const DEFAULT_HOST = "github.com";
const MIN_INTERVAL_SECONDS = 10;

export function parseTarget(input: string, defaultHost?: string): Target {
  const value = input.trim();
  const host = normalizeHost(defaultHost || process.env.GH_HOST || DEFAULT_HOST);

  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 4) {
      const [owner, repo, marker, id] = segments;
      if (owner && repo && id) {
        if (marker === "pull") {
          return target("pr", owner, repo, parseNumber(id), url.host);
        }
        if (marker === "issues") {
          return target("issue", owner, repo, parseNumber(id), url.host);
        }
        if (marker === "actions" && segments[3] === "runs" && segments[4]) {
          return target("run", owner, repo, 0, url.host, parseNumber(segments[4]));
        }
      }
    }
    throw new Error(`Unsupported GitHub URL: ${value}`);
  }

  const shorthand = value.match(/^([^/\s#]+)\/([^/\s#]+)#([0-9]+)$/);
  if (shorthand?.[1] && shorthand[2] && shorthand[3]) {
    return target("pr", shorthand[1], shorthand[2], Number(shorthand[3]), host);
  }

  throw new Error(
    `Unsupported GitHub URL: ${value}. Use a PR URL, issue URL, Actions run URL, or owner/repo#number.`,
  );
}

export function targetFromParts(
  owner: string,
  repo: string,
  number: number,
  host?: string,
): Target {
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    throw new Error("owner, repo, and a positive pr_number are required");
  }
  return target("pr", owner, repo, number, normalizeHost(host || process.env.GH_HOST || DEFAULT_HOST));
}

export function runTargetFromParts(
  owner: string,
  repo: string,
  runId: number,
  host?: string,
): Target {
  if (!owner || !repo || !Number.isInteger(runId) || runId <= 0) {
    throw new Error("owner, repo, and a positive run_id are required");
  }
  return target("run", owner, repo, 0, normalizeHost(host || process.env.GH_HOST || DEFAULT_HOST), runId);
}

export function targetKey(value: Target): string {
  const resource =
    value.kind === "run"
      ? `run/${value.runId}`
      : value.kind === "issue"
        ? `issue/${value.number}`
        : String(value.number);
  return `${value.host}/${value.owner}/${value.repo}#${resource}`;
}

export function targetLabel(value: Target): string {
  return value.kind === "run"
    ? `${value.owner}/${value.repo} run #${value.runId}`
    : value.kind === "issue"
      ? `${value.owner}/${value.repo}#${value.number} (issue)`
      : `${value.owner}/${value.repo}#${value.number}`;
}

export function buildMonitorArgs(
  value: Target,
  options: MonitorOptions = {},
): string[] {
  const interval = Math.max(
    MIN_INTERVAL_SECONDS,
    Math.floor(options.interval ?? 60),
  );
  const args = [
    "-R",
    `${value.owner}/${value.repo}`,
    "--interval",
    String(interval),
  ];

  if (value.kind === "run") {
    args.push("--run-id", String(value.runId ?? 0));
  } else if (value.kind === "issue") {
    args.push("--issue", String(value.number));
  } else {
    args.push(String(value.number));
  }

  const events = [...new Set((options.events ?? []).map((item) => item.trim()).filter(Boolean))];
  if (events.length > 0) {
    args.push("--events", events.join(","));
  }
  if (options.backend) {
    args.push("--backend", options.backend);
  }
  if (options.backendEndpoint) {
    args.push("--backend-endpoint", options.backendEndpoint);
  }
  if (options.instance) {
    args.push("--instance", options.instance);
  }

  return args;
}

export function buildMonitorEnv(
  base: Record<string, string | undefined>,
  value: Target,
): Record<string, string | undefined> {
  const env = { ...base };
  if (value.host && value.host !== DEFAULT_HOST) {
    env.GH_HOST = value.host;
  } else {
    delete env.GH_HOST;
  }
  return env;
}

export class NdjsonParser {
  private buffer = "";

  push(chunk: string): MonitorEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => {
      const event = parseLine(line);
      return event ? [event] : [];
    });
  }

  flush(): MonitorEvent[] {
    const line = this.buffer;
    this.buffer = "";
    const event = parseLine(line);
    return event ? [event] : [];
  }
}

export function eventToChannel(
  event: MonitorEvent,
  value: Target,
): ChannelEvent | null {
  if (event.type === "first-poll") {
    return null;
  }

  const message = event.message || `gh monitor event: ${event.type}`;
  const content = event.detail ? `${message}\n\n${event.detail}` : message;
  const meta: Record<string, string> = {
    kind: event.type,
    host: value.host,
    repo: `${value.owner}/${value.repo}`,
  };

  if (value.number > 0) {
    meta.pr = String(value.number);
  }
  if (value.runId) {
    meta.run = String(value.runId);
  }

  const commit = event.commit_short_oid || commitFromUrl(event.commit_url);
  if (commit) {
    meta.commit = commit;
  }

  return { content, meta };
}

export function spawnGhMonitor(
  targetValue: Target,
  options: MonitorOptions,
  handlers: SpawnHandlers,
  baseEnv: Record<string, string | undefined> = process.env,
): MonitorHandle {
  const command = commandFor(targetValue, options);
  const child = spawn(command.bin, command.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildMonitorEnv(baseEnv, targetValue) as NodeJS.ProcessEnv,
  });

  const parser = new NdjsonParser();
  let stderr = "";
  let settled = false;

  const emit = (events: MonitorEvent[]) => {
    for (const event of events) {
      handlers.onEvent(event);
    }
  };

  const finish = (code: number | null) => {
    if (settled) {
      return;
    }
    settled = true;
    emit(parser.flush());
    handlers.onExit(code, stderr);
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => emit(parser.push(chunk)));
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    stderr += error.message;
    finish(null);
  });
  child.on("close", (code) => finish(code));

  return {
    child,
    stop: () => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    },
  };
}

export async function runGhMonitorOnce(
  targetValue: Target,
  options: MonitorOptions,
  baseEnv: Record<string, string | undefined> = process.env,
): Promise<MonitorEvent[]> {
  const command = commandFor(targetValue, options, true);
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildMonitorEnv(baseEnv, targetValue) as NodeJS.ProcessEnv,
    });
    const parser = new NdjsonParser();
    const events: MonitorEvent[] = [];
    let stderr = "";
    let settled = false;

    const finish = (code: number | null, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      events.push(...parser.flush());
      if (error) {
        reject(error);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `gh monitor --once exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      resolve(events);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      events.push(...parser.push(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

function commandFor(
  targetValue: Target,
  options: MonitorOptions,
  once = false,
): { bin: string; args: string[] } {
  const configuredBin = options.bin || process.env.GH_MONITOR_BIN;
  const args = buildMonitorArgs(targetValue, options);
  const monitorArgs = once ? [...args, "--once"] : args;

  if (configuredBin) {
    // A mock or direct binary receives the extension subargs without the
    // leading `monitor` extension name.
    return { bin: configuredBin, args: monitorArgs };
  }
  return { bin: "gh", args: ["monitor", ...monitorArgs] };
}

function parseLine(line: string): MonitorEvent | null {
  const value = line.trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as MonitorEvent).type === "string"
    ) {
      return parsed as MonitorEvent;
    }
  } catch {
    return null;
  }
  return null;
}

function target(
  kind: TargetKind,
  owner: string,
  repo: string,
  number: number,
  host: string,
  runId?: number,
): Target {
  return {
    kind,
    owner: decodeURIComponent(owner),
    repo: decodeURIComponent(repo),
    number,
    host: normalizeHost(host),
    ...(runId ? { runId } : {}),
  };
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase() || DEFAULT_HOST;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid GitHub resource number: ${value}`);
  }
  return parsed;
}

function commitFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = url.match(/\/commit\/([0-9a-f]{7,40})$/i);
  return match?.[1];
}
