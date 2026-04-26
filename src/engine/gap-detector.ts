import { GraphStore } from "./graph-store";
import { ClusterInfo, GapPair, BridgeNode } from "../types";

/**
 * GapDetector — find structural holes between clusters.
 *
 * Definition (InfraNodus-inspired): a structural hole between clusters A and B
 * is high topical overlap (shared tags) but very few inter-cluster edges. The
 * higher the topical-overlap-to-edge-count ratio, the bigger the gap — i.e.
 * "you keep talking about the same things but never connect these notes".
 *
 * Pure structural: no LLM. Phase 3's Codex layer turns gaps into research
 * questions in a separate step.
 */

export interface GapOptions {
  /** Number of top gaps to return. Default 5. */
  topK?: number;
  /** Minimum cluster size for both clusters to count. Default 2. */
  minClusterSize?: number;
  /** Number of sample members per side to attach (for prompt context). Default 5. */
  sampleSize?: number;
}

export function detectGaps(
  store: GraphStore,
  clusters: ClusterInfo[],
  options: GapOptions = {},
): GapPair[] {
  const topK = options.topK ?? 5;
  const minSize = options.minClusterSize ?? 2;
  const sampleSize = options.sampleSize ?? 5;

  // Filter to clusters with enough members
  const eligible = clusters.filter((c) => c.members.length >= minSize);
  if (eligible.length < 2) return [];

  // Index member id → cluster id for O(1) edge classification
  const memberCluster = new Map<string, number>();
  for (const c of eligible) {
    for (const m of c.members) memberCluster.set(m, c.id);
  }

  // Tag set per cluster
  const clusterTags = new Map<number, Set<string>>();
  for (const c of eligible) {
    const tagSet = new Set<string>();
    for (const m of c.members) {
      const node = store.getNode(m);
      if (!node) continue;
      for (const t of node.tags) tagSet.add(t);
    }
    clusterTags.set(c.id, tagSet);
  }

  // Inter-cluster edge count
  // We need edges(A→B) + edges(B→A) for every pair in eligible
  const pairKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const interCount = new Map<string, number>();

  const g = store.inner();
  g.forEachEdge((_e, _attrs, src, dst) => {
    const ca = memberCluster.get(src);
    const cb = memberCluster.get(dst);
    if (ca === undefined || cb === undefined || ca === cb) return;
    const key = pairKey(ca, cb);
    interCount.set(key, (interCount.get(key) ?? 0) + 1);
  });

  // Score every (A, B) pair
  const candidates: GapPair[] = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      const tagsA = clusterTags.get(a.id) ?? new Set<string>();
      const tagsB = clusterTags.get(b.id) ?? new Set<string>();
      const shared: string[] = [];
      for (const t of tagsA) if (tagsB.has(t)) shared.push(t);
      if (shared.length === 0) continue; // no topical overlap = no gap (just unrelated)

      const edges = interCount.get(pairKey(a.id, b.id)) ?? 0;
      // gap_score = sharedTags / (edges + 1).
      // High shared topics + 0 edges → highest score.
      const score = shared.length / (edges + 1);

      candidates.push({
        clusterA: a.id,
        clusterB: b.id,
        labelA: a.label,
        labelB: b.label,
        sharedTags: shared.slice(0, 8),
        interEdges: edges,
        score,
        sampleA: pickTopByPagerank(store, a.members, sampleSize),
        sampleB: pickTopByPagerank(store, b.members, sampleSize),
      });
    }
  }

  candidates.sort((x, y) => y.score - x.score);
  return candidates.slice(0, topK);
}

/**
 * BridgeNodes — nodes whose betweenness is high relative to their pagerank.
 * They sit on shortest paths between clusters but aren't themselves popular
 * hubs. Useful as "starting points to write a connecting note from".
 */
export function detectBridges(
  store: GraphStore,
  options: { topK?: number } = {},
): BridgeNode[] {
  const topK = options.topK ?? 5;

  const all: Array<{
    id: string;
    claim: string;
    bw: number;
    pr: number;
    cluster: number;
  }> = [];
  store.forEachNode((id, attrs) => {
    if (attrs.isPhantom) return;
    all.push({
      id,
      claim: attrs.claim,
      bw: attrs.betweenness ?? 0,
      pr: attrs.pagerank ?? 0,
      cluster: attrs.communityId ?? 0,
    });
  });
  if (all.length === 0) return [];

  const bwMax = Math.max(...all.map((x) => x.bw), 0);
  const prMax = Math.max(...all.map((x) => x.pr), 0);

  const scored = all
    .map((x) => {
      const bwN = bwMax > 0 ? x.bw / bwMax : 0;
      const prN = prMax > 0 ? x.pr / prMax : 0;
      // Bridges: high betweenness, NOT necessarily high pagerank.
      return {
        id: x.id,
        claim: x.claim,
        betweenness: x.bw,
        pagerank: x.pr,
        bridgeScore: bwN - 0.5 * prN, // penalize hubs slightly
        cluster: x.cluster,
      };
    })
    .filter((x) => x.bridgeScore > 0)
    .sort((a, b) => b.bridgeScore - a.bridgeScore);

  return scored.slice(0, topK);
}

function pickTopByPagerank(
  store: GraphStore,
  ids: string[],
  k: number,
): Array<{ id: string; claim: string }> {
  const withPr = ids
    .map((id) => {
      const n = store.getNode(id);
      return n ? { id, claim: n.claim, pr: n.pagerank ?? 0 } : null;
    })
    .filter((x): x is { id: string; claim: string; pr: number } => x !== null);
  withPr.sort((a, b) => b.pr - a.pr);
  return withPr.slice(0, k).map(({ id, claim }) => ({ id, claim }));
}
