import { App, normalizePath } from "obsidian";
import Graph from "graphology";
import {
  GraphNodeAttrs,
  GraphEdgeAttrs,
  SerializedGraph,
} from "../types";

/**
 * GraphStore — thin wrapper around graphology with vault-aware persistence.
 *
 * We use a directed multigraph so wikilink and frontmatter edges between the
 * same pair of nodes can co-exist (different `source` attribute). PageRank
 * and Louvain treat parallel edges via summed weights.
 *
 * Persistence: `state/graph.json` under the plugin folder. The file is
 * regenerated on every `build` and is safe to delete (rebuild from vault).
 */

const GRAPH_PATH = ".obsidian/plugins/cortex/state/graph.json";

export class GraphStore {
  private graph: Graph<GraphNodeAttrs, GraphEdgeAttrs>;
  /** Last build timestamp (epoch ms). 0 if never built. */
  builtAt = 0;

  constructor(private app: App) {
    this.graph = new Graph<GraphNodeAttrs, GraphEdgeAttrs>({
      type: "directed",
      multi: true,
      allowSelfLoops: false,
    });
  }

  // ─── Read accessors ───────────────────────────────────

  /** Direct read-only handle for centrality/community functions. */
  inner(): Graph<GraphNodeAttrs, GraphEdgeAttrs> {
    return this.graph;
  }

  order(): number {
    return this.graph.order;
  }

  size(): number {
    return this.graph.size;
  }

  hasNode(id: string): boolean {
    return this.graph.hasNode(id);
  }

  getNode(id: string): GraphNodeAttrs | null {
    if (!this.graph.hasNode(id)) return null;
    return this.graph.getNodeAttributes(id);
  }

  setNodeAttribute<K extends keyof GraphNodeAttrs>(
    id: string,
    key: K,
    value: GraphNodeAttrs[K],
  ): void {
    if (!this.graph.hasNode(id)) return;
    this.graph.setNodeAttribute(id, key, value);
  }

  // ─── Write accessors ──────────────────────────────────

  /** Add or update a node. Existing attrs are merged shallow. */
  upsertNode(id: string, attrs: Partial<GraphNodeAttrs>): void {
    if (this.graph.hasNode(id)) {
      const existing = this.graph.getNodeAttributes(id);
      // Phantom flag clears once we discover the real file.
      const merged: GraphNodeAttrs = {
        ...existing,
        ...attrs,
        // If either says "real", treat as real.
        isPhantom: existing.isPhantom && (attrs.isPhantom ?? true),
      };
      this.graph.replaceNodeAttributes(id, merged);
      return;
    }
    const filled: GraphNodeAttrs = {
      claim: attrs.claim ?? id,
      cluster: attrs.cluster ?? "",
      tags: attrs.tags ?? [],
      filePath: attrs.filePath ?? "",
      isPhantom: attrs.isPhantom ?? false,
      isRaw: attrs.isRaw ?? false,
      pagerank: attrs.pagerank,
      betweenness: attrs.betweenness,
      communityId: attrs.communityId,
    };
    this.graph.addNode(id, filled);
  }

  /** Add a directed edge. Same (src,dst,source) pair is deduped. */
  upsertEdge(src: string, dst: string, attrs: GraphEdgeAttrs): void {
    if (src === dst) return; // selfloops disabled
    if (!this.graph.hasNode(src)) this.upsertNode(src, { isPhantom: true });
    if (!this.graph.hasNode(dst)) this.upsertNode(dst, { isPhantom: true });
    // Dedup: if an edge with the same source attribute already exists, skip.
    const existing = this.graph.edges(src, dst);
    for (const e of existing) {
      if (this.graph.getEdgeAttribute(e, "source") === attrs.source) return;
    }
    this.graph.addEdge(src, dst, attrs);
  }

  clear(): void {
    this.graph.clear();
    this.builtAt = 0;
  }

  // ─── Iteration helpers ────────────────────────────────

  forEachNode(cb: (id: string, attrs: GraphNodeAttrs) => void): void {
    this.graph.forEachNode(cb);
  }

  /** All nodes whose isPhantom is false. */
  realNodes(): Array<{ id: string; attrs: GraphNodeAttrs }> {
    const out: Array<{ id: string; attrs: GraphNodeAttrs }> = [];
    this.graph.forEachNode((id, attrs) => {
      if (!attrs.isPhantom) out.push({ id, attrs });
    });
    return out;
  }

  // ─── Persistence ──────────────────────────────────────

  static path(): string {
    return normalizePath(GRAPH_PATH);
  }

  async save(): Promise<void> {
    const nodes: SerializedGraph["nodes"] = [];
    const edges: SerializedGraph["edges"] = [];
    this.graph.forEachNode((id, attrs) => {
      nodes.push({ id, attrs });
    });
    this.graph.forEachEdge((_e, attrs, src, dst) => {
      edges.push({ src, dst, attrs });
    });
    const payload: SerializedGraph = {
      version: 1,
      builtAt: this.builtAt,
      nodes,
      edges,
    };
    const path = GraphStore.path();
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir && !(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(path, JSON.stringify(payload));
  }

  /** Returns true if a graph was loaded from disk. */
  async load(): Promise<boolean> {
    const path = GraphStore.path();
    if (!(await this.app.vault.adapter.exists(path))) return false;
    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as SerializedGraph;
      if (parsed.version !== 1) return false;
      this.graph.clear();
      for (const { id, attrs } of parsed.nodes) {
        this.graph.addNode(id, attrs);
      }
      for (const { src, dst, attrs } of parsed.edges) {
        if (this.graph.hasNode(src) && this.graph.hasNode(dst)) {
          this.graph.addEdge(src, dst, attrs);
        }
      }
      this.builtAt = parsed.builtAt ?? 0;
      return true;
    } catch (err) {
      console.warn("[cortex] graph load failed:", err);
      return false;
    }
  }
}
