import { App, TFile, normalizePath } from "obsidian";
import { SeedInfo, VaultIndex, VaultNote } from "../types";

const VAULT_INDEX_PATH = "_index/VAULT_INDEX.md";
const GRAPH_PATH = "_index/GRAPH.md";

/**
 * Parse VAULT_INDEX.md (cluster-grouped markdown tables).
 * Each cluster block looks like:
 *
 *   ## 클러스터: AI (60개)
 *   | ID | Claim | Tags | Links |
 *   |----|-------|------|-------|
 *   | 0040a1 | ... | AI, 감정, 철학 | 0040a, 0040a2 |
 *
 * Some IDs appear with leading spaces and some rows have empty Links column.
 * A single ID may appear under multiple clusters (intentional multi-cluster
 * membership); the first occurrence wins and additional clusters are
 * appended to a `secondaryClusters` list via merging in memory.
 */
export async function loadVaultIndex(app: App): Promise<VaultIndex> {
  const notes = new Map<string, VaultNote>();
  const duplicateIds = new Set<string>();

  const indexFile = app.vault.getAbstractFileByPath(
    normalizePath(VAULT_INDEX_PATH),
  );
  if (!(indexFile instanceof TFile)) {
    throw new Error(`Cannot find ${VAULT_INDEX_PATH}. Run /index first.`);
  }
  const indexRaw = await app.vault.cachedRead(indexFile);

  let currentCluster = "";
  const clusterHeader = /^##\s+클러스터:\s+(.+?)\s*\(\d+개\)/;

  for (const rawLine of indexRaw.split(/\r?\n/)) {
    const m = rawLine.match(clusterHeader);
    if (m) {
      currentCluster = m[1].trim();
      continue;
    }
    // Table rows start with `|` and contain at least 4 pipe-separated cells
    // Skip header/separator rows.
    if (!rawLine.trim().startsWith("|")) continue;
    if (rawLine.includes("---")) continue;
    if (rawLine.includes("| ID ") || rawLine.includes("|ID|")) continue;

    const cells = rawLine
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;

    const [idCell, claimCell, tagsCell, linksCell] = cells;
    const id = idCell.replace(/^\s+/, "");
    if (!id) continue;

    const tags = tagsCell
      ? tagsCell
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    const links = linksCell
      ? linksCell
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    if (notes.has(id)) {
      // duplicate ID — either same note in multiple clusters (harmless merge)
      // OR two distinct notes accidentally sharing an ID (data issue).
      // We merge tags/links but flag the ID so UI can warn.
      duplicateIds.add(id);
      const existing = notes.get(id)!;
      for (const t of tags) if (!existing.tags.includes(t)) existing.tags.push(t);
      for (const l of links) if (!existing.links.includes(l)) existing.links.push(l);
      continue;
    }

    notes.set(id, {
      id,
      claim: claimCell,
      cluster: currentCluster,
      tags,
      links,
    });
  }

  // GRAPH.md — each line:  "<id> → <link>, <link>, ..."
  // Some lines have leading whitespace. Use the graph as authoritative for
  // link directionality (VAULT_INDEX may be stale for cross-cluster links).
  const graphFile = app.vault.getAbstractFileByPath(normalizePath(GRAPH_PATH));
  if (graphFile instanceof TFile) {
    const graphRaw = await app.vault.cachedRead(graphFile);
    for (const rawLine of graphRaw.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) continue;
      const arrow = trimmed.split("→");
      if (arrow.length !== 2) continue;
      const id = arrow[0].trim();
      const targets = arrow[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (!notes.has(id)) continue;
      const note = notes.get(id)!;
      for (const t of targets) {
        if (!note.links.includes(t)) note.links.push(t);
      }
    }
  }

  // Build reverse link map
  const backlinks = new Map<string, Set<string>>();
  for (const [nid, n] of notes) {
    for (const target of n.links) {
      if (!backlinks.has(target)) backlinks.set(target, new Set());
      backlinks.get(target)!.add(nid);
    }
  }

  return { notes, backlinks, duplicateIds, loadedAt: Date.now() };
}

/**
 * Read the seed's cluster/tags/links authoritatively from the active file's
 * own frontmatter. This is critical when the vault has duplicate Folgezettel
 * IDs — VAULT_INDEX arbitrarily keeps one copy's cluster/tags, which may
 * belong to a DIFFERENT note from the one the user is actively viewing.
 *
 * Raw/fleeting notes (typically under "0 raw/") usually have no `id` field.
 * Those are still returned with `isRaw=true` and a synthetic id derived from
 * the filename so the recommendation panel can still operate (via tag +
 * semantic fallback). The "영구노트 생성" action then promotes via /fleeting
 * scan instead of /permanent --from-candidates.
 */
export function seedFromActiveFile(
  app: App,
  file: TFile | null,
): SeedInfo | null {
  if (!file) return null;
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter ?? {};

  const rawTags = fm.tags;
  const tags: string[] = Array.isArray(rawTags)
    ? rawTags.map((x) => String(x).trim()).filter(Boolean)
    : typeof rawTags === "string"
      ? rawTags.split(",").map((x) => x.trim()).filter(Boolean)
      : [];

  const rawLinks = fm.links;
  const links: string[] = Array.isArray(rawLinks)
    ? rawLinks.map((x) => String(x).trim()).filter(Boolean)
    : [];

  const cluster = fm.cluster ? String(fm.cluster).trim() : "";
  const explicitClaim = fm.claim ? String(fm.claim).trim() : "";

  const hasId = !!fm.id;
  const type = fm.type ? String(fm.type).trim() : "";

  // Heuristic: a file is "raw/fleeting" when it has no id OR its frontmatter
  // type says so OR it's under a raw folder. This covers user-edited notes
  // that have custom frontmatter but no Folgezettel id yet.
  const inRawFolder = file.path.startsWith("0 raw/") || file.path.startsWith("0 Inbox/");
  const isRaw = !hasId || type === "fleeting" || inRawFolder;

  let id: string;
  if (hasId) {
    id = String(fm.id).trim();
  } else {
    // Synthetic id = filename (sanitized for logging only, we never write it)
    id = `raw:${file.basename}`;
  }

  const claim = explicitClaim || stripLeadingIdPrefix(file.basename);

  return {
    id,
    claim,
    cluster,
    tags,
    links,
    isRaw,
    sourcePath: file.path,
  };
}

/** "0040d2. 스케치로서의 코딩" → "스케치로서의 코딩". raw 파일명에서 ID 접두어가 없으면 그대로 반환. */
function stripLeadingIdPrefix(basename: string): string {
  // Matches "<id>. <title>" or "<id> <title>" where id is alphanumeric
  const m = basename.match(/^[0-9a-zA-Z]+\.?\s+(.*)$/);
  return m ? m[1] : basename;
}

/** Signals that convey no real semantic connection — skip them in matching. */
export const NOISE_VALUES = new Set<string>(["미분류", "unclassified", ""]);
