import louvain from "graphology-communities-louvain";
import { GraphStore } from "./graph-store";
import { ClusterInfo, GraphNodeAttrs } from "../types";

/**
 * Community detection — Louvain modularity.
 *
 * Louvain works on undirected graphs natively and on directed graphs via the
 * package's directed mode. We pass the directed graph and weight edges by
 * their `weight` attribute. Result: each node gets a numeric communityId.
 *
 * After detection we summarize each community (size, top nodes by PageRank,
 * top tags). Cluster labels are placeholders ("C0", "C1", ...) until Phase 3
 * Codex topic-namer assigns human-readable labels.
 */

export interface DetectOptions {
  /** Random restart count for stability. Default 5. */
  restarts?: number;
  /** Minimum cluster size to surface in summary. Smaller ones are merged
   *  into a synthetic "small" bucket. Default 1 (no merging). */
  minSize?: number;
  /** Exclude phantom nodes from the result summary. Default true. */
  excludePhantoms?: boolean;
}

/**
 * Run Louvain, write community ids + cluster labels back to node attrs,
 * and return per-cluster summaries sorted by size descending.
 */
export function detectCommunities(
  store: GraphStore,
  options: DetectOptions = {},
): ClusterInfo[] {
  const restarts = options.restarts ?? 5;
  const minSize = options.minSize ?? 1;
  const excludePhantoms = options.excludePhantoms !== false;

  const graph = store.inner();
  if (graph.order === 0) return [];

  // Run multiple restarts and pick the partition with highest modularity.
  let bestComm: Record<string, number> = {};
  let bestMod = -Infinity;
  for (let i = 0; i < restarts; i++) {
    try {
      const comm = louvain(graph, {
        getEdgeWeight: "weight",
        resolution: 1.0,
        // Louvain's randomness is internal; running multiple times still helps
        // because it shuffles node iteration order.
      });
      const mod = computeModularity(graph, comm);
      if (mod > bestMod) {
        bestMod = mod;
        bestComm = comm;
      }
    } catch (err) {
      console.warn("[cortex] louvain restart failed:", err);
    }
  }

  // Write back communityId + cluster label
  graph.forEachNode((id) => {
    const cid = bestComm[id] ?? 0;
    store.setNodeAttribute(id, "communityId", cid);
    // Placeholder label — Phase 3 will rename via Codex.
    const existing = store.getNode(id);
    // Only overwrite cluster if it was empty (preserve manual cluster assignments).
    if (!existing?.cluster) {
      store.setNodeAttribute(id, "cluster", `C${cid}`);
    }
  });

  // Summarize
  const buckets = new Map<number, GraphNodeAttrs[]>();
  const memberIds = new Map<number, string[]>();
  graph.forEachNode((id, attrs) => {
    if (excludePhantoms && attrs.isPhantom) return;
    const cid = attrs.communityId ?? 0;
    if (!buckets.has(cid)) {
      buckets.set(cid, []);
      memberIds.set(cid, []);
    }
    buckets.get(cid)!.push(attrs);
    memberIds.get(cid)!.push(id);
  });

  const out: ClusterInfo[] = [];
  for (const [cid, members] of buckets) {
    if (members.length < minSize) continue;
    const ids = memberIds.get(cid) ?? [];
    // Top 3 members by PageRank
    const ranked = [...ids].sort((a, b) => {
      const pa = store.getNode(a)?.pagerank ?? 0;
      const pb = store.getNode(b)?.pagerank ?? 0;
      return pb - pa;
    });
    // Tag frequency
    const tagFreq = new Map<string, number>();
    for (const m of members) {
      for (const t of m.tags) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    }
    const topTags = [...tagFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t]) => t);

    out.push({
      id: cid,
      label: `C${cid}`,
      members: ids,
      topNodes: ranked.slice(0, 3),
      topTags,
    });
  }
  out.sort((a, b) => b.members.length - a.members.length);
  return out;
}

// ─── Modularity (Newman's Q) for a directed graph with edge weights ──

function computeModularity(
  graph: ReturnType<GraphStore["inner"]>,
  community: Record<string, number>,
): number {
  let totalWeight = 0;
  graph.forEachEdge((_e, attrs) => {
    const w = (attrs as { weight?: number }).weight ?? 1;
    totalWeight += w;
  });
  if (totalWeight === 0) return 0;

  // out-strength and in-strength per node
  const outStrength = new Map<string, number>();
  const inStrength = new Map<string, number>();
  graph.forEachEdge((_e, attrs, src, dst) => {
    const w = (attrs as { weight?: number }).weight ?? 1;
    outStrength.set(src, (outStrength.get(src) ?? 0) + w);
    inStrength.set(dst, (inStrength.get(dst) ?? 0) + w);
  });

  let q = 0;
  graph.forEachEdge((_e, attrs, src, dst) => {
    if (community[src] !== community[dst]) return;
    const w = (attrs as { weight?: number }).weight ?? 1;
    const expected =
      ((outStrength.get(src) ?? 0) * (inStrength.get(dst) ?? 0)) / totalWeight;
    q += w - expected;
  });
  return q / totalWeight;
}
