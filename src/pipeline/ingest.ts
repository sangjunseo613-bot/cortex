import { App, TFile, normalizePath } from "obsidian";
import { createHash } from "crypto";

/**
 * Ingest layer — read a source file, compute its hash, gather metadata for
 * the compile step. No LLM here.
 *
 * "Raw" semantics: any file the user wants to compile, whether it lives
 * under `0 raw/` or not. The compile pipeline accepts an active file even
 * when the vault has no raw folder yet (early-stage vault scenario).
 */

export interface IngestResult {
  /** Vault-relative path */
  source: string;
  /** SHA-256 hex of body (post-frontmatter) */
  sourceHash: string;
  /** Title — frontmatter title or basename */
  title: string;
  /** Tags from frontmatter */
  inheritedTags: string[];
  /** Body, possibly truncated to maxBodyChars */
  body: string;
  /** True if body was truncated */
  truncated: boolean;
  /** True if file lacks frontmatter `id` (raw-like) */
  isRaw: boolean;
}

/** Default cap on body length sent to Codex (token budget). */
const DEFAULT_MAX_BODY = 12_000;

export async function ingestFile(
  app: App,
  file: TFile,
  maxBodyChars = DEFAULT_MAX_BODY,
): Promise<IngestResult> {
  const raw = await app.vault.cachedRead(file);
  const { body, frontmatter } = splitFrontmatter(raw);
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter ?? {};

  const title =
    typeof fm.title === "string" && fm.title.trim()
      ? fm.title.trim()
      : file.basename;

  const inheritedTags = extractTags(fm.tags);

  let bodyOut = body.trim();
  let truncated = false;
  if (bodyOut.length > maxBodyChars) {
    bodyOut = bodyOut.slice(0, maxBodyChars) + "\n\n[…잘림…]";
    truncated = true;
  }

  const sourceHash = sha256Hex(body);

  return {
    source: file.path,
    sourceHash,
    title,
    inheritedTags,
    body: bodyOut,
    truncated,
    isRaw: !fm.id,
  };
}

/** Scan a folder for markdown files, returning candidates for compile. */
export function listIngestCandidates(app: App, folderPath: string): TFile[] {
  const prefix = normalizePath(folderPath.endsWith("/") ? folderPath : folderPath + "/");
  return app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ─── helpers ──────────────────────────────────────────────

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const trimmed = text.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) {
    return { frontmatter: "", body: trimmed };
  }
  const lines = trimmed.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { frontmatter: "", body: trimmed };
  return {
    frontmatter: lines.slice(1, endIdx).join("\n"),
    body: lines.slice(endIdx + 1).join("\n"),
  };
}

function extractTags(v: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) {
    for (const t of v) {
      const s = String(t).trim().replace(/^#/, "");
      if (s) out.push(s);
    }
  } else if (typeof v === "string") {
    for (const t of v.split(",")) {
      const s = t.trim().replace(/^#/, "");
      if (s) out.push(s);
    }
  }
  return out;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
