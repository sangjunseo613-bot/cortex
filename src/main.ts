import { Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import {
  CONNECTION_VIEW_TYPE,
  ConnectionPanel,
} from "./view/ConnectionPanel";
import { EmbeddingEngine } from "./engine/embeddings";
import {
  DEFAULT_SETTINGS,
  CortexSettings,
  CortexSettingTab,
} from "./settings";
import { SchemaManager } from "./schema/manager";
import { runLint, writeLintReport } from "./schema/lint";
import { LINT_REPORT_PATH } from "./schema/templates";
import { GraphStore } from "./engine/graph-store";
import { buildGraphFromVault } from "./engine/graph-builder";
import { extractGodNodes } from "./engine/centrality";
import { detectCommunities } from "./engine/community";
import { writeIndexFiles } from "./engine/index-writer";
import { runDiscovery } from "./engine/discovery";
import { GraphStats, DiscoveryResult } from "./types";
import { DiscoveryCache } from "./llm/cache";
import { verifyCodex, resetCodexDetection } from "./llm/codex-bridge";
import {
  DISCOVERY_VIEW_TYPE,
  DiscoveryPanel,
} from "./view/DiscoveryPanel";
import { REVIEW_VIEW_TYPE, ReviewPanel } from "./view/ReviewPanel";
import { IDENTITY_VIEW_TYPE, IdentityPanel } from "./view/IdentityPanel";
import { compileFile, compileFolder } from "./pipeline/compile";
import { runExtendedLint } from "./engine/extended-lint";
import {
  buildSnapshot,
  saveSnapshot,
  latestSnapshot,
  listSnapshots,
  compareSnapshots,
  renderDriftReport,
} from "./pipeline/diagnostics";
import { WeeklyScheduler } from "./pipeline/scheduler";

export default class CortexPlugin extends Plugin {
  settings!: CortexSettings;
  embedder!: EmbeddingEngine;
  schemaManager!: SchemaManager;
  graphStore!: GraphStore;
  discoveryCache!: DiscoveryCache;
  scheduler!: WeeklyScheduler;
  /** Last build's stats, surfaced in Settings UI. Null until first build. */
  lastGraphStats: GraphStats | null = null;
  /** Last discovery run result. Null until first run. */
  lastDiscoveryResult: DiscoveryResult | null = null;
  /** Status bar handle — set in onload, refreshed after build/diagnostic. */
  private statusBarEl: HTMLElement | null = null;
  private debounceTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.embedder = new EmbeddingEngine(this.app, {
      provider: this.settings.embeddingProvider,
      ollamaEndpoint: this.settings.ollamaEndpoint,
      ollamaModel: this.settings.ollamaModel,
    });

    this.schemaManager = new SchemaManager(this.app);
    this.graphStore = new GraphStore(this.app);
    // Lazy load of last persisted graph + derive stats so the UI/status bar
    // shows real numbers immediately instead of "그래프 미빌드".
    // No vault re-scan: PageRank/Louvain run only on the in-memory graph.
    void this.graphStore.load().then((ok) => {
      if (ok) void this.hydrateStatsFromGraph();
    });

    this.discoveryCache = new DiscoveryCache(this.app);

    this.scheduler = new WeeklyScheduler(this.app, {
      runWeeklyDiagnostic: () => this.runWeeklyDiagnostic(),
    });
    if (this.settings.weeklyDiagnosticEnabled) {
      void this.scheduler.start();
    }

    this.registerView(
      DISCOVERY_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new DiscoveryPanel(leaf, this),
    );

    this.registerView(
      REVIEW_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new ReviewPanel(leaf, this),
    );

    this.registerView(
      IDENTITY_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new IdentityPanel(leaf, this),
    );

    this.registerView(
      CONNECTION_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new ConnectionPanel(leaf, this),
    );

    this.addRibbonIcon("brain-circuit", "Cortex: 추천 패널 열기", () =>
      void this.activateView(),
    );

    this.addRibbonIcon("compass", "Cortex: 발견 패널 열기", () =>
      void this.activateDiscoveryView(),
    );

    this.addRibbonIcon("check-square", "Cortex: 리뷰 패널 열기", () =>
      void this.activateReviewView(),
    );

    this.addRibbonIcon("shield", "Cortex: 정체성 패널 열기", () =>
      void this.activateIdentityView(),
    );

    // ─── Status bar — passive at-a-glance info ─────────
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("cortex-status");
    this.statusBarEl.setAttr(
      "style",
      "cursor: pointer; padding: 0 6px; font-size: 0.85em;",
    );
    this.statusBarEl.addEventListener("click", () => void this.activateIdentityView());
    void this.refreshStatusBar();

    this.addCommand({
      id: "open-connection-panel",
      name: "추천 패널 열기",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "recommend-for-active-note",
      name: "현재 노트에 대한 추천 받기",
      callback: async () => {
        const leaf = await this.activateView();
        const view = leaf?.view;
        if (view instanceof ConnectionPanel) {
          await view.recommendForActive();
        }
      },
    });

    this.addCommand({
      id: "clear-embedding-cache",
      name: "임베딩 캐시 초기화",
      callback: async () => {
        await this.clearEmbeddingCache();
      },
    });

    // ─── Phase 1 commands ─────────────────────────────────
    this.addCommand({
      id: "init-schema",
      name: "스키마 초기화 (cortex.schema.md + IDENTITY.md)",
      callback: () => void this.initSchema(),
    });

    this.addCommand({
      id: "run-lint",
      name: "스키마 lint 실행",
      callback: () => void this.runLintCommand(),
    });

    this.addCommand({
      id: "open-schema-file",
      name: "cortex.schema.md 열기",
      callback: () => void this.schemaManager.openSchemaFile(),
    });

    this.addCommand({
      id: "open-identity-file",
      name: "IDENTITY.md 열기",
      callback: () => void this.schemaManager.openIdentityFile(),
    });

    this.addCommand({
      id: "open-lint-report",
      name: "마지막 lint 리포트 열기",
      callback: () => void this.openLintReport(),
    });

    // ─── Phase 2 commands ─────────────────────────────────
    this.addCommand({
      id: "build-graph",
      name: "그래프 빌드 (vault 스캔 → PageRank → Louvain)",
      callback: () => void this.buildGraph(),
    });

    this.addCommand({
      id: "rewrite-vault-index",
      name: "VAULT_INDEX 다시쓰기 (그래프 → _index/*.md)",
      callback: () => void this.rewriteVaultIndex(),
    });

    this.addCommand({
      id: "refresh-god-nodes",
      name: "God nodes 갱신 (IDENTITY.md auto 섹션)",
      callback: () => void this.refreshGodNodes(),
    });

    this.addCommand({
      id: "show-graph-stats",
      name: "그래프 통계 보기",
      callback: () => this.showGraphStats(),
    });

    // ─── Phase 3 commands ─────────────────────────────────
    this.addCommand({
      id: "open-discovery-panel",
      name: "발견 패널 열기",
      callback: () => void this.activateDiscoveryView(),
    });

    this.addCommand({
      id: "run-discovery",
      name: "발견 실행 (구조 + Codex)",
      callback: () => void this.runDiscoveryCommand(true),
    });

    this.addCommand({
      id: "run-discovery-structural",
      name: "발견 실행 (구조만, LLM 끄기)",
      callback: () => void this.runDiscoveryCommand(false),
    });

    this.addCommand({
      id: "verify-codex",
      name: "Codex CLI 검증",
      callback: () => void this.verifyCodexCommand(),
    });

    this.addCommand({
      id: "clear-discovery-cache",
      name: "발견 LLM 캐시 초기화",
      callback: async () => {
        await this.discoveryCache.clear();
        new Notice("발견 LLM 캐시 초기화됨");
      },
    });

    // ─── Phase 4 commands ─────────────────────────────────
    this.addCommand({
      id: "open-review-panel",
      name: "리뷰 패널 열기",
      callback: () => void this.activateReviewView(),
    });

    this.addCommand({
      id: "compile-active-note",
      name: "현재 노트 컴파일 (raw → wiki/candidates)",
      callback: () => void this.compileActiveCommand(false),
    });

    this.addCommand({
      id: "compile-active-note-force",
      name: "현재 노트 강제 컴파일 (캐시 무시)",
      callback: () => void this.compileActiveCommand(true),
    });

    this.addCommand({
      id: "compile-raw-folder",
      name: "0 raw/ 일괄 컴파일",
      callback: () => void this.compileFolderCommand("0 raw/"),
    });

    // ─── Phase 5 commands ─────────────────────────────────
    this.addCommand({
      id: "run-extended-lint",
      name: "확장 lint 실행 (그래프 기반: orphan / broken / weak / silo)",
      callback: () => void this.runExtendedLintCommand(),
    });

    this.addCommand({
      id: "run-weekly-diagnostic",
      name: "주간 진단 실행 (스냅샷 + drift)",
      callback: () => void this.runWeeklyDiagnostic(),
    });

    this.addCommand({
      id: "open-latest-diagnostic",
      name: "최근 진단 리포트 열기",
      callback: () => void this.openLatestDiagnostic(),
    });

    this.addCommand({
      id: "toggle-scheduler",
      name: "자동 진단 스케줄러 토글",
      callback: () => void this.toggleScheduler(),
    });

    // ─── Phase 6 commands ─────────────────────────────────
    this.addCommand({
      id: "open-identity-panel",
      name: "정체성 패널 열기",
      callback: () => void this.activateIdentityView(),
    });

    this.addSettingTab(new CortexSettingTab(this.app, this));

    // M3 — Auto trigger on file-open for configured folder
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.handleFileOpen(file);
      }),
    );

    // Invalidate schema cache when either file is modified externally
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          if (
            file.path === this.schemaManager.schemaPath() ||
            file.path === this.schemaManager.identityPath()
          ) {
            this.schemaManager.invalidate();
          }
        }
      }),
    );

    // First-load hint: tell the user once if the schema is missing.
    void this.firstLoadHint();
  }

  async onunload(): Promise<void> {
    await this.embedder?.flushCache();
    await this.discoveryCache?.flush();
    this.scheduler?.stop();
    this.app.workspace.detachLeavesOfType(CONNECTION_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(DISCOVERY_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(REVIEW_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(IDENTITY_VIEW_TYPE);
  }

  // ─── Settings I/O ──────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Propagate provider config changes to engine
    this.embedder?.updateConfig({
      provider: this.settings.embeddingProvider,
      ollamaEndpoint: this.settings.ollamaEndpoint,
      ollamaModel: this.settings.ollamaModel,
    });
  }

  // ─── View management ───────────────────────────────────

  async activateView(): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(CONNECTION_VIEW_TYPE);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return null;
    await leaf.setViewState({ type: CONNECTION_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }

  // ─── Auto-trigger ──────────────────────────────────────

  private handleFileOpen(file: TFile | null): void {
    if (!this.settings.autoTrigger) return;
    if (!file) return;
    const folder = this.settings.autoTriggerFolder;
    if (folder && !file.path.startsWith(folder)) return;
    if (file.extension !== "md") return;

    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.runAutoRecommend();
    }, this.settings.autoTriggerDebounceMs);
  }

  private async runAutoRecommend(): Promise<void> {
    // Only run if the view is already open — don't force-open on every nav.
    const leaves = this.app.workspace.getLeavesOfType(CONNECTION_VIEW_TYPE);
    if (leaves.length === 0) return;
    const view = leaves[0].view;
    if (view instanceof ConnectionPanel) {
      await view.recommendForActive();
    }
  }

  // ─── Phase 1 — Schema + Identity ───────────────────────

  private async firstLoadHint(): Promise<void> {
    if (await this.schemaManager.schemaExists()) return;
    new Notice(
      "Cortex: 스키마가 없습니다. 명령 'Cortex: 스키마 초기화'를 실행하면 cortex.schema.md와 _index/IDENTITY.md가 생성됩니다.",
      8000,
    );
  }

  async initSchema(): Promise<void> {
    try {
      const created = await this.schemaManager.initIfMissing();
      if (created.length === 0) {
        new Notice("이미 cortex.schema.md와 IDENTITY.md가 존재합니다.");
        return;
      }
      new Notice(`✅ 생성됨: ${created.join(", ")}`);
      // Open the schema file so the user can edit it immediately.
      await this.schemaManager.openSchemaFile();
    } catch (err) {
      new Notice(
        `❌ 스키마 초기화 실패: ${err instanceof Error ? err.message : String(err)}`,
        10000,
      );
    }
  }

  async runLintCommand(): Promise<void> {
    try {
      const schema = await this.schemaManager.loadSchema();
      const identity = await this.schemaManager.loadIdentity();
      const report = await runLint(this.app, schema, identity);
      const path = await writeLintReport(this.app, report);

      const errs = report.violations.filter((v) => v.severity === "error").length;
      const warns = report.violations.filter((v) => v.severity === "warn").length;
      const infos = report.violations.filter((v) => v.severity === "info").length;

      const summary =
        report.violations.length === 0
          ? `✅ Lint 통과 (스캔 ${report.filesScanned}개)`
          : `Lint 완료: ❌${errs} ⚠${warns} ℹ${infos} (스캔 ${report.filesScanned}개) — ${path}`;
      new Notice(summary, 8000);

      // Auto-open the report if there are violations
      if (report.violations.length > 0) {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
      }
    } catch (err) {
      new Notice(
        `❌ Lint 실패: ${err instanceof Error ? err.message : String(err)}`,
        10000,
      );
    }
  }

  async openLintReport(): Promise<void> {
    const path = normalizePath(LINT_REPORT_PATH);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice("Lint 리포트가 없습니다. 'Cortex: 스키마 lint 실행'을 먼저 실행하세요.");
    }
  }

  // ─── Commands exposed to settings tab ──────────────────

  async clearEmbeddingCache(): Promise<void> {
    await this.embedder?.clearCache();
    new Notice("임베딩 캐시 초기화됨");
  }

  // ─── Phase 2 — Graph Core ──────────────────────────────

  /**
   * Full pipeline: scan vault → PageRank → Louvain → persist.
   * Does NOT rewrite VAULT_INDEX.md (separate command).
   */
  async buildGraph(): Promise<GraphStats | null> {
    try {
      const t0 = Date.now();
      new Notice("⏳ 그래프 빌드 중…", 4000);

      const buildRes = await buildGraphFromVault(this.app, this.graphStore);
      const godNodes = extractGodNodes(this.graphStore, { topK: 10 });
      const clusters = detectCommunities(this.graphStore, { minSize: 1 });
      await this.graphStore.save();

      const stats: GraphStats = {
        builtAt: Date.now(),
        nodeCount: this.graphStore.order(),
        edgeCount: this.graphStore.size(),
        realNodeCount: buildRes.realNodes,
        phantomNodeCount: buildRes.phantomNodes,
        clusterCount: clusters.length,
        topGodNodes: godNodes,
        clusters,
        durationMs: Date.now() - t0,
      };
      this.lastGraphStats = stats;
      void this.refreshStatusBar();

      new Notice(
        `✅ 그래프 빌드 완료 — 실제 ${stats.realNodeCount} · phantom ${stats.phantomNodeCount} · 엣지 ${stats.edgeCount} · 클러스터 ${stats.clusterCount} (${stats.durationMs}ms)`,
        8000,
      );
      return stats;
    } catch (err) {
      new Notice(
        `❌ 그래프 빌드 실패: ${err instanceof Error ? err.message : String(err)}`,
        12000,
      );
      console.error("[cortex] buildGraph", err);
      return null;
    }
  }

  /**
   * Write `_index/VAULT_INDEX.md` and `_index/GRAPH.md` from the in-memory
   * graph. If the graph is empty, build it first.
   */
  async rewriteVaultIndex(): Promise<void> {
    if (this.graphStore.order() === 0) {
      const stats = await this.buildGraph();
      if (!stats) return;
    }
    try {
      const clusters = this.lastGraphStats?.clusters ?? detectCommunities(this.graphStore);
      const res = await writeIndexFiles(this.app, this.graphStore, clusters);
      new Notice(
        `✅ ${res.vaultIndexPath} + ${res.graphPath} 작성 완료 (노트 ${res.noteCount}, 클러스터 ${res.clusterCount}, 엣지 ${res.edgeCount})`,
        8000,
      );
    } catch (err) {
      new Notice(
        `❌ VAULT_INDEX 쓰기 실패: ${err instanceof Error ? err.message : String(err)}`,
        12000,
      );
    }
  }

  /**
   * Refresh `auto_god_nodes` and `core_clusters` in IDENTITY.md based on
   * the latest graph. Does not touch the manual sections.
   */
  async refreshGodNodes(): Promise<void> {
    if (this.graphStore.order() === 0) {
      const stats = await this.buildGraph();
      if (!stats) return;
    }
    try {
      const stats = this.lastGraphStats;
      const godNodes = stats?.topGodNodes ?? extractGodNodes(this.graphStore, { topK: 10 });
      const clusters = stats?.clusters ?? detectCommunities(this.graphStore);
      const godIds = godNodes.slice(0, 10).map((g) => g.id);
      const clusterLabels = clusters.slice(0, 10).map((c) => c.label);

      if (!(await this.schemaManager.identityExists())) {
        new Notice(
          "⚠ IDENTITY.md가 없습니다. 'Cortex: 스키마 초기화' 먼저 실행하세요.",
          8000,
        );
        return;
      }
      await this.schemaManager.updateIdentityAutoSections(godIds, clusterLabels);
      new Notice(
        `✅ IDENTITY.md 갱신 — auto_god_nodes ${godIds.length}, core_clusters ${clusterLabels.length}`,
        8000,
      );
    } catch (err) {
      new Notice(
        `❌ God nodes 갱신 실패: ${err instanceof Error ? err.message : String(err)}`,
        12000,
      );
    }
  }

  // ─── Phase 3 — Discovery ───────────────────────────────

  async activateDiscoveryView(): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(DISCOVERY_VIEW_TYPE);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return null;
    await leaf.setViewState({ type: DISCOVERY_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }

  /**
   * Run the full discovery pipeline. If the graph is empty, build it first.
   * useLLM=true → Codex labels/questions/latent topics. useLLM=false → structural only.
   */
  async runDiscoveryCommand(useLLM = true): Promise<void> {
    // Trigger a full build if either:
    //   (a) the graph is empty, or
    //   (b) the graph loaded from disk but in-memory stats were lost on reload.
    // For 5-note vaults this is instant; for larger vaults the user can keep
    // the cached graph and only rebuild stats by hand if they prefer.
    if (this.graphStore.order() === 0 || !this.lastGraphStats) {
      const stats = await this.buildGraph();
      if (!stats) return;
    }

    const clusters = this.lastGraphStats?.clusters ?? [];
    if (clusters.length === 0) {
      new Notice("⚠ 클러스터가 0개입니다. 노트가 너무 적거나 링크가 없습니다.", 8000);
      return;
    }

    // Open the panel (creates if missing) and show running state
    const leaf = await this.activateDiscoveryView();
    const panel = leaf?.view instanceof DiscoveryPanel ? leaf.view : null;

    if (useLLM) {
      // Verify Codex first to fail fast with a friendly message.
      try {
        resetCodexDetection();
        await verifyCodex();
      } catch (err) {
        new Notice(
          `❌ Codex 미준비: ${err instanceof Error ? err.message : String(err)}`,
          15000,
        );
        return;
      }
    }

    panel?.setRunning(true, useLLM ? "발견 실행 중… (Codex 호출 포함)" : "발견 실행 중… (구조만)");

    const progressNotice = new Notice("⏳ 발견 실행 중…", 0);
    try {
      const result = await runDiscovery(this.app, this.graphStore, clusters, this.discoveryCache, {
        useLLM,
        topClustersForLLM: 5,
        topGapsForLLM: 3,
        concurrency: 3,
        perCallTimeoutMs: 60_000,
        onProgress: (done, total, label) => {
          progressNotice.setMessage(`⏳ 발견 [${done}/${total}] ${label}`);
        },
      });
      this.lastDiscoveryResult = result;
      panel?.setResult(result);

      const llmTag = result.llmUsed ? "LLM✓" : "구조만";
      const errs = result.errors.length;
      progressNotice.setMessage(
        `✅ 발견 완료 — 갭 ${result.gaps.length} · 다리 ${result.bridges.length} · ${llmTag}${errs > 0 ? ` · 오류 ${errs}` : ""}`,
      );
      setTimeout(() => progressNotice.hide(), 6000);
    } catch (err) {
      progressNotice.hide();
      new Notice(
        `❌ 발견 실행 실패: ${err instanceof Error ? err.message : String(err)}`,
        15000,
      );
      panel?.setRunning(false);
    }
  }

  async verifyCodexCommand(): Promise<void> {
    try {
      resetCodexDetection();
      const { version, binary } = await verifyCodex();
      new Notice(`✅ Codex 검증 성공\n${version}\n경로: ${binary}`, 8000);
    } catch (err) {
      new Notice(
        `❌ Codex 검증 실패: ${err instanceof Error ? err.message : String(err)}`,
        15000,
      );
    }
  }

  // ─── Phase 4 — Compile Pipeline ────────────────────────

  async activateReviewView(): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    if (existing.length > 0) {
      const leaf = existing[0];
      workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (view instanceof ReviewPanel) await view.refresh();
      return leaf;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return null;
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }

  async compileActiveCommand(force: boolean): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("열린 노트가 없습니다.");
      return;
    }
    if (file.extension !== "md") {
      new Notice("마크다운 파일만 컴파일할 수 있습니다.");
      return;
    }

    try {
      resetCodexDetection();
      await verifyCodex();
    } catch (err) {
      new Notice(
        `❌ Codex 미준비: ${err instanceof Error ? err.message : String(err)}`,
        15000,
      );
      return;
    }

    const progress = new Notice(`⏳ 컴파일 중: ${file.path}`, 0);
    try {
      const result = await compileFile(this.app, file, {
        force,
        timeoutMs: 120_000,
        onFile: (p, status, detail) => {
          progress.setMessage(`⏳ [${status}] ${p}${detail ? ` — ${detail}` : ""}`);
        },
      });
      progress.hide();
      if (result.errors.length > 0) {
        new Notice(`❌ 컴파일 실패: ${result.errors.join(" / ")}`, 12000);
      } else if (result.modelTag === "skip") {
        new Notice(`ℹ ${file.path} 는 동일 source_hash가 이미 컴파일됨 (force 옵션 필요).`, 8000);
      } else {
        new Notice(
          `✅ 컴파일 완료: ${file.path} → 컨셉 ${result.concepts.length}, 엔티티 ${result.entities.length}`,
          8000,
        );
      }
      // Auto-open review panel so the user sees what just appeared.
      await this.activateReviewView();
    } catch (err) {
      progress.hide();
      new Notice(
        `❌ 컴파일 실패: ${err instanceof Error ? err.message : String(err)}`,
        12000,
      );
    }
  }

  async compileFolderCommand(folder: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(normalizePath(folder)))) {
      new Notice(`폴더 없음: ${folder}`);
      return;
    }
    try {
      resetCodexDetection();
      await verifyCodex();
    } catch (err) {
      new Notice(
        `❌ Codex 미준비: ${err instanceof Error ? err.message : String(err)}`,
        15000,
      );
      return;
    }

    const progress = new Notice(`⏳ ${folder} 컴파일 시작…`, 0);
    let totalConcepts = 0;
    let totalEntities = 0;
    let errs = 0;
    try {
      const results = await compileFolder(this.app, folder, {
        timeoutMs: 120_000,
        onFile: (p, status, detail) => {
          progress.setMessage(`⏳ [${status}] ${p}${detail ? ` — ${detail}` : ""}`);
        },
      });
      for (const r of results) {
        totalConcepts += r.concepts.length;
        totalEntities += r.entities.length;
        if (r.errors.length > 0) errs++;
      }
      progress.hide();
      new Notice(
        `✅ ${folder} 컴파일 완료 — 컨셉 ${totalConcepts}, 엔티티 ${totalEntities}${errs > 0 ? `, 실패 ${errs}` : ""}`,
        10000,
      );
      await this.activateReviewView();
    } catch (err) {
      progress.hide();
      new Notice(
        `❌ 일괄 컴파일 실패: ${err instanceof Error ? err.message : String(err)}`,
        12000,
      );
    }
  }

  /**
   * Derive `lastGraphStats` from an already-loaded GraphStore, without
   * re-scanning the vault. Called on plugin load when graph.json existed.
   *
   * Cost: detectCommunities + extractGodNodes on N nodes. For 30 nodes ~10ms;
   * for 1000 nodes well under 1s. Cheap enough to run unconditionally on load.
   */
  private async hydrateStatsFromGraph(): Promise<void> {
    if (this.graphStore.order() === 0) return;
    try {
      const godNodes = extractGodNodes(this.graphStore, { topK: 10 });
      const clusters = detectCommunities(this.graphStore, { minSize: 1 });
      let real = 0;
      let phantom = 0;
      this.graphStore.forEachNode((_id, attrs) => {
        if (attrs.isPhantom) phantom++;
        else real++;
      });
      this.lastGraphStats = {
        builtAt: this.graphStore.builtAt,
        nodeCount: this.graphStore.order(),
        edgeCount: this.graphStore.size(),
        realNodeCount: real,
        phantomNodeCount: phantom,
        clusterCount: clusters.length,
        topGodNodes: godNodes,
        clusters,
        durationMs: 0,
      };
      void this.refreshStatusBar();
    } catch (err) {
      console.warn("[cortex] hydrate stats from graph failed:", err);
    }
  }

  // ─── Phase 6 — Identity Panel + Status Bar ─────────────

  async activateIdentityView(): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(IDENTITY_VIEW_TYPE);
    if (existing.length > 0) {
      const leaf = existing[0];
      workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (view instanceof IdentityPanel) await view.refresh();
      return leaf;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return null;
    await leaf.setViewState({ type: IDENTITY_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }

  /**
   * Refresh the Cortex status bar item with at-a-glance info.
   * Called after every operation that mutates graph or runs diagnostic.
   * Cheap — just reads in-memory stats.
   */
  async refreshStatusBar(): Promise<void> {
    if (!this.statusBarEl) return;
    const stats = this.lastGraphStats;
    if (!stats) {
      this.statusBarEl.setText("🧠 Cortex (그래프 미빌드)");
      this.statusBarEl.title = "클릭 → 정체성 패널";
      return;
    }
    const sched = this.scheduler?.isEnabled() ? "⏰" : "";
    this.statusBarEl.setText(
      `🧠 ${stats.realNodeCount}n · ${stats.clusterCount}c · ${stats.topGodNodes.length}god ${sched}`,
    );
    this.statusBarEl.title =
      `노드 ${stats.realNodeCount} · 클러스터 ${stats.clusterCount} · god nodes ${stats.topGodNodes.length}` +
      (sched ? "\n자동 진단 ON" : "") +
      "\n클릭 → 정체성 패널";
  }

  // ─── Phase 5 — Lint + Drift ────────────────────────────

  async runExtendedLintCommand(): Promise<void> {
    if (this.graphStore.order() === 0) {
      const stats = await this.buildGraph();
      if (!stats) return;
    }
    const report = runExtendedLint(this.graphStore);
    const errs = report.violations.filter((v) => v.severity === "error").length;
    const warns = report.violations.filter((v) => v.severity === "warn").length;
    const infos = report.violations.filter((v) => v.severity === "info").length;

    // Append to existing lint report from Phase 1, sectioned.
    const reportPath = normalizePath(LINT_REPORT_PATH);
    let existingPrefix = "";
    if (await this.app.vault.adapter.exists(reportPath)) {
      try {
        existingPrefix = await this.app.vault.adapter.read(reportPath);
      } catch {
        existingPrefix = "";
      }
    }

    const ts = new Date(report.scannedAt).toISOString().replace("T", " ").slice(0, 19);
    const sectionLines: string[] = [];
    sectionLines.push(`\n\n---\n\n## 확장 Lint (Phase 5) — ${ts}\n\n`);
    sectionLines.push(`Graph size: **${report.graphSize}** nodes · ❌${errs} ⚠${warns} ℹ${infos}\n\n`);
    if (report.violations.length === 0) {
      sectionLines.push("✅ 위반 없음.\n");
    } else {
      const bySev: Record<string, typeof report.violations> = { error: [], warn: [], info: [] };
      for (const v of report.violations) bySev[v.severity].push(v);
      for (const [sev, label] of [
        ["error", "❌ Error"],
        ["warn", "⚠ Warn"],
        ["info", "ℹ Info"],
      ] as const) {
        const items = bySev[sev];
        if (items.length === 0) continue;
        sectionLines.push(`### ${label} (${items.length})\n\n`);
        for (const v of items) {
          sectionLines.push(`- **${v.rule}** — \`${v.file}\`\n  - ${v.message}\n`);
          if (v.fix) sectionLines.push(`  - 💡 ${v.fix}\n`);
        }
        sectionLines.push("\n");
      }
    }

    const final = existingPrefix + sectionLines.join("");
    await this.app.vault.adapter.write(reportPath, final);

    new Notice(
      report.violations.length === 0
        ? `✅ 확장 lint 통과 (${report.graphSize} nodes)`
        : `확장 lint 완료: ❌${errs} ⚠${warns} ℹ${infos} (${report.graphSize} nodes) — ${reportPath}`,
      8000,
    );

    // Auto-open if violations
    if (report.violations.length > 0) {
      const file = this.app.vault.getAbstractFileByPath(reportPath);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
      }
    }
  }

  /**
   * Run a full diagnostic snapshot: rebuild graph → run discovery (LLM optional) →
   * compare to previous snapshot → write drift report. Save state under
   * state/diagnostics/<weekKey>.json + write the markdown report to
   * _index/CORTEX_DIAGNOSTIC_<weekKey>.md.
   */
  async runWeeklyDiagnostic(): Promise<void> {
    const useLLM = this.settings.weeklyDiagnosticUseLLM;
    const progress = new Notice("⏳ 주간 진단 실행 중…", 0);

    try {
      // Always rebuild graph to ensure fresh stats.
      const stats = await this.buildGraph();
      if (!stats) {
        progress.hide();
        return;
      }

      // Run discovery (LLM optional). Reuse the existing pipeline.
      progress.setMessage("⏳ 주간 진단 — 발견 실행 중…");
      // Inline minimal runDiscovery invocation (don't pop the Discovery panel).
      const { runDiscovery } = await import("./engine/discovery");
      const discovery = await runDiscovery(
        this.app,
        this.graphStore,
        stats.clusters,
        this.discoveryCache,
        {
          useLLM,
          topClustersForLLM: 5,
          topGapsForLLM: 3,
          concurrency: 3,
          perCallTimeoutMs: 60_000,
          onProgress: (done, total, label) => {
            progress.setMessage(`⏳ 주간 진단 [${done}/${total}] ${label}`);
          },
        },
      );
      this.lastDiscoveryResult = discovery;

      // Build snapshot
      const previous = await latestSnapshot(this.app);
      const snapshot = await buildSnapshot(this.app, {
        graphStats: stats,
        discovery,
        previousSnapshotTs: previous?.ts ?? 0,
      });
      const snapshotPath = await saveSnapshot(this.app, snapshot);

      // Compare to previous (if any)
      const signal = previous ? compareSnapshots(snapshot, previous) : null;

      // Write markdown report
      const md = renderDriftReport(snapshot, previous, signal);
      const reportPath = normalizePath(`_index/CORTEX_DIAGNOSTIC_${snapshot.weekKey}.md`);
      const dir = "_index";
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(reportPath, md);

      progress.hide();
      const sevStr = signal ? ` · drift ${signal.severity}` : "";
      new Notice(
        `✅ 주간 진단 완료 — ${snapshot.weekKey} (${snapshotPath})${sevStr}`,
        8000,
      );

      // Auto-open report
      const file = this.app.vault.getAbstractFileByPath(reportPath);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
      }

      // High drift → loud notice
      if (signal && (signal.severity === "high" || signal.severity === "medium")) {
        new Notice(
          `🔴 Drift ${signal.severity}: ${signal.reasons.join(" · ")}`,
          15000,
        );
      }
    } catch (err) {
      progress.hide();
      new Notice(
        `❌ 주간 진단 실패: ${err instanceof Error ? err.message : String(err)}`,
        15000,
      );
    }
  }

  async openLatestDiagnostic(): Promise<void> {
    const snapshot = await latestSnapshot(this.app);
    if (!snapshot) {
      new Notice("스냅샷이 없습니다. 'Cortex: 주간 진단 실행'을 먼저 실행하세요.");
      return;
    }
    const reportPath = normalizePath(`_index/CORTEX_DIAGNOSTIC_${snapshot.weekKey}.md`);
    const file = this.app.vault.getAbstractFileByPath(reportPath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice(`리포트 파일을 찾을 수 없습니다: ${reportPath}`);
    }
  }

  async toggleScheduler(): Promise<void> {
    this.settings.weeklyDiagnosticEnabled = !this.settings.weeklyDiagnosticEnabled;
    await this.saveSettings();
    if (this.settings.weeklyDiagnosticEnabled) {
      await this.scheduler.start();
      new Notice("⏰ 자동 주간 진단 ON — 일주일 후 자동 실행 (또는 catch-up).");
    } else {
      this.scheduler.stop();
      new Notice("⏸ 자동 주간 진단 OFF.");
    }
    void this.refreshStatusBar();
  }

  /** Show a Notice with the latest graph stats. */
  showGraphStats(): void {
    const s = this.lastGraphStats;
    if (!s) {
      new Notice("아직 그래프를 빌드하지 않았습니다. 먼저 'Cortex: 그래프 빌드' 실행.", 6000);
      return;
    }
    const top = s.topGodNodes.slice(0, 5).map((g) => g.id).join(", ");
    new Notice(
      `📊 노드 ${s.realNodeCount}+${s.phantomNodeCount}phantom · 엣지 ${s.edgeCount} · 클러스터 ${s.clusterCount}\n🏛 Top god: ${top}`,
      12000,
    );
  }

  async testOllama(): Promise<void> {
    if (this.settings.embeddingProvider !== "ollama") {
      new Notice("임베딩 제공자가 Ollama가 아닙니다.");
      return;
    }
    try {
      const dim = await this.embedder.testConnection();
      new Notice(
        `✅ Ollama 연결 성공 (${this.settings.ollamaModel}, ${dim}-dim)`,
      );
    } catch (err) {
      new Notice(
        `❌ Ollama 연결 실패: ${err instanceof Error ? err.message : String(err)}`,
        10000,
      );
    }
  }
}
