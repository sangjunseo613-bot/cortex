import pagerank from "graphology-metrics/centrality/pagerank";
import betweenness from "graphology-metrics/centrality/betweenness";
import { GraphStore } from "./graph-store";
import { GodNodeCandidate } from "../types";

/**
 * Centrality + god-node extraction.
 *
 * PageRank measures "how much vault traffic flows through this node" —
 * captures hubs (nodes everyone points at).
 *
 * Betweenness measures "how often this node sits on shortest paths" —
 * captures bridges (nodes connecting otherwise separate clusters).
 *
 * God nodes = combined score blending both. Default weights tuned to favor
 * PageRank slightly because for a Zettelkasten-style vault hubs matter more
 * than bridges; bridges are surfaced separately by Phase 3 discovery engine.
 */

export interface ExtractOptions {
  /** Number of god nodes to return. Default 10. */
  topK?: number;
  /** PageRank weight (0..1). 1-w goes to betweenness. Default 0.7. */
  pagerankWeight?: number;
  /** Exclude phantom nodes. Default true. */
  excludePhantoms?: boolean;
}

/**
 * Compute PageRank + Betweenness, write results back to node attrs, and
 * return the top-K god node candidates.
 *
 * Mutates node attributes in-place: `pagerank` and `betweenness`.
 */
export function extractGodNodes(
  store: GraphStore,
  options: ExtractOptions = {},
): GodNodeCandidate[] {
  const topK = options.topK ?? 10;
  const w = options.pagerankWeight ?? 0.7;
  const excludePhantoms = options.excludePhantoms !== false;

  const graph = store.inner();
  if (graph.order === 0) return [];

  // PageRank: pass null to weight by uniform 1.0 (still correctly counts edge mult.)
  const pr: Record<string, number> = pagerank(graph, {
    getEdgeWeight: "weight",
    alpha: 0.85,
    maxIterations: 100,
    tolerance: 1e-6,
  });

  // Betweenness: only meaningful when n >= 3. For tiny graphs we substitute zeros.
  let bw: Record<string, number> = {};
  if (graph.order >= 3) {
    try {
      bw = betweenness(graph, { getEdgeWeight: null });
    } catch (err) {
      // betweenness can occasionally throw on degenerate graphs; degrade gracefully.
      console.warn("[cortex] betweenness failed, defaulting to zeros:", err);
      bw = {};
    }
  }

  // Write back to node attrs
  graph.forEachNode((id) => {
    store.setNodeAttribute(id, "pagerank", pr[id] ?? 0);
    store.setNodeAttribute(id, "betweenness", bw[id] ?? 0);
  });

  // Build candidate list
  const candidates: GodNodeCandidate[] = [];
  graph.forEachNode((id, attrs) => {
    if (excludePhantoms && attrs.isPhantom) return;
    candidates.push({
      id,
      claim: attrs.claim,
      pagerank: pr[id] ?? 0,
      betweenness: bw[id] ?? 0,
      combined: 0, // computed after normalization below
    });
  });

  // Normalize each axis to [0, 1] then blend
  const prMax = Math.max(...candidates.map((c) => c.pagerank), 0);
  const bwMax = Math.max(...candidates.map((c) => c.betweenness), 0);
  for (const c of candidates) {
    const prN = prMax > 0 ? c.pagerank / prMax : 0;
    const bwN = bwMax > 0 ? c.betweenness / bwMax : 0;
    c.combined = w * prN + (1 - w) * bwN;
  }

  candidates.sort((a, b) => b.combined - a.combined);
  return candidates.slice(0, topK);
}
