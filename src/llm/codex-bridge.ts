import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { App } from "obsidian";
import { CodexRunOptions, CodexRunResult } from "../types";

/**
 * Codex CLI bridge.
 *
 * Spawns `codex exec` with structured I/O so we can drive prompts deterministically:
 *
 *   codex exec
 *     --skip-git-repo-check     // works even outside git repos
 *     --ephemeral               // don't write session files
 *     --json                    // event stream on stdout (we mostly ignore for one-shots)
 *     --output-schema FILE      // JSON schema for last message
 *     --output-last-message FILE  // final answer goes here
 *     -C <cwd>
 *     <prompt>                  // sent on argv (or via stdin if too long)
 *
 * Authentication: this assumes `codex login` has been run once on this machine
 * with a ChatGPT Plus account. We surface a friendly error if it hasn't.
 *
 * Process model: spawned via `bash -lc` to inherit the user's shell PATH (codex
 * is typically installed via Homebrew/npm-g and not on Obsidian's default PATH).
 */

const execFileP = promisify(execFile);

let detectedBinary: string | null = null;
let detectionError: string | null = null;

/** Resolve the codex binary once per session. Returns null + sets detectionError on failure. */
async function detectCodex(): Promise<string | null> {
  if (detectedBinary) return detectedBinary;
  if (detectionError) return null;
  try {
    const { stdout } = await execFileP("bash", ["-lc", "command -v codex"]);
    const p = stdout.trim();
    if (!p) {
      detectionError = "codex 명령을 찾을 수 없습니다. `npm i -g @openai/codex` 또는 `brew install codex` 후 `codex login`을 실행하세요.";
      return null;
    }
    detectedBinary = p;
    return p;
  } catch (err) {
    detectionError = `codex 검색 실패: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

export function lastDetectionError(): string | null {
  return detectionError;
}

/** Reset detection cache — useful if user installs/logs in mid-session. */
export function resetCodexDetection(): void {
  detectedBinary = null;
  detectionError = null;
}

/**
 * Verify codex is installed and authenticated. Returns version string on
 * success, throws a Notice-friendly Error on failure.
 */
export async function verifyCodex(): Promise<{ version: string; binary: string }> {
  resetCodexDetection();
  const bin = await detectCodex();
  if (!bin) throw new Error(detectionError ?? "codex CLI를 찾지 못했습니다.");
  try {
    const { stdout } = await execFileP("bash", ["-lc", "codex --version"]);
    return { version: stdout.trim(), binary: bin };
  } catch (err) {
    throw new Error(
      `codex --version 실행 실패: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * One-shot Codex call. Builds tmp files for schema + last-message, spawns
 * codex, waits for exit, reads last-message, cleans up.
 */
export async function codexCall(options: CodexRunOptions): Promise<CodexRunResult> {
  const t0 = Date.now();
  const bin = await detectCodex();
  if (!bin) {
    throw new Error(
      detectionError ?? "codex CLI 미설치. `codex login`을 먼저 완료하세요.",
    );
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-codex-"));
  const schemaPath = options.outputSchema
    ? path.join(tmpDir, "schema.json")
    : null;
  const lastMsgPath = path.join(tmpDir, "result.txt");

  try {
    if (schemaPath && options.outputSchema) {
      await fs.writeFile(schemaPath, JSON.stringify(options.outputSchema, null, 2), "utf8");
    }

    const args: string[] = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--color", "never",
      "--output-last-message", lastMsgPath,
      "-C", options.cwd,
    ];
    if (schemaPath) {
      args.push("--output-schema", schemaPath);
    }

    // Always pass the prompt via stdin to avoid argv length limits and shell quoting.
    args.push("-");

    const result = await spawnAndWait(bin, args, options);

    let lastMessage = "";
    try {
      lastMessage = await fs.readFile(lastMsgPath, "utf8");
    } catch {
      // Codex may not have written it (e.g. on error). Caller decides what to do.
      lastMessage = "";
    }

    return {
      lastMessage: lastMessage.trim(),
      eventCount: result.eventCount,
      durationMs: Date.now() - t0,
      stderr: result.stderr.slice(0, 2000),
    };
  } finally {
    // Best-effort cleanup
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

interface SpawnResult {
  eventCount: number;
  stderr: string;
}

/**
 * Spawn codex, pipe prompt to stdin, count JSONL events on stdout, capture
 * stderr. Resolves on clean exit, rejects on non-zero exit / timeout / signal.
 */
function spawnAndWait(
  bin: string,
  args: string[],
  options: CodexRunOptions,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 60_000;

    let timer: NodeJS.Timeout | null = null;
    let killed = false;
    let stderrBuf = "";
    let stdoutTail = "";
    let eventCount = 0;

    // bash -lc to inherit user PATH
    const cmd = [bin, ...args.map(quote)].join(" ");
    const child = spawn("bash", ["-lc", cmd], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });

    timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // SIGKILL fallback after 3s if still alive
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }, 3000);
    }, timeoutMs);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        killed = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* noop */
        }
      });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutTail += chunk;
      // Each newline = one event. We don't actually parse them — counting is
      // enough for this layer; the result file holds the final answer.
      const lines = stdoutTail.split("\n");
      stdoutTail = lines.pop() ?? "";
      for (const l of lines) {
        if (l.trim()) eventCount++;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        reject(new Error(`codex 실행이 ${timeoutMs}ms 초과로 중단되었습니다.`));
        return;
      }
      if (code !== 0) {
        const tail = stderrBuf.slice(-1000);
        reject(
          new Error(
            `codex exec 실패 (code=${code}, signal=${signal}): ${tail || "no stderr"}`,
          ),
        );
        return;
      }
      resolve({ eventCount, stderr: stderrBuf });
    });

    // Write the prompt to stdin and close it.
    child.stdin.write(options.prompt);
    child.stdin.end();
  });
}

/** Resolve the absolute filesystem path of the vault. */
export function vaultBasePath(app: App): string | null {
  // @ts-expect-error basePath is only on FileSystemAdapter
  const p = app.vault.adapter.basePath;
  return typeof p === "string" ? p : null;
}

/** Minimal POSIX single-quote escaping for a shell argument. */
function quote(s: string): string {
  if (/^[A-Za-z0-9_./=:@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
