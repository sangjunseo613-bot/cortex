import { GraphStore } from "./graph-store";
import { ClusterInfo, DiagnosticResult } from "../types";

/**
 * Structural diagnosis (no LLM).
 *
 * Translates Louvain modularity + cluster size distribution into one of four
 * stages, mirroring InfraNodus' "biased / focused / diversified / dispersed":
 *
 *   BIASED        — one giant cluster swallows most nodes (vault is over-focused
 *                   on one topic; new ideas get absorbed into the gravity well)
 *   FOCUSED       — a few major clusters with strong modularity
 *                   (healthy concentration; clear specializations)
 *   DIVERSIFIED   — many medium-sized clusters with strong modularity
 *                   (broad coverage with internal coherence)
 *   DISPERSED     — weak modularity; cluster boundaries are fuzzy
 *                   (vault lacks structure; consider consolidating tags)
 *
 * Thresholds are conservative for v0.1 and can be tuned per-vault later.
 */

export interface DiagnoseOptions {
  /** Compute against real nodes only (exclude phantoms). Default true. */
  excludePhantoms?: boolean;
}

export function diagnoseVault(
  store: GraphStore,
  clusters: ClusterInfo[],
  options: DiagnoseOptions = {},
): DiagnosticResult {
  const excludePhantoms = options.excludePhantoms !== false;

  // Real node count
  let realCount = 0;
  store.forEachNode((_id, attrs) => {
    if (excludePhantoms && attrs.isPhantom) return;
    realCount++;
  });

  // Modularity (Newman's Q) for the directed graph
  const modularity = computeModularity(store);

  // Top cluster ratio
  const sizes = clusters
    .map((c) => c.members.length)
    .sort((a, b) => b - a);
  const topSize = sizes[0] ?? 0;
  const topRatio = realCount > 0 ? topSize / realCount : 0;

  const meaningfulClusterCount = clusters.filter((c) => c.members.length >= 2).length;

  // Decision tree (order matters)
  let stage: DiagnosticResult["stage"];
  let reason: string;

  if (realCount < 5) {
    stage = "FOCUSED";
    reason = `노드 수가 ${realCount}개로 너무 적어 진단이 의미적이지 않습니다. (FOCUSED로 가정)`;
  } else if (modularity < 0.20) {
    stage = "DISPERSED";
    reason = `모듈러리티 ${modularity.toFixed(2)} 매우 낮음 — 클러스터 경계가 흐립니다. 태그/링크 정비를 권장.`;
  } else if (topRatio > 0.60) {
    stage = "BIASED";
    reason = `최대 클러스터 비율 ${(topRatio * 100).toFixed(0)}% — 한 토픽이 vault를 압도. 새 토픽이 흡수될 위험.`;
  } else if (topRatio > 0.35 && modularity >= 0.30) {
    stage = "FOCUSED";
    reason = `최대 클러스터 비율 ${(topRatio * 100).toFixed(0)}%, 모듈러리티 ${modularity.toFixed(2)} — 건강한 집중 상태.`;
  } else if (meaningfulClusterCount >= 4 && modularity >= 0.35) {
    stage = "DIVERSIFIED";
    reason = `의미있는 클러스터 ${meaningfulClusterCount}개, 모듈러리티 ${modularity.toFixed(2)} — 다양성과 내부 일관성 모두 양호.`;
  } else {
    stage = "FOCUSED";
    reason = `최대 비율 ${(topRatio * 100).toFixed(0)}%, 모듈러리티 ${modularity.toFixed(2)} — 일반적 집중 패턴.`;
  }

  return {
    stage,
    topClusterRatio: topRatio,
    modularity,
    meaningfulClusterCount,
    reason,
  };
}

/**
 * Newman's modularity Q for a directed graph with edge weights.
 * Q = (1/m) Σ_e (w_e − k_out(src)·k_in(dst)/m) · δ(community(src), community(dst))
 */
function computeModularity(store: GraphStore): number {
  const g = store.inner();
  let totalWeight = 0;
  g.forEachEdge((_e, attrs) => {
    totalWeight += (attrs as { weight?: number }).weight ?? 1;
  });
  if (totalWeight === 0) return 0;

  const outStrength = new Map<string, number>();
  const inStrength = new Map<string, number>();
  g.forEachEdge((_e, attrs, src, dst) => {
    const w = (attrs as { weight?: number }).weight ?? 1;
    outStrength.set(src, (outStrength.get(src) ?? 0) + w);
    inStrength.set(dst, (inStrength.get(dst) ?? 0) + w);
  });

  let q = 0;
  g.forEachEdge((_e, attrs, src, dst) => {
    const ca = (g.getNodeAttribute(src, "communityId") ?? -1) as number;
    const cb = (g.getNodeAttribute(dst, "communityId") ?? -2) as number;
    if (ca !== cb) return;
    const w = (attrs as { weight?: number }).weight ?? 1;
    const expected = ((outStrength.get(src) ?? 0) * (inStrength.get(dst) ?? 0)) / totalWeight;
    q += w - expected;
  });
  return q / totalWeight;
}
