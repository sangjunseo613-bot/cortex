import { App, TFile } from "obsidian";
import { GraphStore } from "./graph-store";

/**
 * Vault scanner — populates a GraphStore by reading every markdown file's
 * frontmatter and wikilinks. Designed to work even when the vault has no
 * `_index/VAULT_INDEX.md` (Phase 2 generates it from this graph).
 *
 * Node id strategy:
 *   - frontmatter.id present  →  use it directly
 *   - else                    →  use the file's basename
 *
 * Edge sources:
 *   - frontmatter.links[]     →  edge type "frontmatter"
 *   - body wikilinks `[[X]]`  →  edge type "wikilink"
 *
 * Phantom nodes: when a wikilink target can't be resolved to an existing file,
 * we still create a node for it (isPhantom: true). This lets discovery later
 * suggest "you keep referencing X but never created the note".
 */

export interface BuildOptions {
  /** Folder paths (with trailing slash) that should be excluded from scanning. */
  excludeFolders?: string[];
  /** Include body wikilink edges. Default true. */
  includeWikilinks?: boolean;
}

export interface BuildResult {
  filesScanned: number;
  realNodes: number;
  phantomNodes: number;
  edges: number;
  errors: string[];
  durationMs: number;
}

const DEFAULT_EXCLUDE = [".obsidian/", "_index/"];

export async function buildGraphFromVault(
  app: App,
  store: GraphStore,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const exclude = new Set(options.excludeFolders ?? DEFAULT_EXCLUDE);
  const includeWiki = options.includeWikilinks !== false;

  store.clear();

  // ── Pass 1: register a node for every markdown file ──────────
  const files: TFile[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (shouldExclude(f.path, exclude)) continue;
    if (f.path === "cortex.schema.md") continue;
    files.push(f);

    const cache = app.metadataCache.getFileCache(f);
    const fm = cache?.frontmatter ?? {};
    const id = chooseNodeId(f, fm);
    const claim = chooseClaim(f, fm);
    const tags = readTags(fm, cache?.tags);
    const isRaw = !fm.id;

    store.upsertNode(id, {
      claim,
      cluster: typeof fm.cluster === "string" ? fm.cluster.trim() : "",
      tags,
      filePath: f.path,
      isPhantom: false,
      isRaw,
    });
  }

  // ── Pass 2: edges from frontmatter `links` ────────────────────
  for (const f of files) {
    const cache = app.metadataCache.getFileCache(f);
    const fm = cache?.frontmatter ?? {};
    const srcId = chooseNodeId(f, fm);
    const fmLinks = readStringArray(fm.links);
    for (const target of fmLinks) {
      const dstId = resolveLinkpath(app, target, f.path);
      if (!dstId) {
        // Phantom: keep the link target as-is.
        store.upsertEdge(srcId, target, { source: "frontmatter", weight: 1 });
        continue;
      }
      store.upsertEdge(srcId, dstId, { source: "frontmatter", weight: 1 });
    }
  }

  // ── Pass 3: edges from body wikilinks via metadataCache.links ─
  if (includeWiki) {
    for (const f of files) {
      const cache = app.metadataCache.getFileCache(f);
      const links = cache?.links ?? [];
      const fm = cache?.frontmatter ?? {};
      const srcId = chooseNodeId(f, fm);
      for (const link of links) {
        // link.link can be like "Note Name" or "Note Name#Heading" or "Note Name|alias"
        const target = link.link.split("#")[0].split("|")[0].trim();
        if (!target) continue;
        const dstId = resolveLinkpath(app, target, f.path);
        if (!dstId) {
          store.upsertEdge(srcId, target, { source: "wikilink", weight: 1 });
          continue;
        }
        store.upsertEdge(srcId, dstId, { source: "wikilink", weight: 1 });
      }
    }
  }

  store.builtAt = Date.now();

  let real = 0;
  let phantom = 0;
  store.forEachNode((_id, attrs) => {
    if (attrs.isPhantom) phantom++;
    else real++;
  });

  return {
    filesScanned: files.length,
    realNodes: real,
    phantomNodes: phantom,
    edges: store.size(),
    errors,
    durationMs: Date.now() - t0,
  };
}

// ─── helpers ──────────────────────────────────────────────────────

function shouldExclude(filePath: string, exclude: Set<string>): boolean {
  for (const prefix of exclude) {
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
}

function chooseNodeId(file: TFile, fm: Record<string, unknown>): string {
  const id = fm.id;
  if (typeof id === "string" && id.trim()) return id.trim();
  if (typeof id === "number") return String(id);
  return file.basename;
}

function chooseClaim(file: TFile, fm: Record<string, unknown>): string {
  if (typeof fm.claim === "string" && fm.claim.trim()) return fm.claim.trim();
  if (typeof fm.title === "string" && fm.title.trim()) return fm.title.trim();
  return file.basename;
}

function readTags(
  fm: Record<string, unknown>,
  inlineTags?: ReadonlyArray<{ tag: string }>,
): string[] {
  const out = new Set<string>();
  const fmTags = fm.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      const s = String(t).trim();
      if (s) out.add(s.replace(/^#/, ""));
    }
  } else if (typeof fmTags === "string" && fmTags.trim()) {
    for (const t of fmTags.split(",")) {
      const s = t.trim();
      if (s) out.add(s.replace(/^#/, ""));
    }
  }
  if (inlineTags) {
    for (const t of inlineTags) out.add(t.tag.replace(/^#/, ""));
  }
  return [...out];
}

function readStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Resolve a wikilink target to a node id.
 * - Try metadataCache.getFirstLinkpathDest → real file → use frontmatter.id or basename
 * - Returns null if unresolvable (caller treats as phantom)
 */
function resolveLinkpath(
  app: App,
  target: string,
  fromPath: string,
): string | null {
  try {
    const file = app.metadataCache.getFirstLinkpathDest(target, fromPath);
    if (!file) return null;
    const cache = app.metadataCache.getFileCache(file);
    const fmId = cache?.frontmatter?.id;
    if (typeof fmId === "string" && fmId.trim()) return fmId.trim();
    return file.basename;
  } catch {
    return null;
  }
}
