import { App, TFile, normalizePath } from "obsidian";
import {
  CortexSchemaFile,
  IdentityFile,
  LintReport,
  LintViolation,
  FolderRule,
  FolderType,
} from "../types";
import { LINT_REPORT_PATH, lintReportHeader } from "./templates";

/**
 * Phase 1 lint engine.
 *
 * Rules implemented:
 *
 *   1. schema-missing       — cortex.schema.md absent
 *   2. identity-missing     — _index/IDENTITY.md absent
 *   3. missing-frontmatter  — required field missing for the note's folder type
 *   4. folder-mismatch      — note has `id` in raw folder OR no `id` in permanent folder
 *   5. tag-not-allowed      — tag not in allowed_tags whitelist (only when whitelist is non-empty)
 *   6. forbidden-word       — forbidden_words present in body (case-insensitive)
 *   7. cluster-not-core     — note in permanent folder uses cluster not in core_clusters
 *                             (only when core_clusters is non-empty; warn)
 *   8. orphan-permanent     — permanent note with no `links` and no backlink hint in frontmatter
 *                             (best-effort; full backlink graph is Phase 2)
 *
 * Each rule is independently applied per file. Violations are returned as a
 * flat list along with file count. The caller decides how to render.
 */
export async function runLint(
  app: App,
  schema: CortexSchemaFile | null,
  identity: IdentityFile | null,
): Promise<LintReport> {
  const violations: LintViolation[] = [];
  const scannedAt = Date.now();

  // ── Schema/Identity presence ─────────────────────────
  if (!schema) {
    violations.push({
      severity: "error",
      rule: "schema-missing",
      file: "cortex.schema.md",
      message: "cortex.schema.md가 없습니다.",
      fix: "명령 'Cortex: 스키마 초기화' 실행",
    });
  }
  if (!identity) {
    violations.push({
      severity: "error",
      rule: "identity-missing",
      file: "_index/IDENTITY.md",
      message: "_index/IDENTITY.md가 없습니다.",
      fix: "명령 'Cortex: 스키마 초기화' 실행",
    });
  }

  // Without a schema we can't check per-note rules.
  if (!schema) {
    return { scannedAt, filesScanned: 0, violations };
  }

  const files = app.vault.getMarkdownFiles();
  let filesScanned = 0;

  // Pre-build folder rules sorted by length (longest match wins for nested rules).
  const sortedRules = [...schema.folderRules].sort(
    (a, b) => b.path.length - a.path.length,
  );

  for (const f of files) {
    // Skip the schema/identity/lint report files themselves
    if (
      f.path === normalizePath("cortex.schema.md") ||
      f.path === normalizePath("_index/IDENTITY.md") ||
      f.path === normalizePath(LINT_REPORT_PATH) ||
      f.path.startsWith("_index/")
    ) {
      continue;
    }
    filesScanned++;

    const rule = matchFolderRule(f.path, sortedRules);
    const cache = app.metadataCache.getFileCache(f);
    const fm = cache?.frontmatter ?? {};

    // ── Required frontmatter ──────────────────────────
    if (rule) {
      const required = requiredForType(schema, rule.type);
      for (const field of required) {
        if (!hasFrontmatterField(fm, field)) {
          violations.push({
            severity: "error",
            rule: "missing-frontmatter",
            file: f.path,
            message: `${rule.type} 노트에 frontmatter \`${field}\`가 없습니다.`,
            fix: `${field}: <값> 을 frontmatter에 추가`,
          });
        }
      }
    }

    // ── Folder mismatch ────────────────────────────────
    if (rule?.type === "raw" && hasFrontmatterField(fm, "id")) {
      violations.push({
        severity: "warn",
        rule: "folder-mismatch",
        file: f.path,
        message: `raw 폴더에 \`id\`가 있는 노트입니다. 영구노트라면 \`${permanentFolderHint(schema)}\`로 옮기세요.`,
      });
    }
    if (rule?.type === "permanent" && !hasFrontmatterField(fm, "id")) {
      violations.push({
        severity: "warn",
        rule: "folder-mismatch",
        file: f.path,
        message: "permanent 폴더에 `id`가 없는 노트입니다. raw 폴더로 옮기거나 id를 부여하세요.",
      });
    }

    // ── Tag whitelist ──────────────────────────────────
    if (schema.allowedTags.length > 0) {
      const tags = readStringArray(fm.tags);
      const allowed = new Set(schema.allowedTags);
      for (const t of tags) {
        if (!allowed.has(t)) {
          violations.push({
            severity: "warn",
            rule: "tag-not-allowed",
            file: f.path,
            message: `태그 \`${t}\`가 allowed_tags 화이트리스트에 없습니다.`,
            fix: `cortex.schema.md의 allowed_tags에 추가하거나 노트의 태그를 수정`,
          });
        }
      }
    }

    // ── Cluster core check (warn) ──────────────────────
    if (
      rule?.type === "permanent" &&
      schema.coreClusters.length > 0 &&
      typeof fm.cluster === "string" &&
      fm.cluster.trim()
    ) {
      const c = fm.cluster.trim();
      if (!schema.coreClusters.includes(c)) {
        violations.push({
          severity: "info",
          rule: "cluster-not-core",
          file: f.path,
          message: `cluster \`${c}\`가 core_clusters에 없습니다 (신규 클러스터일 수 있음).`,
        });
      }
    }

    // ── Forbidden words ────────────────────────────────
    if (schema.forbiddenWords.length > 0) {
      try {
        const body = await app.vault.cachedRead(f);
        const lower = body.toLowerCase();
        for (const word of schema.forbiddenWords) {
          const w = word.toLowerCase().trim();
          if (!w) continue;
          if (lower.includes(w)) {
            violations.push({
              severity: "warn",
              rule: "forbidden-word",
              file: f.path,
              message: `forbidden_word \`${word}\` 발견됨.`,
              fix: "본문에서 단어를 제거하거나 schema의 forbidden_words를 수정",
            });
          }
        }
      } catch {
        // Read failure is unusual; skip word check rather than fail the run.
      }
    }

    // ── Orphan permanent (best-effort) ─────────────────
    if (rule?.type === "permanent") {
      const links = readStringArray(fm.links);
      if (links.length === 0) {
        violations.push({
          severity: "info",
          rule: "orphan-permanent",
          file: f.path,
          message: "frontmatter `links`가 비어있습니다 (full backlink 검사는 Phase 2).",
        });
      }
    }
  }

  return { scannedAt, filesScanned, violations };
}

/**
 * Render a lint report as markdown and write to `_index/CORTEX_LINT_REPORT.md`.
 * Returns the path written to.
 */
export async function writeLintReport(app: App, report: LintReport): Promise<string> {
  const path = normalizePath(LINT_REPORT_PATH);
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir && !(await app.vault.adapter.exists(dir))) {
    await app.vault.adapter.mkdir(dir);
  }

  const md = renderReportMarkdown(report);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) {
    await app.vault.adapter.write(path, md);
  } else {
    await app.vault.create(path, md);
  }
  return path;
}

function renderReportMarkdown(report: LintReport): string {
  const lines: string[] = [];
  lines.push(lintReportHeader(report.scannedAt, report.filesScanned, report.violations.length));

  if (report.violations.length === 0) {
    lines.push("✅ **위반 사항 없음.** 정체성 가드 통과.\n");
    return lines.join("");
  }

  // Group by severity
  const bySev: Record<string, LintViolation[]> = { error: [], warn: [], info: [] };
  for (const v of report.violations) bySev[v.severity].push(v);

  const sections: Array<[string, string, LintViolation[]]> = [
    ["error", "❌ Error", bySev.error],
    ["warn", "⚠ Warn", bySev.warn],
    ["info", "ℹ Info", bySev.info],
  ];

  for (const [, label, items] of sections) {
    if (items.length === 0) continue;
    lines.push(`## ${label} (${items.length})\n\n`);
    for (const v of items) {
      lines.push(`- **${v.rule}** — \`${v.file}\`\n`);
      lines.push(`  - ${v.message}\n`);
      if (v.fix) lines.push(`  - 💡 ${v.fix}\n`);
    }
    lines.push("\n");
  }

  return lines.join("");
}

// ─── helpers ─────────────────────────────────────────────

function matchFolderRule(filePath: string, rules: FolderRule[]): FolderRule | null {
  for (const r of rules) {
    if (filePath.startsWith(r.path)) return r;
  }
  return null;
}

function requiredForType(schema: CortexSchemaFile, type: FolderType): string[] {
  if (type === "permanent") return schema.requiredFrontmatter.permanent;
  if (type === "raw") return schema.requiredFrontmatter.raw;
  // compiled/candidates/outputs/archive: no required frontmatter at this phase.
  return [];
}

function hasFrontmatterField(fm: Record<string, unknown>, field: string): boolean {
  if (!(field in fm)) return false;
  const v = fm[field];
  if (v === null || v === undefined) return false;
  if (typeof v === "string" && v.trim() === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function readStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function permanentFolderHint(schema: CortexSchemaFile): string {
  const r = schema.folderRules.find((r) => r.type === "permanent");
  return r?.path ?? "2 Permanent/";
}
