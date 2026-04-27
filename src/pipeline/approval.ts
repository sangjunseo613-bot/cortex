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
 * Result of a promote attempt. Allows the caller to distinguish:
 *   - moved   : 정상 승인 (destination 비어있어서 그냥 이동)
 *   - merged  : entity 병합 (destination 존재 → 발췌·출처 추가)
 *   - skipped : 중복 (concept 같은 이름 또는 entity 같은 source_hash)
 *   - error   : 실제 실패
 */
export type PromoteResult =
  | { kind: "moved"; dest: string }
  | { kind: "merged"; dest: string; addedMentions: number }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

/**
 * Promote a candidate intelligently.
 *
 * Branching when destination already exists:
 *   - **concept**: silent skip — concepts are atomic propositions, same-named
 *                  one means the proposition was already approved earlier.
 *                  We delete the candidate to clear the queue.
 *   - **entity**:  attempt MERGE — entities are backlink hubs by design.
 *                  Same name across multiple raw notes is normal and the
 *                  whole point. We append the candidate's mentions/source
 *                  to the existing destination, then delete the candidate.
 *                  If the candidate's source_hash already appears in the
 *                  destination, we skip (already merged earlier).
 */
export async function promoteCandidate(app: App, path: string): Promise<PromoteResult> {
  const norm = normalizePath(path);
  if (!norm.startsWith(`${CANDIDATES_ROOT}/`)) {
    return { kind: "error", message: `승인 대상이 candidates 폴더에 없습니다: ${path}` };
  }

  const file = app.vault.getAbstractFileByPath(norm);
  if (!(file instanceof TFile)) {
    return { kind: "error", message: `파일을 찾을 수 없습니다: ${path}` };
  }

  const dest = norm.replace(`${CANDIDATES_ROOT}/`, "1 wiki/");
  const isEntity = norm.startsWith(`${CANDIDATES_ROOT}/entities/`);
  await ensureDirOf(app, dest);

  // ── Path A: destination empty → simple move (Phase 4 original behavior) ─
  const destExists = await app.vault.adapter.exists(dest);
  if (!destExists) {
    try {
      await app.fileManager.renameFile(file, dest);
      await appendAuditLog(app, {
        ts: Date.now(),
        action: "approve",
        paths: [norm, dest],
      });
      return { kind: "moved", dest };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Path B: destination exists ─────────────────────────────────────────
  if (!isEntity) {
    // Concept: silent skip + delete candidate
    try {
      await app.fileManager.trashFile(file);
      await appendAuditLog(app, {
        ts: Date.now(),
        action: "skip",
        paths: [norm],
        detail: `dest exists: ${dest}`,
      });
      return { kind: "skipped", reason: `이미 같은 이름의 concept 존재 (${dest})` };
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Entity merge path
  try {
    const candRaw = await app.vault.adapter.read(norm);
    const dstRaw = await app.vault.adapter.read(dest);
    const candFm = parseShallowFrontmatter(candRaw);
    const dstFm = parseShallowFrontmatter(dstRaw);

    // Detect already-merged case via source_hash
    const candHash = String(candFm.source_hash ?? "").trim();
    if (candHash && dstRawContainsHash(dstRaw, candHash)) {
      // already merged — drop candidate
      await app.fileManager.trashFile(file);
      await appendAuditLog(app, {
        ts: Date.now(),
        action: "skip",
        paths: [norm],
        detail: `source_hash already merged: ${candHash.slice(0, 12)}…`,
      });
      return { kind: "skipped", reason: "동일 source_hash가 이미 병합됨" };
    }

    // Merge mentions and source list into the destination
    const candMentions = extractMentions(candRaw);
    const candSource = String(candFm.source ?? "").trim();
    const merged = mergeEntityFile(dstRaw, {
      newMentions: candMentions,
      newSource: candSource,
      newSourceHash: candHash,
      newGeneratedAt: String(candFm.generated_at ?? new Date().toISOString()),
      newTags: Array.isArray(candFm.tags) ? candFm.tags.map(String) : [],
    });
    await app.vault.adapter.write(dest, merged.content);
    await app.fileManager.trashFile(file);

    await appendAuditLog(app, {
      ts: Date.now(),
      action: "approve",
      paths: [norm, dest],
      detail: `merged: +${merged.addedMentions} mentions, +1 source`,
    });

    return { kind: "merged", dest, addedMentions: merged.addedMentions };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
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

// ─── Entity merge helpers ─────────────────────────────────

/** Cheap substring check — source_hash serializes without quotes (hex). */
function dstRawContainsHash(raw: string, hash: string): boolean {
  if (!hash) return false;
  return (
    raw.includes(`source_hash: ${hash}`) ||
    raw.includes(`source_hash: "${hash}"`) ||
    raw.includes(`- source_hash: ${hash}`)
  );
}

/**
 * Extract `> ` quoted mention lines from a candidate's `## 발췌` section.
 * Resilient to extra blank lines or callouts.
 */
function extractMentions(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^##\s+발췌\s*$/.test(l));
  if (idx < 0) return [];
  const out: string[] = [];
  let buf: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break; // next section
    if (/^>\s?/.test(line)) {
      buf.push(line.replace(/^>\s?/, ""));
    } else if (line.trim() === "") {
      if (buf.length > 0) {
        out.push(buf.join("\n"));
        buf = [];
      }
    } else if (line.trim() === ">") {
      // separator between blockquote items
      if (buf.length > 0) {
        out.push(buf.join("\n"));
        buf = [];
      }
    }
  }
  if (buf.length > 0) out.push(buf.join("\n"));
  return out.map((m) => m.trim()).filter(Boolean);
}

/**
 * Merge new content into an existing entity markdown.
 * - Appends new (deduped) mentions to `## 발췌`.
 * - Appends a new `- 원본: [[...]]` line under `## 출처`.
 * - Appends a hidden `<!-- merged-source: ... -->` HTML comment with the
 *   candidate's source_hash so future merges can detect dedup.
 * - Unions tags into frontmatter.
 *
 * Returns the rewritten content + count of mentions actually added.
 */
function mergeEntityFile(
  dstRaw: string,
  payload: {
    newMentions: string[];
    newSource: string;
    newSourceHash: string;
    newGeneratedAt: string;
    newTags: string[];
  },
): { content: string; addedMentions: number } {
  let content = dstRaw;

  // 1. Append new mentions to `## 발췌` (dedup against existing ones).
  const existingMentions = new Set(extractMentions(dstRaw).map(normalizeForCompare));
  const toAdd = payload.newMentions.filter(
    (m) => !existingMentions.has(normalizeForCompare(m)),
  );

  if (toAdd.length > 0) {
    const block = toAdd
      .map((m) => `> ${m.replace(/\n/g, "\n> ")}`)
      .join("\n>\n");
    // Insert before the next `## 출처` if present, else at end of `## 발췌`.
    if (/^##\s+발췌\s*$/m.test(content)) {
      content = content.replace(
        /(##\s+발췌\s*\n[\s\S]*?)(?=\n##\s+|$)/m,
        (whole) => whole.replace(/\s*$/, "\n>\n" + block + "\n"),
      );
    } else {
      // Defensive: file lacks `## 발췌` — append fresh section.
      content += `\n\n## 발췌\n${block}\n`;
    }
  }

  // 2. Append new source line + merge marker comment.
  const sourceLine = payload.newSource
    ? `- 원본: [[${payload.newSource.replace(/\.md$/i, "")}]] (병합: ${payload.newGeneratedAt.slice(0, 19)})`
    : "";
  const hashMarker = payload.newSourceHash
    ? `<!-- merged-source: ${payload.newSourceHash} -->`
    : "";
  if (sourceLine || hashMarker) {
    if (/^##\s+출처\s*$/m.test(content)) {
      content = content.replace(
        /(##\s+출처\s*\n[\s\S]*?)(?=\n##\s+|$)/m,
        (whole) => whole.replace(/\s*$/, `\n${sourceLine}\n${hashMarker}\n`),
      );
    } else {
      content += `\n\n## 출처\n${sourceLine}\n${hashMarker}\n`;
    }
  }

  // 3. Union tags into frontmatter (line-level surgery to preserve comments).
  if (payload.newTags.length > 0) {
    content = unionTagsInFrontmatter(content, payload.newTags);
  }

  return { content, addedMentions: toAdd.length };
}

function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Add new tags to the frontmatter `tags:` block without disturbing other keys.
 * If a tag already exists, it's not duplicated.
 */
function unionTagsInFrontmatter(raw: string, newTags: string[]): string {
  const trimmed = raw.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) return raw;
  const lines = trimmed.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return raw;

  // Find tags block
  let tagsKeyIdx = -1;
  for (let i = 1; i < endIdx; i++) {
    if (/^tags\s*:\s*$/.test(lines[i])) {
      tagsKeyIdx = i;
      break;
    }
  }
  if (tagsKeyIdx < 0) return raw; // no tags block — leave alone

  // Collect existing list items
  const existingTags = new Set<string>();
  let lastListLine = tagsKeyIdx;
  for (let i = tagsKeyIdx + 1; i < endIdx; i++) {
    const m = lines[i].match(/^\s+-\s+(.+?)\s*$/);
    if (!m) break;
    existingTags.add(stripQuotes(m[1]).toLowerCase());
    lastListLine = i;
  }

  const additions: string[] = [];
  for (const t of newTags) {
    const k = t.replace(/^#/, "").trim();
    if (k && !existingTags.has(k.toLowerCase())) additions.push(`  - ${k}`);
  }
  if (additions.length === 0) return raw;

  return [
    ...lines.slice(0, lastListLine + 1),
    ...additions,
    ...lines.slice(lastListLine + 1),
  ].join("\n");
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
