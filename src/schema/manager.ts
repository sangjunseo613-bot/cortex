import { App, Notice, TFile, normalizePath } from "obsidian";
import * as YAML from "js-yaml";
import {
  CortexSchemaFile,
  IdentityFile,
  FolderRule,
  FolderType,
  RequiredFrontmatter,
} from "../types";
import {
  SCHEMA_FILE_PATH,
  IDENTITY_FILE_PATH,
  defaultSchemaTemplate,
  defaultIdentityTemplate,
} from "./templates";

/**
 * SchemaManager — single source of truth for `cortex.schema.md` and
 * `_index/IDENTITY.md`. Wraps file I/O, YAML parsing, and template-based
 * initialization.
 *
 * Caching: schema/identity are parsed lazily on first access and re-parsed
 * after `invalidate()`. The plugin invalidates on file-modify events for
 * either path so the in-memory copy stays fresh.
 */
export class SchemaManager {
  private schemaCache: CortexSchemaFile | null = null;
  private identityCache: IdentityFile | null = null;

  constructor(private app: App) {}

  // ─── Existence checks ──────────────────────────────────

  schemaPath(): string {
    return normalizePath(SCHEMA_FILE_PATH);
  }

  identityPath(): string {
    return normalizePath(IDENTITY_FILE_PATH);
  }

  async schemaExists(): Promise<boolean> {
    return this.app.vault.adapter.exists(this.schemaPath());
  }

  async identityExists(): Promise<boolean> {
    return this.app.vault.adapter.exists(this.identityPath());
  }

  // ─── Initialization ────────────────────────────────────

  /**
   * Create both files if they don't exist. Returns the list of newly created
   * paths. Does not overwrite existing files.
   */
  async initIfMissing(): Promise<string[]> {
    const created: string[] = [];

    if (!(await this.schemaExists())) {
      await this.writeFile(this.schemaPath(), defaultSchemaTemplate());
      created.push(this.schemaPath());
    }

    const idPath = this.identityPath();
    if (!(await this.identityExists())) {
      // Ensure parent dir exists (_index/)
      const dir = idPath.substring(0, idPath.lastIndexOf("/"));
      if (dir && !(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.writeFile(idPath, defaultIdentityTemplate());
      created.push(idPath);
    }

    this.invalidate();
    return created;
  }

  // ─── Loaders ───────────────────────────────────────────

  invalidate(): void {
    this.schemaCache = null;
    this.identityCache = null;
  }

  /** Returns null when the file is missing or unparseable (a Notice is shown). */
  async loadSchema(): Promise<CortexSchemaFile | null> {
    if (this.schemaCache) return this.schemaCache;
    if (!(await this.schemaExists())) return null;

    try {
      const raw = await this.app.vault.adapter.read(this.schemaPath());
      const parsed = parseSchema(raw);
      this.schemaCache = parsed;
      return parsed;
    } catch (err) {
      new Notice(
        `❌ cortex.schema.md 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
        10000,
      );
      return null;
    }
  }

  async loadIdentity(): Promise<IdentityFile | null> {
    if (this.identityCache) return this.identityCache;
    if (!(await this.identityExists())) return null;

    try {
      const raw = await this.app.vault.adapter.read(this.identityPath());
      const parsed = parseIdentity(raw);
      this.identityCache = parsed;
      return parsed;
    } catch (err) {
      new Notice(
        `❌ IDENTITY.md 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
        10000,
      );
      return null;
    }
  }

  // ─── Open helpers ──────────────────────────────────────

  async openSchemaFile(): Promise<void> {
    await this.openOrInit(this.schemaPath());
  }

  async openIdentityFile(): Promise<void> {
    await this.openOrInit(this.identityPath());
  }

  private async openOrInit(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    new Notice(
      `${path}가 없습니다. 'Cortex: 스키마 초기화' 명령으로 먼저 생성하세요.`,
      6000,
    );
  }

  // ─── Write helpers ─────────────────────────────────────

  /** Write a file via Vault.create when new, else adapter.write. */
  private async writeFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      await this.app.vault.adapter.write(path, content);
    } else {
      await this.app.vault.create(path, content);
    }
  }

  /**
   * Update only the auto-managed sections of IDENTITY.md
   * (`auto_god_nodes`, `core_clusters`). Manual sections + body markdown
   * are preserved verbatim. If IDENTITY.md does not exist, this is a no-op.
   *
   * Phase 2 calls this after running PageRank + Louvain.
   */
  async updateIdentityAutoSections(
    autoGodNodes: string[],
    coreClusters: string[],
  ): Promise<void> {
    if (!(await this.identityExists())) return;
    const path = this.identityPath();
    const raw = await this.app.vault.adapter.read(path);
    const updated = rewriteIdentityFrontmatter(raw, autoGodNodes, coreClusters);
    await this.app.vault.adapter.write(path, updated);
    this.invalidate();
  }
}

/**
 * Rewrite the YAML frontmatter of an IDENTITY.md file by replacing only the
 * `auto_god_nodes` and `core_clusters` keys. Preserves comment lines, key
 * order, and the body markdown.
 *
 * We use line-level surgery rather than YAML round-trip because js-yaml
 * doesn't preserve comments or quoting style — and IDENTITY.md is meant to
 * stay human-friendly.
 */
export function rewriteIdentityFrontmatter(
  raw: string,
  autoGodNodes: string[],
  coreClusters: string[],
): string {
  const trimmed = raw.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) {
    // No frontmatter — prepend a minimal one
    const fmYaml = renderAutoFmYaml(autoGodNodes, coreClusters);
    return `---\nversion: 1\nlast_reviewed: "${today()}"\nmanual_god_nodes: []\n${fmYaml}---\n\n${trimmed}`;
  }
  const lines = trimmed.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return raw; // malformed — leave alone

  const fmLines = lines.slice(1, endIdx);
  const newFm = replaceKey(
    replaceKey(fmLines, "auto_god_nodes", renderArray(autoGodNodes)),
    "core_clusters",
    renderArray(coreClusters),
  );

  return [
    "---",
    ...newFm,
    "---",
    ...lines.slice(endIdx + 1),
  ].join("\n");
}

function replaceKey(fmLines: string[], key: string, value: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  let replaced = false;
  for (const line of fmLines) {
    if (inBlock) {
      // Block continues while indentation is present (starts with whitespace) and line is not a top-level key.
      if (/^\s+/.test(line) || line.trim() === "") {
        // skip — we're replacing the entire block
        continue;
      }
      inBlock = false;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (m && m[1] === key) {
      out.push(`${key}: ${value}`);
      replaced = true;
      // Skip continuation lines of the old block
      inBlock = true;
      continue;
    }
    out.push(line);
  }
  if (!replaced) {
    out.push(`${key}: ${value}`);
  }
  return out;
}

function renderArray(items: string[]): string {
  if (items.length === 0) return "[]";
  // YAML inline flow with double-quoted strings (safe for korean / spaces / colons).
  return "[" + items.map(yamlQuote).join(", ") + "]";
}

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderAutoFmYaml(autoGod: string[], coreClusters: string[]): string {
  return `auto_god_nodes: ${renderArray(autoGod)}\ncore_clusters: ${renderArray(coreClusters)}\n`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Pure parsers (testable independently) ────────────────────────

/**
 * Split a markdown file into YAML frontmatter and body. The caller is
 * responsible for parsing the YAML further. Returns `{frontmatter, body}`
 * with empty defaults when no frontmatter delimiter is found.
 */
export function splitFrontmatter(text: string): {
  frontmatter: string;
  body: string;
} {
  // Frontmatter must start with "---" on the first line.
  const trimmed = text.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) {
    return { frontmatter: "", body: trimmed };
  }
  // Find the closing "---" on its own line.
  const lines = trimmed.split(/\r?\n/);
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    return { frontmatter: "", body: trimmed };
  }
  const frontmatter = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n");
  return { frontmatter, body };
}

export function parseSchema(text: string): CortexSchemaFile {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = (YAML.load(frontmatter) ?? {}) as Record<string, unknown>;

  const requiredFm = (fm.required_frontmatter ?? {}) as Record<string, unknown>;
  const required: RequiredFrontmatter = {
    permanent: toStringArray(requiredFm.permanent, ["id", "claim", "cluster", "tags"]),
    raw: toStringArray(requiredFm.raw, ["tags"]),
  };

  const folderRules: FolderRule[] = [];
  const rawRules = fm.folder_rules;
  if (Array.isArray(rawRules)) {
    for (const r of rawRules) {
      if (r && typeof r === "object") {
        const obj = r as Record<string, unknown>;
        const path = typeof obj.path === "string" ? obj.path : "";
        const type = isFolderType(obj.type) ? (obj.type as FolderType) : "raw";
        if (path) folderRules.push({ path, type });
      }
    }
  }

  return {
    version: typeof fm.version === "number" ? fm.version : 1,
    vaultPurpose: typeof fm.vault_purpose === "string" ? fm.vault_purpose.trim() : "",
    coreClusters: toStringArray(fm.core_clusters),
    allowedTags: toStringArray(fm.allowed_tags),
    requiredFrontmatter: required,
    folderRules,
    forbiddenWords: toStringArray(fm.forbidden_words),
    bodyMarkdown: body,
  };
}

export function parseIdentity(text: string): IdentityFile {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = (YAML.load(frontmatter) ?? {}) as Record<string, unknown>;

  return {
    version: typeof fm.version === "number" ? fm.version : 1,
    lastReviewed:
      typeof fm.last_reviewed === "string"
        ? fm.last_reviewed
        : new Date().toISOString().slice(0, 10),
    manualGodNodes: toStringArray(fm.manual_god_nodes),
    autoGodNodes: toStringArray(fm.auto_god_nodes),
    coreClusters: toStringArray(fm.core_clusters),
    bodyMarkdown: body,
  };
}

// ─── helpers ───────────────────────────────────────────────────────

function toStringArray(v: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => (x === null || x === undefined ? "" : String(x).trim()))
      .filter(Boolean);
  }
  if (typeof v === "string" && v.trim()) {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return fallback;
}

function isFolderType(v: unknown): boolean {
  return (
    typeof v === "string" &&
    ["raw", "compiled", "permanent", "archive", "candidates", "outputs"].includes(v)
  );
}
