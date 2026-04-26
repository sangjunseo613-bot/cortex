// ─── Vault index (Zettel Connect 계승) ───────────────────────────

export interface VaultNote {
  id: string;
  claim: string;
  cluster: string;
  tags: string[];
  links: string[];
}

export interface CandidateScore {
  structural: number;
  semantic?: number;
  combined: number;
}

export interface Candidate {
  id: string;
  claim: string;
  cluster: string;
  tags: string[];
  score: CandidateScore;
  reasons: string[];
}

export interface VaultIndex {
  notes: Map<string, VaultNote>;
  /** backlinks[id] = set of ids that link TO id */
  backlinks: Map<string, Set<string>>;
  /** ids that appeared more than once in VAULT_INDEX — collisions */
  duplicateIds: Set<string>;
  /** lastParsedAt epoch ms */
  loadedAt: number;
}

export interface SeedInfo {
  id: string;
  claim: string;
  cluster: string;
  tags: string[];
  links: string[];
  /** true if the seed is a raw/fleeting note (no Folgezettel id).
   *  For raw notes `id` is a synthetic value derived from the filename. */
  isRaw: boolean;
  /** Vault-relative path of the seed file (used when promoting raw → permanent). */
  sourcePath: string;
}

// ─── Phase 1 — Schema + Identity ────────────────────────────────

export type FolderType = "raw" | "compiled" | "permanent" | "archive" | "candidates" | "outputs";

export interface FolderRule {
  /** Folder path with trailing slash, e.g. "0 raw/" */
  path: string;
  /** Semantic role of this folder */
  type: FolderType;
}

export interface RequiredFrontmatter {
  /** Fields required for notes under permanent folders */
  permanent: string[];
  /** Fields required for notes under raw folders */
  raw: string[];
}

/**
 * Parsed contents of `cortex.schema.md`.
 * The file is markdown with YAML frontmatter at the top.
 */
export interface CortexSchemaFile {
  version: number;
  /** Free-form description of vault purpose (filter-funnel) */
  vaultPurpose: string;
  /** Cluster names that the vault expects to exist */
  coreClusters: string[];
  /** Optional tag whitelist. Empty = no restriction */
  allowedTags: string[];
  requiredFrontmatter: RequiredFrontmatter;
  folderRules: FolderRule[];
  /** Words that should never appear (taste guard). Empty = no restriction */
  forbiddenWords: string[];
  /** Markdown body (everything after the frontmatter) */
  bodyMarkdown: string;
}

export interface IdentityFile {
  version: number;
  /** ISO date of last manual review */
  lastReviewed: string;
  /** Manually locked god nodes (vault's "voice") — never overwritten by auto-extraction */
  manualGodNodes: string[];
  /** Auto-extracted god nodes (Phase 2 fills this) */
  autoGodNodes: string[];
  /** Core cluster names (Phase 2 fills this from Louvain) */
  coreClusters: string[];
  /** Markdown body (everything after the frontmatter) */
  bodyMarkdown: string;
}

export type ViolationSeverity = "error" | "warn" | "info";

export interface LintViolation {
  severity: ViolationSeverity;
  /** Stable rule id, e.g. "missing-frontmatter-id" */
  rule: string;
  /** Vault-relative file path */
  file: string;
  /** Human-readable message (Korean) */
  message: string;
  /** Optional suggested fix */
  fix?: string;
}

export interface LintReport {
  /** Epoch ms */
  scannedAt: number;
  /** Total markdown files scanned */
  filesScanned: number;
  violations: LintViolation[];
}

// ─── Phase 2 — Graph Core ────────────────────────────────────────

export interface GraphNodeAttrs {
  /** Display claim (= title or first heading) */
  claim: string;
  /** Cluster label — set by Louvain (numeric → resolved name) or manual */
  cluster: string;
  /** Tags from frontmatter */
  tags: string[];
  /** Vault-relative path. Empty for phantom nodes. */
  filePath: string;
  /** True when there is no underlying file (referenced but not created). */
  isPhantom: boolean;
  /** True when the file lacks a Folgezettel `id` in frontmatter. */
  isRaw: boolean;
  // ── computed (filled by centrality / community detection) ────
  pagerank?: number;
  betweenness?: number;
  /** Numeric Louvain community id — translated to a label in `cluster`. */
  communityId?: number;
}

export type EdgeSource = "frontmatter" | "wikilink";

export interface GraphEdgeAttrs {
  source: EdgeSource;
  /** For weighted PageRank. Default 1.0. */
  weight: number;
}

/** What we persist to disk (`state/graph.json`). Map<-> object conversion. */
export interface SerializedGraph {
  version: 1;
  builtAt: number;
  nodes: Array<{ id: string; attrs: GraphNodeAttrs }>;
  edges: Array<{ src: string; dst: string; attrs: GraphEdgeAttrs }>;
}

export interface GodNodeCandidate {
  id: string;
  claim: string;
  pagerank: number;
  betweenness: number;
  /** 0.7·pagerank + 0.3·betweenness, normalized to [0,1] within the candidate set */
  combined: number;
}

export interface ClusterInfo {
  /** Numeric Louvain community id */
  id: number;
  /** Human-friendly label (filled by Phase 3 Codex topic-namer; placeholder until then) */
  label: string;
  /** Member node ids */
  members: string[];
  /** Top 3 nodes within the cluster ranked by PageRank (ids) */
  topNodes: string[];
  /** Most common tags within the cluster, ranked desc */
  topTags: string[];
}

export interface GraphStats {
  builtAt: number;
  nodeCount: number;
  edgeCount: number;
  realNodeCount: number;
  phantomNodeCount: number;
  clusterCount: number;
  topGodNodes: GodNodeCandidate[];
  clusters: ClusterInfo[];
  durationMs: number;
}

// ─── Phase 3 — Discovery + Codex ────────────────────────────────

/** InfraNodus-inspired structural diagnosis stages. */
export type DiagnosticStage = "BIASED" | "FOCUSED" | "DIVERSIFIED" | "DISPERSED";

export interface DiagnosticResult {
  stage: DiagnosticStage;
  /** Largest cluster's share of real nodes (0..1) */
  topClusterRatio: number;
  /** Newman modularity Q (higher = stronger community structure) */
  modularity: number;
  /** Number of clusters with size ≥ 2 */
  meaningfulClusterCount: number;
  /** Human-readable Korean explanation */
  reason: string;
}

export interface GapPair {
  /** Numeric Louvain ids of the two clusters */
  clusterA: number;
  clusterB: number;
  /** Cluster labels (auto or LLM-named) */
  labelA: string;
  labelB: string;
  /** Tags shared between members of A and B */
  sharedTags: string[];
  /** Edge count A→B + B→A (the lower this is vs sharedTags, the bigger the gap) */
  interEdges: number;
  /** Combined gap score (higher = more meaningful structural hole) */
  score: number;
  /** Sample top-PageRank members from each side, for prompt context */
  sampleA: Array<{ id: string; claim: string }>;
  sampleB: Array<{ id: string; claim: string }>;
}

export interface BridgeNode {
  id: string;
  claim: string;
  betweenness: number;
  pagerank: number;
  /** Bridges score = betweenness − pagerank (normalized) */
  bridgeScore: number;
  /** Cluster id of the node */
  cluster: number;
}

/** LLM-derived label for a cluster. confidence: 0=guess, 1=plausible, 2=clear */
export interface ClusterLabel {
  clusterId: number;
  label: string;
  confidence: 0 | 1 | 2;
}

/** Discovery result — combines structural + LLM-derived findings. */
export interface DiscoveryResult {
  generatedAt: number;
  diagnostic: DiagnosticResult;
  gaps: GapPair[];
  bridges: BridgeNode[];
  /** Map<clusterId, label> */
  clusterLabels: Record<number, ClusterLabel>;
  /** Map<gapKey, questions[]> where gapKey = "A-B" (lower id first) */
  questions: Record<string, string[]>;
  /** Map<clusterId, missingSubtopics[]> */
  latentTopics: Record<number, string[]>;
  /** Whether LLM-backed sections (labels/questions/latent) were populated */
  llmUsed: boolean;
  errors: string[];
}

// ─── Codex bridge ─────────────────────────────────────────────────

export interface CodexRunOptions {
  /** Working directory for codex (vault root). */
  cwd: string;
  prompt: string;
  /** JSON Schema describing the expected last-message shape. Optional. */
  outputSchema?: Record<string, unknown> | null;
  /** Hard timeout in milliseconds. Default 60_000 (1 min). */
  timeoutMs?: number;
  /** AbortSignal for early cancellation. */
  signal?: AbortSignal;
}

export interface CodexRunResult {
  /** Final message text (or JSON string if a schema was supplied). */
  lastMessage: string;
  /** Parsed event count for diagnostics. */
  eventCount: number;
  /** Total duration. */
  durationMs: number;
  /** stderr captured (truncated to ~2KB). */
  stderr: string;
}

// ─── Phase 4 — Compile Pipeline ─────────────────────────────────

/** Provenance — where a compiled fact came from. */
export type ProvenanceKind = "extracted" | "inferred" | "ambiguous";

export interface CompiledConcept {
  /** Slug used for filename */
  slug: string;
  /** One-sentence claim (Korean) */
  claim: string;
  /** Inherited or generated tags */
  tags: string[];
  /** Verbatim excerpt from source supporting the claim */
  excerpt: string;
  /** 0=guess, 1=plausible, 2=clear */
  confidence: 0 | 1 | 2;
  provenance: ProvenanceKind;
}

export type EntityType =
  | "person"
  | "organization"
  | "product"
  | "place"
  | "concept"
  | "other";

export interface CompiledEntity {
  slug: string;
  name: string;
  type: EntityType;
  /** Up to 3 mentions from source (verbatim) */
  mentions: string[];
  confidence: 0 | 1 | 2;
  provenance: ProvenanceKind;
}

/** Raw output of a single compile pass. Persisted so the user can re-run. */
export interface CompileResult {
  /** Vault-relative path of the source */
  source: string;
  /** SHA-256 of source content (used as cache key) */
  sourceHash: string;
  /** Epoch ms */
  generatedAt: number;
  durationMs: number;
  concepts: CompiledConcept[];
  entities: CompiledEntity[];
  /** "codex/0.124.0" or similar */
  modelTag: string;
  errors: string[];
}

/** A pending candidate awaiting human review. */
export interface ApprovalItem {
  /** Vault-relative path of the candidate file */
  path: string;
  /** Original raw source */
  source: string;
  type: "concept" | "entity";
  claim: string;
  tags: string[];
  generatedAt: number;
  confidence: 0 | 1 | 2;
  provenance: ProvenanceKind;
}

/** Append-only audit-log entry. */
export interface AuditEntry {
  ts: number;
  action: "compile" | "approve" | "reject" | "skip";
  /** Vault-relative paths involved */
  paths: string[];
  /** Free-form note (e.g. error message) */
  detail?: string;
}

// ─── Phase 5 — Lint + Drift ────────────────────────────────────

/** Snapshot of the vault's structural state at a moment in time. */
export interface DiagnosticSnapshot {
  /** Epoch ms */
  ts: number;
  /** ISO date YYYY-MM-DD */
  date: string;
  /** ISO week e.g. "2026-W17" */
  weekKey: string;
  /** Quarter key e.g. "2026-Q2" */
  quarterKey: string;
  graphStats: {
    realNodes: number;
    edges: number;
    clusters: number;
  };
  /** Top-N god node ids ordered by combined score */
  godNodes: string[];
  /** Top-N cluster labels ordered by size */
  clusterLabels: string[];
  diagnostic: DiagnosticResult;
  /** Audit deltas since previous snapshot */
  auditDelta: {
    compiles: number;
    approves: number;
    rejects: number;
  };
}

export type DriftSeverity = "none" | "low" | "medium" | "high";

export interface DriftSignal {
  /** Snapshot we are evaluating */
  ts: number;
  /** Snapshot we are comparing against */
  comparedToTs: number;
  /** Jaccard distance of god node id sets (0=identical, 1=disjoint) */
  godNodeDrift: number;
  /** Fraction of cluster labels that changed */
  clusterDrift: number;
  /** Whether the diagnostic stage changed */
  stageChanged: boolean;
  oldStage: DiagnosticStage;
  newStage: DiagnosticStage;
  severity: DriftSeverity;
  /** Human-readable Korean explanations */
  reasons: string[];
}

/** Extended lint rule ids (Phase 5 — graph-aware). Phase 1 has its own
 *  schema-only rules. */
export type ExtendedRule =
  | "orphan-permanent-graph"
  | "broken-wikilink"
  | "weak-connection"
  | "isolated-component";

export interface ExtendedLintReport {
  scannedAt: number;
  /** Sum of real nodes in the graph */
  graphSize: number;
  violations: LintViolation[];
}
