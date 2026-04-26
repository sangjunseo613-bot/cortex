import { App, TFile, normalizePath } from "obsidian";
import { ingestFile, listIngestCandidates, IngestResult } from "./ingest";
import { compileNote } from "../llm/compile-tasks";
import {
  CompileResult,
  CompiledConcept,
  CompiledEntity,
} from "../types";
import { appendAuditLog } from "./approval";

/**
 * Compile pipeline — single-file or batch.
 *
 *   ingestFile() → compileNote() → write candidate markdown files.
 *
 * Output layout:
 *   1 wiki/candidates/concepts/<slug>.md
 *   1 wiki/candidates/entities/<slug>.md
 *
 * Each candidate file carries the full provenance frontmatter so the user
 * can audit where every claim came from before promoting it. The Approval
 * Panel reads these files; the user moves them to `1 wiki/concepts/` etc.
 *
 * Idempotency: if the source hash matches an existing candidate's
 * `source_hash` frontmatter, we skip it (already compiled). Force re-compile
 * is available via `force: true`.
 */

const CONCEPT_DIR = "1 wiki/candidates/concepts";
const ENTITY_DIR = "1 wiki/candidates/entities";
/** Folders that may contain previously-compiled output we should NOT regenerate.
 *  Includes both the candidates queue AND the promoted destinations. The promoted
 *  ones live one level up (`wiki/concepts/`, `wiki/entities/`) once the user
 *  approves them in the Review panel. */
const COMPILE_OUTPUT_DIRS = [
  "1 wiki/candidates/concepts",
  "1 wiki/candidates/entities",
  "1 wiki/concepts",
  "1 wiki/entities",
];

export interface CompileOptions {
  /** Re-compile even if a candidate with the same source_hash exists. */
  force?: boolean;
  /** Per-call timeout (Codex). Default 120s. */
  timeoutMs?: number;
  /** Progress callback for batch mode. */
  onFile?: (path: string, status: "start" | "skip" | "done" | "error", detail?: string) => void;
}

export async function compileFile(
  app: App,
  file: TFile,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const t0 = Date.now();
  const ingested = await ingestFile(app, file);

  // Idempotency check
  if (!options.force) {
    if (await alreadyCompiled(app, ingested.sourceHash)) {
      options.onFile?.(file.path, "skip", "동일 source_hash 이미 존재");
      return {
        source: file.path,
        sourceHash: ingested.sourceHash,
        generatedAt: Date.now(),
        durationMs: Date.now() - t0,
        concepts: [],
        entities: [],
        modelTag: "skip",
        errors: [],
      };
    }
  }

  options.onFile?.(file.path, "start");

  let concepts: CompiledConcept[] = [];
  let entities: CompiledEntity[] = [];
  const errors: string[] = [];
  try {
    const out = await compileNote(
      app,
      {
        source: ingested.source,
        title: ingested.title,
        body: ingested.body,
        inheritedTags: ingested.inheritedTags,
      },
      options.timeoutMs ?? 120_000,
    );
    concepts = out.concepts;
    entities = out.entities;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    options.onFile?.(file.path, "error", errors[0]);
    await appendAuditLog(app, {
      ts: Date.now(),
      action: "compile",
      paths: [file.path],
      detail: `error: ${errors[0]}`,
    });
    return {
      source: file.path,
      sourceHash: ingested.sourceHash,
      generatedAt: Date.now(),
      durationMs: Date.now() - t0,
      concepts: [],
      entities: [],
      modelTag: "codex/exec",
      errors,
    };
  }

  const writtenPaths: string[] = [];
  for (const c of concepts) {
    const path = await writeConcept(app, ingested, c);
    writtenPaths.push(path);
  }
  for (const e of entities) {
    const path = await writeEntity(app, ingested, e);
    writtenPaths.push(path);
  }

  await appendAuditLog(app, {
    ts: Date.now(),
    action: "compile",
    paths: [file.path, ...writtenPaths],
    detail: `concepts=${concepts.length}, entities=${entities.length}`,
  });

  options.onFile?.(file.path, "done", `concepts=${concepts.length}, entities=${entities.length}`);

  return {
    source: file.path,
    sourceHash: ingested.sourceHash,
    generatedAt: Date.now(),
    durationMs: Date.now() - t0,
    concepts,
    entities,
    modelTag: "codex/exec",
    errors,
  };
}

/**
 * Compile every markdown file under `0 raw/` (or another folder).
 * Sequential to keep Codex load reasonable.
 */
export async function compileFolder(
  app: App,
  folder: string,
  options: CompileOptions = {},
): Promise<CompileResult[]> {
  const candidates = listIngestCandidates(app, folder);
  const results: CompileResult[] = [];
  for (const f of candidates) {
    results.push(await compileFile(app, f, options));
  }
  return results;
}

// ─── candidate writers ───────────────────────────────────

async function writeConcept(
  app: App,
  source: IngestResult,
  concept: CompiledConcept,
): Promise<string> {
  await ensureDir(app, CONCEPT_DIR);
  const filename = uniquePath(app, `${CONCEPT_DIR}/${concept.slug}.md`);
  const fm = renderFrontmatter({
    type: "concept",
    source: source.source,
    source_hash: source.sourceHash,
    generated_at: nowIso(),
    generated_by: "cortex/codex",
    provenance: concept.provenance,
    confidence: concept.confidence,
    tags: concept.tags,
  });

  const body = `# ${concept.claim}

> [!quote] 원본 발췌
> ${concept.excerpt.replace(/\n/g, "\n> ")}

## 출처
- 원본: [[${pathToWikilink(source.source)}]]
- 생성: ${nowIso()}
- provenance: \`${concept.provenance}\` · confidence: \`${concept.confidence}\`
`;

  await app.vault.adapter.write(filename, fm + body);
  return filename;
}

async function writeEntity(
  app: App,
  source: IngestResult,
  entity: CompiledEntity,
): Promise<string> {
  await ensureDir(app, ENTITY_DIR);
  const filename = uniquePath(app, `${ENTITY_DIR}/${entity.slug}.md`);
  const fm = renderFrontmatter({
    type: "entity",
    entity_type: entity.type,
    source: source.source,
    source_hash: source.sourceHash,
    generated_at: nowIso(),
    generated_by: "cortex/codex",
    provenance: entity.provenance,
    confidence: entity.confidence,
    tags: ["entity", entity.type],
  });

  const mentionsBlock =
    entity.mentions.length > 0
      ? entity.mentions.map((m) => `> ${m.replace(/\n/g, "\n> ")}`).join("\n>\n")
      : "_(원문에 발췌 없음)_";

  const body = `# ${entity.name}

**유형**: ${entity.type}

## 발췌
${mentionsBlock}

## 출처
- 원본: [[${pathToWikilink(source.source)}]]
- 생성: ${nowIso()}
- provenance: \`${entity.provenance}\` · confidence: \`${entity.confidence}\`
`;

  await app.vault.adapter.write(filename, fm + body);
  return filename;
}

// ─── helpers ─────────────────────────────────────────────

/** Render YAML frontmatter from a flat record. Only string/number/array/boolean. */
function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
      }
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  // Quote if it contains YAML-significant chars.
  if (/[:#\[\]{},&*!|>'"%@`?\-]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

async function ensureDir(app: App, dir: string): Promise<void> {
  const path = normalizePath(dir);
  // Recursively create
  const segments = path.split("/").filter(Boolean);
  let cur = "";
  for (const seg of segments) {
    cur = cur ? `${cur}/${seg}` : seg;
    if (!(await app.vault.adapter.exists(cur))) {
      await app.vault.adapter.mkdir(cur);
    }
  }
}

function uniquePath(app: App, path: string): string {
  const norm = normalizePath(path);
  if (!app.vault.getAbstractFileByPath(norm)) return norm;
  // Append -2, -3, ... until free.
  const dot = norm.lastIndexOf(".");
  const stem = dot > 0 ? norm.slice(0, dot) : norm;
  const ext = dot > 0 ? norm.slice(dot) : "";
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function pathToWikilink(p: string): string {
  // Strip extension for wikilink target
  return p.replace(/\.md$/i, "");
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Scan all four output folders (candidates + promoted) for an existing file
 * carrying the same source_hash. This is the idempotency guard for compile —
 * without it, re-running compile after the user approved candidates produces
 * duplicate concept/entity files (the candidates folder is empty post-approval
 * but the promoted folder holds the moved files).
 *
 * Cheap substring scan: source_hash is a hex string with no YAML-special chars
 * so it serializes without quotes. We check both forms for safety.
 */
async function alreadyCompiled(app: App, sourceHash: string): Promise<boolean> {
  const needleA = `source_hash: ${sourceHash}`;
  const needleB = `source_hash: "${sourceHash}"`;
  for (const dir of COMPILE_OUTPUT_DIRS.map(normalizePath)) {
    if (!(await app.vault.adapter.exists(dir))) continue;
    const list = await app.vault.adapter.list(dir);
    for (const f of list.files) {
      if (!f.endsWith(".md")) continue;
      try {
        const raw = await app.vault.adapter.read(f);
        if (raw.includes(needleA) || raw.includes(needleB)) return true;
      } catch {
        // ignore unreadable files
      }
    }
  }
  return false;
}
