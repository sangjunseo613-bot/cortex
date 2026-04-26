import { Candidate, SeedInfo, VaultIndex, VaultNote } from "../types";
import { NOISE_VALUES } from "./index-reader";

/**
 * Structural ranking — TypeScript port of search.py's 4-Way logic,
 * unified into a single scoring function usable with a single seed note.
 *
 * Score composition:
 *   +5  1-hop link (forward or backward) from seed
 *   +2  2-hop link neighbor
 *   +3  same cluster  (skipped if cluster is '미분류' or empty)
 *   +2  × (# shared tags)  (noise tags filtered out)
 *   +1  × cousin-count (friends-of-friends signal) capped at +3
 *
 * Excludes: self, already-linked notes (seed.links[]).
 *
 * IMPORTANT: cluster/tags come from `seed` (active file's frontmatter),
 * NOT from the index — the vault can have duplicate Folgezettel IDs.
 */
export function scoreStructural(
  seed: SeedInfo,
  index: VaultIndex,
  topK = 50,
): Candidate[] {
  // Raw/fleeting notes don't live in VAULT_INDEX and have no links. Use a
  // keyword + tag overlap fallback so they still produce candidates — the
  // semantic reranker then provides the creative jumps.
  if (seed.isRaw || !index.notes.has(seed.id)) {
    return scoreRawFallback(seed, index, topK);
  }

  const excluded = new Set<string>([seed.id, ...seed.links]);

  // Pivot set for traversal: seed's full neighborhood (forward + backward),
  // NOT filtered by `excluded`. We need to traverse THROUGH already-linked
  // nodes to reach their neighbors for 2-hop discovery — otherwise when
  // every direct neighbor is already linked (common for well-connected
  // notes), hop2 collapses to empty and we lose legitimate candidates.
  const back = index.backlinks;
  const seedNeighbors = new Set<string>(seed.links);
  for (const b of back.get(seed.id) ?? []) seedNeighbors.add(b);

  // 1-hop candidates: direct neighbors that are NOT already linked.
  const hop1 = new Set<string>();
  for (const n of seedNeighbors) if (!excluded.has(n)) hop1.add(n);

  // 2-hop candidates: neighbors of pivots, excluding seed itself, already-
  // linked notes, and anything already in hop1.
  const hop2 = new Set<string>();
  for (const pivot of seedNeighbors) {
    const node = index.notes.get(pivot);
    if (!node) continue;
    for (const l of node.links) {
      if (!excluded.has(l) && !hop1.has(l) && l !== seed.id) hop2.add(l);
    }
    for (const b of back.get(pivot) ?? []) {
      if (!excluded.has(b) && !hop1.has(b) && b !== seed.id) hop2.add(b);
    }
  }

  // Noise-filtered seed signals
  const clusterMeaningful =
    seed.cluster && !NOISE_VALUES.has(seed.cluster);
  const meaningfulTags = seed.tags.filter((t) => !NOISE_VALUES.has(t));
  const seedTags = new Set(meaningfulTags);

  const scores = new Map<string, { score: number; reasons: string[] }>();
  const bump = (id: string, s: number, reason: string) => {
    if (excluded.has(id) || id === seed.id) return;
    if (!index.notes.has(id)) return;
    const cur = scores.get(id) ?? { score: 0, reasons: [] };
    cur.score += s;
    cur.reasons.push(reason);
    scores.set(id, cur);
  };

  for (const id of hop1) bump(id, 5, "1-hop 이웃");
  for (const id of hop2) bump(id, 2, "2-hop 이웃");

  for (const [id, note] of index.notes) {
    if (excluded.has(id) || id === seed.id) continue;

    if (
      clusterMeaningful &&
      note.cluster &&
      note.cluster === seed.cluster &&
      !NOISE_VALUES.has(note.cluster)
    ) {
      bump(id, 3, `같은 클러스터 (${note.cluster})`);
    }

    const shared = note.tags.filter(
      (t) => seedTags.has(t) && !NOISE_VALUES.has(t),
    );
    if (shared.length > 0) {
      bump(
        id,
        2 * shared.length,
        `태그 ${shared.length}개 공유 (${shared.slice(0, 3).join(", ")})`,
      );
    }

    const cousinShared = note.links.filter((l) => seedNeighbors.has(l)).length;
    if (cousinShared > 0) {
      bump(id, Math.min(cousinShared, 3), `공통 이웃 ${cousinShared}개`);
    }
  }

  const candidates: Candidate[] = [];
  for (const [id, { score, reasons }] of scores) {
    const note = index.notes.get(id) as VaultNote;
    candidates.push({
      id,
      claim: note.claim,
      cluster: note.cluster,
      tags: note.tags.slice(0, 3),
      score: { structural: score, combined: score },
      reasons,
    });
  }

  candidates.sort((a, b) => b.score.structural - a.score.structural);
  return candidates.slice(0, topK);
}

/**
 * Fallback scoring for seeds that aren't in VAULT_INDEX — typically raw /
 * fleeting notes under "0 raw/". We can't use link hops or cluster/cousin
 * signals, so we lean on:
 *   +1 × shared tag (meaningful, noise-filtered)
 *   +1 × shared significant word in claim title
 * Then the semantic reranker does the heavy lifting. If both signals yield
 * nothing the whole permanent set is returned (capped to topK) so embeddings
 * can still rank everything.
 */
function scoreRawFallback(
  seed: SeedInfo,
  index: VaultIndex,
  topK: number,
): Candidate[] {
  const seedTags = new Set(
    seed.tags.filter((t) => !NOISE_VALUES.has(t)),
  );
  const seedWords = extractSignificantWords(seed.claim);

  const scored: Array<{
    note: VaultNote;
    score: number;
    reasons: string[];
  }> = [];

  for (const [, note] of index.notes) {
    const reasons: string[] = [];
    let score = 0;

    // Tag overlap
    if (seedTags.size > 0) {
      const shared = note.tags.filter(
        (t) => seedTags.has(t) && !NOISE_VALUES.has(t),
      );
      if (shared.length > 0) {
        score += shared.length;
        reasons.push(`태그 ${shared.length}개 공유 (${shared.slice(0, 3).join(", ")})`);
      }
    }

    // Claim word overlap
    if (seedWords.size > 0 && note.claim) {
      const noteWords = extractSignificantWords(note.claim);
      let wordHits = 0;
      const hitList: string[] = [];
      for (const w of noteWords) {
        if (seedWords.has(w)) {
          wordHits++;
          if (hitList.length < 3) hitList.push(w);
        }
      }
      if (wordHits > 0) {
        score += wordHits;
        reasons.push(`제목 단어 ${wordHits}개 공유 (${hitList.join(", ")})`);
      }
    }

    if (score > 0) {
      scored.push({ note, score, reasons });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // If absolutely nothing matched via keywords, still seed the pool with
  // first topK permanent notes so embedding rerank has something to chew on.
  if (scored.length === 0) {
    let i = 0;
    for (const [, note] of index.notes) {
      if (i >= topK) break;
      scored.push({
        note,
        score: 0,
        reasons: ["(의미 임베딩으로만 선별)"],
      });
      i++;
    }
  }

  return scored.slice(0, topK).map(({ note, score, reasons }) => ({
    id: note.id,
    claim: note.claim,
    cluster: note.cluster,
    tags: note.tags.slice(0, 3),
    score: { structural: score, combined: score },
    reasons,
  }));
}

const STOPWORDS = new Set<string>([
  "의", "는", "이", "가", "을", "를", "에", "와", "과", "도", "로", "으로",
  "the", "a", "an", "of", "to", "in", "is", "and", "or", "for", "on",
]);

function extractSignificantWords(text: string): Set<string> {
  if (!text) return new Set();
  // Split on whitespace + common punctuation; keep Korean/English tokens len≥2
  const tokens = text
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}'"`—–\-·…]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}
