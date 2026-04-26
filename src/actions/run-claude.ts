import { spawn, ChildProcess } from "child_process";
import { App } from "obsidian";

/**
 * Event types emitted by `claude -p --output-format=stream-json --verbose`.
 * We only subscribe to the subset we care about for UI progress.
 *
 * The Claude Code CLI emits newline-delimited JSON objects with shapes like:
 *
 *   {"type":"system","subtype":"init","session_id":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."},{"type":"tool_use","name":"Read","input":{...}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}}
 *   {"type":"result","subtype":"success","result":"...","total_cost_usd":0.0}
 */
export type ClaudeEvent =
  | {
      type: "system";
      subtype?: string;
      session_id?: string;
      model?: string;
      [k: string]: unknown;
    }
  | {
      type: "assistant";
      message: { content: ContentBlock[] };
    }
  | {
      type: "user";
      message: { content: ContentBlock[] };
    }
  | {
      type: "result";
      subtype: "success" | "error_max_turns" | "error" | string;
      result?: string;
      total_cost_usd?: number;
      num_turns?: number;
      duration_ms?: number;
    }
  | { type: "error"; message?: string };

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
    };

export interface ClaudeRunHandle {
  cancel: () => void;
  pid: number | undefined;
}

export interface ClaudeRunOptions {
  cwd: string;
  prompt: string;
  onEvent: (event: ClaudeEvent) => void;
  onStderr?: (chunk: string) => void;
  onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (err: Error) => void;
  /** Extra CLI flags. Default: --permission-mode=bypassPermissions */
  extraArgs?: string[];
}

/**
 * Spawn the `claude` CLI in print mode with structured JSON output.
 *
 * Uses `bash -lc` so the user's login-shell PATH is respected (claude is
 * typically installed via nvm/volta and not on Obsidian's default PATH).
 */
export function runClaude(options: ClaudeRunOptions): ClaudeRunHandle {
  // Defaults: auto-accept file edits & explicitly BLOCK AskUserQuestion.
  // In print mode the user can't answer an AskUserQuestion, so allowing it
  // wastes turns/tokens ($1+ seen in the wild). We hard-disallow it here;
  // Claude will either skip or route around. The SKILL.md files also
  // instruct autonomous behavior as belt-and-suspenders.
  const extra = options.extraArgs ?? [
    "--permission-mode=bypassPermissions",
    "--disallowed-tools=AskUserQuestion",
  ];

  // Prefix the prompt with an autonomous-mode reminder. Claude sees this as
  // part of the user turn — cheapest reinforcement.
  const hardened =
    "⚠️ AUTONOMOUS MODE — You are running in print-mode CLI with no " +
    "interactive user. Do NOT call AskUserQuestion (it is disallowed at the " +
    "CLI level). Do NOT write plain-text questions waiting for an answer. " +
    "Decide everything via heuristics, execute, and report.\n\n" +
    options.prompt;

  const script = [
    "claude",
    "-p",
    shellQuote(hardened),
    "--output-format=stream-json",
    "--verbose",
    ...extra,
  ].join(" ");

  let child: ChildProcess;
  try {
    child = spawn("bash", ["-lc", script], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Force color off to keep output parseable
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });
  } catch (err) {
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
    options.onClose(null, null);
    return { cancel: () => {}, pid: undefined };
  }

  let stdoutBuf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed) as ClaudeEvent;
        options.onEvent(evt);
      } catch {
        // Non-JSON line (banner, etc). Feed to stderr handler.
        options.onStderr?.(`[stdout] ${trimmed}\n`);
      }
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    options.onStderr?.(chunk);
  });

  child.on("error", (err) => {
    options.onError?.(err);
  });

  child.on("close", (code, signal) => {
    // Flush any trailing line
    const trailing = stdoutBuf.trim();
    if (trailing) {
      try {
        options.onEvent(JSON.parse(trailing) as ClaudeEvent);
      } catch {
        options.onStderr?.(`[trailing] ${trailing}\n`);
      }
    }
    options.onClose(code, signal);
  });

  return {
    cancel: () => {
      if (!child.killed) child.kill("SIGTERM");
    },
    pid: child.pid,
  };
}

/** Minimal POSIX single-quote escaping for a prompt argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── Event summarizer ─────────────────────────────────────────

export interface ProgressRow {
  kind: "info" | "tool" | "result" | "text" | "error";
  icon: string;
  text: string;
  detail?: string;
  /** Tool use id for pairing with later tool_result */
  toolUseId?: string;
  isError?: boolean;
}

/**
 * Turn a single stream-json event into zero or more ProgressRows suitable
 * for display. Truncates long inputs for readability.
 */
export function summarizeEvent(evt: ClaudeEvent): ProgressRow[] {
  const rows: ProgressRow[] = [];
  if (evt.type === "system") {
    if (evt.subtype === "init") {
      rows.push({
        kind: "info",
        icon: "▶",
        text: "Claude Code 세션 시작",
        detail: evt.model ? `model: ${evt.model}` : undefined,
      });
    }
    return rows;
  }

  if (evt.type === "assistant" || evt.type === "user") {
    for (const block of evt.message?.content ?? []) {
      if (block.type === "text") {
        const t = block.text.trim();
        if (!t) continue;
        rows.push({
          kind: "text",
          icon: evt.type === "assistant" ? "💬" : "📥",
          text: truncate(t, 200),
        });
      } else if (block.type === "tool_use") {
        rows.push({
          kind: "tool",
          icon: iconForTool(block.name),
          text: `${block.name}`,
          detail: summarizeToolInput(block.name, block.input),
          toolUseId: block.id,
        });
      } else if (block.type === "tool_result") {
        const isErr = block.is_error === true;
        const content =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((c) => (c.type === "text" ? c.text : ""))
                  .join("")
              : "";
        rows.push({
          kind: "tool",
          icon: isErr ? "❌" : "✓",
          text: isErr ? "tool error" : "tool ok",
          detail: truncate(content.trim(), 140),
          toolUseId: block.tool_use_id,
          isError: isErr,
        });
      }
    }
    return rows;
  }

  if (evt.type === "result") {
    const ok = evt.subtype === "success";
    rows.push({
      kind: "result",
      icon: ok ? "✅" : "❌",
      text: ok ? "완료" : `실패 (${evt.subtype})`,
      detail:
        evt.total_cost_usd !== undefined
          ? `$${evt.total_cost_usd.toFixed(4)} · ${evt.num_turns ?? "?"}턴 · ${Math.round((evt.duration_ms ?? 0) / 1000)}s`
          : undefined,
      isError: !ok,
    });
    return rows;
  }

  if (evt.type === "error") {
    rows.push({
      kind: "error",
      icon: "❌",
      text: "에러",
      detail: evt.message,
      isError: true,
    });
  }
  return rows;
}

function iconForTool(name: string): string {
  const map: Record<string, string> = {
    Read: "📖",
    Write: "✏️",
    Edit: "✂️",
    Bash: "🐚",
    Glob: "🔍",
    Grep: "🔎",
    TodoWrite: "✅",
    AskUserQuestion: "❓",
    WebFetch: "🌐",
    WebSearch: "🌐",
  };
  return map[name] ?? "🔧";
}

function summarizeToolInput(
  name: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!input) return undefined;
  switch (name) {
    case "Read":
      return abbreviatePath(str(input.file_path));
    case "Write":
      return abbreviatePath(str(input.file_path));
    case "Edit":
      return abbreviatePath(str(input.file_path));
    case "Bash":
      return truncate(str(input.command), 100);
    case "Glob":
      return str(input.pattern);
    case "Grep":
      return `${str(input.pattern)}${input.path ? ` in ${abbreviatePath(str(input.path))}` : ""}`;
    case "AskUserQuestion":
      return "(interactive — skipped)";
    default: {
      const keys = Object.keys(input).slice(0, 2);
      return keys.map((k) => `${k}=${truncate(str(input[k]), 40)}`).join(" ");
    }
  }
}

function abbreviatePath(p: string): string {
  if (!p) return "";
  // Strip vault root if present to keep rows short
  const idx = p.lastIndexOf("futurewave/");
  if (idx >= 0) return p.slice(idx + "futurewave/".length);
  return p.length > 80 ? "…" + p.slice(-80) : p;
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ─── Vault root resolver (needed by spawn cwd) ────────────────

/**
 * Resolve the absolute filesystem path of the vault.
 * `app.vault.adapter.basePath` exists on FileSystemAdapter (desktop).
 */
export function vaultBasePath(app: App): string | null {
  // @ts-expect-error basePath is only on FileSystemAdapter
  const p = app.vault.adapter.basePath;
  return typeof p === "string" ? p : null;
}
