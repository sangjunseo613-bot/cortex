import { GraphStore } from "./graph-store";
import {
  ExtendedLintReport,
  LintViolation,
} from "../types";

/**
 * Extended lint — graph-aware rules.
 *
 * Phase 1 lint runs on per-file frontmatter and folder rules. Phase 5 adds
 * structural checks that need a built graph:
 *
 *   1. orphan-permanent-graph  — permanent note with neither out-edges nor
 *                                in-edges in the real-only subgraph
 *                                (true orphan, not just empty frontmatter `links`)
 *
 *   2. broken-wikilink         — a wikilink in some note points to a phantom
 *                                node — i.e. the target file does not exist
 *                                (vault clutter; Codex notes them as "ambiguous")
 *
 *   3. weak-connection         — real node with degree (in+out) ≤ 1; a sign the
 *                                note hasn't been integrated into the wider graph
 *
 *   4. isolated-component      — connected component of size ≥ 2 that has no
 *                                edges to the largest component (silo)
 *
 * Severity policy (intentionally gentle):
 *   orphan / isolated  → warn
 *   broken-wikilink    → info  (intentional in second-brain — phantoms become real later)
 *   weak-connection    → info
 */

export interface ExtendedLintOptions {
  /** Minimum component size to flag as "isolated". Default 2 (singletons handled by orphan rule). */
  minComponentSize?: number;
}

export function runExtendedLint(
  store: GraphStore,
  options: ExtendedLintOptions = {},
): ExtendedLintReport {
  const minCompSize = options.minComponentSize ?? 2;
  const violations: LintViolation[] = [];
  const g = store.inner();

  // Build real-node subgraph view (we don't mutate original)
  const realIds = new Set<string>();
  store.forEachNode((id, attrs) => {
    if (!attrs.isPhantom) realIds.add(id);
  });

  // Out/in degree on the real-only subgraph
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const id of realIds) {
    outDeg.set(id, 0);
    inDeg.set(id, 0);
  }
  g.forEachEdge((_e, _attrs, src, dst) => {
    if (realIds.has(src) && realIds.has(dst)) {
      outDeg.set(src, (outDeg.get(src) ?? 0) + 1);
      inDeg.set(dst, (inDeg.get(dst) ?? 0) + 1);
    }
  });

  // ── Rule 1 + 3: orphan and weak-connection ──────────
  for (const id of realIds) {
    const node = store.getNode(id);
    if (!node) continue;
    const total = (outDeg.get(id) ?? 0) + (inDeg.get(id) ?? 0);
    const filePath = node.filePath || id;

    if (total === 0) {
      violations.push({
        severity: "warn",
        rule: "orphan-permanent-graph",
        file: filePath,
        message: `노드 \`${id}\`가 그래프에서 완전히 고립됨 (real 인/아웃 엣지 0).`,
        fix: "다른 노트에 wikilink로 연결하거나 frontmatter `links`에 추가",
      });
    } else if (total === 1) {
      violations.push({
        severity: "info",
        rule: "weak-connection",
        file: filePath,
        message: `노드 \`${id}\`의 연결이 1개 뿐입니다 (degree=1).`,
      });
    }
  }

  // ── Rule 2: broken wikilinks (phantom edges) ──────────
  // For each edge whose dst is phantom AND source is wikilink, emit one info violation.
  const phantomTargetCount = new Map<string, number>();
  g.forEachEdge((_e, attrs, src, dst) => {
    if (!realIds.has(src)) return;
    const dstNode = store.getNode(dst);
    if (!dstNode || !dstNode.isPhantom) return;
    if ((attrs as { source?: string }).source !== "wikilink") return;
    phantomTargetCount.set(dst, (phantomTargetCount.get(dst) ?? 0) + 1);
  });
  // Group by phantom target rather than per-edge: cleaner report.
  for (const [target, count] of phantomTargetCount) {
    violations.push({
      severity: "info",
      rule: "broken-wikilink",
      file: target,
      message: `존재하지 않는 노트 \`${target}\`를 ${count}곳에서 참조 중 (phantom).`,
      fix: "노트를 만들거나, 잘못된 링크라면 정리",
    });
  }

  // ── Rule 4: isolated component ────────────────────────
  // Run undirected BFS on the real-only subgraph.
  const adj = new Map<string, Set<string>>();
  for (const id of realIds) adj.set(id, new Set());
  g.forEachEdge((_e, _attrs, src, dst) => {
    if (realIds.has(src) && realIds.has(dst)) {
      adj.get(src)!.add(dst);
      adj.get(dst)!.add(src);
    }
  });

  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of realIds) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      comp.push(cur);
      for (const n of adj.get(cur) ?? []) {
        if (!seen.has(n)) stack.push(n);
      }
    }
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length);
  // The largest component is the "main" cluster; everything else of size ≥ minCompSize is a silo.
  for (let i = 1; i < components.length; i++) {
    const comp = components[i];
    if (comp.length < minCompSize) continue;
    const sample = comp.slice(0, 3).join(", ");
    violations.push({
      severity: "warn",
      rule: "isolated-component",
      file: comp[0],
      message: `${comp.length}개 노드가 main 클러스터와 분리된 silo를 형성 (예: ${sample}).`,
      fix: "main 클러스터의 노트와 wikilink로 연결",
    });
  }

  return {
    scannedAt: Date.now(),
    graphSize: realIds.size,
    violations,
  };
}
