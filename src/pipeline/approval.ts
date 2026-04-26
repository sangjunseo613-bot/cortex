import { App, TFile, normalizePath } from "obsidian";
import { ApprovalItem, AuditEntry } from "../types";

/**
 * Approval queue management.
 *
 * A "candidate" is any file under `1 wiki/candidates/` produced by the
 * compile pipeline. Promote = move file to its sibling `concepts/` or
 * `entities/` (one level up). Reject = delete + log.
 *
 * Audit log: append-only NDJSON at `state/audit-log.ndjson`. Every
 * compile/approve/reject mutates this file. Useful for drift analysis later
 * (Phase 5) and for "show me what I rejected" queries.
 */

const CANDIDATES_ROOT = "1 wiki/candidates";
const AUDIT_LOG_PATH = ".obsidian/plugins/cortex/state/audit-log.ndjson";

export async function listApprovalQueue(app: App): Promise<ApprovalItem[]> {
  const root = normalizePath(CANDIDATES_ROOT);
  if (!(await app.vault.adapter.exists(root))) return [];

  const out: ApprovalItem[] = [];
  for (const sub of ["concepts", "entities"]) {
    const dir = `${root}/${sub}`;
    if (!(await app.vault.adapter.exists(dir))) continue;
    const list = await app.vault.adapter.list(dir);
    for (const f of list.files) {
      if (!f.endsWith(".md")) continue;
      const item = await readCandidate(app, f, sub as "concepts" | "entities");
      if (item) out.push(item);
    }
  }
  // Newest first
  out.sort((a, b) => b.generatedAt - a.generatedAt);
  return out;
}

async function readCandidate(
  app: App,
  path: string,
  sub: "concepts" | "entities",
): Promise<ApprovalItem | null> {
  try {
    const raw = await app.vault.adapter.read(path);
    const fm = parseShallowFrontmatter(raw);
    const claim = extractFirstHeading(raw) ?? "(제목 없음)";
    return {
      path,
      source: typeof fm.source === "string" ? fm.source : "(unknown)",
      type: sub === "concepts" ? "concept" : "entity",
      claim,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      generatedAt: parseIsoToMs(fm.generated_at) ?? 0,
      confidence: clamp012(fm.confidence as number),
      provenance: clampProvenance(String(fm.provenance ?? "extracted")),
    };
  } catch {
    return null;
  }
}

/**
 * Promote a candidate. Moves the file from `wiki/candidates/<sub>/X.md` to
 * `wiki/<sub>/X.md`. Auto-creates the destination folder.
 */
export async function promoteCandidate(app: App, path: string): Promise<string> {
  const norm = normalizePath(path);
  if (!norm.startsWith(`${CANDIDATES_ROOT}/`)) {
    throw new Error(`승인 대상이 candidates 폴더에 없습니다: ${path}`);
  }
  const dest = norm.replace(`${CANDIDATES_ROOT}/`, "1 wiki/");
  await ensureDirOf(app, dest);

  const file = app.vault.getAbstractFileByPath(norm);
  if (file instanceof TFile) {
    await app.fileManager.renameFile(file, dest);
  } else {
    throw new Error(`파일을 찾을 수 없습니다: ${path}`);
  }

  await appendAuditLog(app, {
    ts: Date.now(),
    action: "approve",
    paths: [norm, dest],
  });

  return dest;
}

/** Reject = delete + log. */
export async function rejectCandidate(app: App, path: string): Promise<void> {
  const norm = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(norm);
  if (file instanceof TFile) {
    await app.fileManager.trashFile(file);
  }
  await appendAuditLog(app, {
    ts: Date.now(),
    action: "reject",
    paths: [norm],
  });
}

/** Append a JSON line to the audit log. Best-effort; swallows write errors. */
export async function appendAuditLog(app: App, entry: AuditEntry): Promise<void> {
  try {
    const path = normalizePath(AUDIT_LOG_PATH);
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (!(await app.vault.adapter.exists(dir))) {
      await app.vault.adapter.mkdir(dir);
    }
    let prev = "";
    if (await app.vault.adapter.exists(path)) {
      prev = await app.vault.adapter.read(path);
    }
    const line = JSON.stringify(entry) + "\n";
    await app.vault.adapter.write(path, prev + line);
  } catch (err) {
    console.warn("[cortex] audit log write failed:", err);
  }
}

// ─── helpers ──────────────────────────────────────────────

async function ensureDirOf(app: App, filePath: string): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  const segments = dir.split("/").filter(Boolean);
  let cur = "";
  for (const seg of segments) {
    cur = cur ? `${cur}/${seg}` : seg;
    if (!(await app.vault.adapter.exists(cur))) {
      await app.vault.adapter.mkdir(cur);
    }
  }
}

/** Tiny YAML frontmatter parser sufficient for our generated files. */
function parseShallowFrontmatter(raw: string): Record<string, unknown> {
  const trimmed = raw.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) return {};
  const lines = trimmed.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return {};
  const out: Record<string, unknown> = {};
  let curKey: string | null = null;
  let curList: string[] | null = null;
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    if (curList && /^\s+-\s+/.test(line)) {
      const item = line.replace(/^\s+-\s+/, "").trim();
      curList.push(stripQuotes(item));
      continue;
    }
    if (curKey && curList) {
      out[curKey] = curList;
      curKey = null;
      curList = null;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valRaw = m[2];
    if (valRaw === "" || valRaw === undefined) {
      // List start
      curKey = key;
      curList = [];
      continue;
    }
    if (valRaw === "[]") {
      out[key] = [];
      continue;
    }
    // Scalar
    out[key] = parseScalar(valRaw);
  }
  if (curKey && curList) out[curKey] = curList;
  return out;
}

function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  return stripQuotes(t);
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return t;
}

function extractFirstHeading(raw: string): string | null {
  // Skip frontmatter
  let body = raw;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end > 0) body = body.slice(end + 4);
  }
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function parseIsoToMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function clamp012(n: unknown): 0 | 1 | 2 {
  if (typeof n !== "number") return 0;
  if (n <= 0) return 0;
  if (n >= 2) return 2;
  return 1;
}

function clampProvenance(p: string): "extracted" | "inferred" | "ambiguous" {
  if (p === "inferred" || p === "ambiguous") return p;
  return "extracted";
}
