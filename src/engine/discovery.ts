import { App } from "obsidian";
import { GraphStore } from "./graph-store";
import { detectGaps, detectBridges } from "./gap-detector";
import { diagnoseVault } from "./diagnose";
import {
  ClusterInfo,
  DiscoveryResult,
  GapPair,
  ClusterLabel,
} from "../types";
import {
  nameCluster,
  generateQuestions,
  suggestLatentTopics,
  ClusterContext,
} from "../llm/tasks";
import { DiscoveryCache } from "../llm/cache";

/**
 * Discovery orchestrator.
 *
 * Flow:
 *   1. Diagnose vault (structural)
 *   2. Detect gaps + bridges (structural)
 *   3. (Optional, useLLM) Name each cluster via Codex (parallel, with caching)
 *   4. (Optional, useLLM) Generate questions per gap (sequential — keeps load low)
 *   5. (Optional, useLLM) Suggest latent topics per top cluster (parallel)
 *
 * Errors at the LLM layer are downgraded to warnings — structural results are
 * always returned. The `errors` field tells the UI which sub-tasks failed.
 *
 * Concurrency: cluster naming and latent topics run in parallel up to a small
 * cap (default 3) to keep Codex from being hammered. Questions are sequential
 * because each one is the slowest call.
 */

export interface DiscoveryOptions {
  /** Run Codex tasks. When false, only structural results are produced. */
  useLLM: boolean;
  /** Top-K clusters to name + suggest latent topics for. Default 5. */
  topClustersForLLM?: number;
  /** Top-K gaps to generate questions for. Default 3 (rate-limit friendly). */
  topGapsForLLM?: number;
  /** Concurrency for parallel Codex calls. Default 3. */
  concurrency?: number;
  /** Per-call timeout. Default 60s. */
  perCallTimeoutMs?: number;
  /** Progress callback (0..1). */
  onProgress?: (done: number, total: number, label: string) => void;
}

export async function runDiscovery(
  app: App,
  store: GraphStore,
  clusters: ClusterInfo[],
  cache: DiscoveryCache,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  const topClusters = options.topClustersForLLM ?? 5;
  const topGaps = options.topGapsForLLM ?? 3;
  const concurrency = options.concurrency ?? 3;
  const perCallTimeout = options.perCallTimeoutMs ?? 60_000;

  // ── 1. Diagnose ─────────────────────────────────────
  const diagnostic = diagnoseVault(store, clusters);

  // ── 2. Gaps + Bridges ───────────────────────────────
  const gaps = detectGaps(store, clusters, { topK: 5 });
  const bridges = detectBridges(store, { topK: 5 });

  // Default placeholder labels (used when LLM is off or fails)
  const clusterLabels: Record<number, ClusterLabel> = {};
  for (const c of clusters) {
    clusterLabels[c.id] = { clusterId: c.id, label: c.label, confidence: 0 };
  }
  const questions: Record<string, string[]> = {};
  const latentTopics: Record<number, string[]> = {};

  if (!options.useLLM) {
    return {
      generatedAt: t0,
      diagnostic,
      gaps,
      bridges,
      clusterLabels,
      questions,
      latentTopics,
      llmUsed: false,
      errors,
    };
  }

  // ── 3. Cluster naming (parallel, capped, cached) ────
  const targetClusters = clusters.slice(0, topClusters);
  const totalLLM = targetClusters.length + Math.min(topGaps, gaps.length) + targetClusters.length;
  let done = 0;
  const tick = (label: string) => {
    done++;
    options.onProgress?.(done, totalLLM, label);
  };

  await runWithConcurrency(targetClusters, concurrency, async (c) => {
    const ctx = buildClusterContext(store, c);
    const cached = await cache.get<ClusterLabel>("topic-name", ctx);
    if (cached) {
      clusterLabels[c.id] = cached;
      tick(`라벨 캐시 hit: ${cached.label}`);
      return;
    }
    try {
      const label = await nameCluster(app, ctx, perCallTimeout);
      clusterLabels[c.id] = label;
      await cache.set("topic-name", ctx, label);
      tick(`라벨 생성: ${label.label}`);
    } catch (err) {
      errors.push(`label C${c.id}: ${stringifyErr(err)}`);
      tick(`라벨 실패 C${c.id}`);
    }
  });

  // Re-write gap labels now that we have cluster names
  for (const g of gaps) {
    g.labelA = clusterLabels[g.clusterA]?.label ?? g.labelA;
    g.labelB = clusterLabels[g.clusterB]?.label ?? g.labelB;
  }

  // ── 4. Question gen (sequential, top-N gaps) ────────
  const targetGaps = gaps.slice(0, topGaps);
  for (const gap of targetGaps) {
    const cached = await cache.get<string[]>("questions", gapKeyInput(gap));
    if (cached) {
      questions[gapKey(gap)] = cached;
      tick(`질문 캐시 hit: ${gap.labelA}↔${gap.labelB}`);
      continue;
    }
    try {
      const qs = await generateQuestions(app, gap, perCallTimeout);
      questions[gapKey(gap)] = qs;
      await cache.set("questions", gapKeyInput(gap), qs);
      tick(`질문 생성: ${gap.labelA}↔${gap.labelB} (${qs.length}개)`);
    } catch (err) {
      errors.push(`questions ${gapKey(gap)}: ${stringifyErr(err)}`);
      tick(`질문 실패 ${gap.labelA}↔${gap.labelB}`);
    }
  }

  // ── 5. Latent topics (parallel, capped, cached) ─────
  await runWithConcurrency(targetClusters, concurrency, async (c) => {
    const ctx: ClusterContext & { label: string } = {
      ...buildClusterContext(store, c),
      label: clusterLabels[c.id]?.label ?? c.label,
    };
    const cached = await cache.get<string[]>("latent-topic", ctx);
    if (cached) {
      latentTopics[c.id] = cached;
      tick(`잠재 캐시 hit: ${ctx.label}`);
      return;
    }
    try {
      const topics = await suggestLatentTopics(app, ctx, perCallTimeout);
      latentTopics[c.id] = topics;
      await cache.set("latent-topic", ctx, topics);
      tick(`잠재 생성: ${ctx.label} (${topics.length}개)`);
    } catch (err) {
      errors.push(`latent C${c.id}: ${stringifyErr(err)}`);
      tick(`잠재 실패 C${c.id}`);
    }
  });

  await cache.flush();

  return {
    generatedAt: t0,
    diagnostic,
    gaps,
    bridges,
    clusterLabels,
    questions,
    latentTopics,
    llmUsed: true,
    errors,
  };
}

// ─── helpers ──────────────────────────────────────────

function buildClusterContext(store: GraphStore, c: ClusterInfo): ClusterContext {
  const members = c.members
    .slice(0, 12)
    .map((id) => {
      const n = store.getNode(id);
      return n
        ? { id, claim: n.claim, tags: n.tags }
        : { id, claim: id, tags: [] };
    });
  return {
    clusterId: c.id,
    members,
    topTags: c.topTags,
  };
}

export function gapKey(gap: GapPair): string {
  const a = Math.min(gap.clusterA, gap.clusterB);
  const b = Math.max(gap.clusterA, gap.clusterB);
  return `${a}-${b}`;
}

function gapKeyInput(gap: GapPair): unknown {
  const a = Math.min(gap.clusterA, gap.clusterB);
  const b = Math.max(gap.clusterA, gap.clusterB);
  return {
    a,
    b,
    sharedTags: gap.sharedTags,
    sampleA: gap.sampleA.map((m) => m.id).sort(),
    sampleB: gap.sampleB.map((m) => m.id).sort(),
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (idx < items.length) {
        const my = idx++;
        await worker(items[my]);
      }
    },
  );
  await Promise.all(runners);
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
