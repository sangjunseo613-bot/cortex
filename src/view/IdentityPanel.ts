import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
  GodNodeCandidate,
  ClusterInfo,
  IdentityFile,
  DiagnosticSnapshot,
  DriftSignal,
} from "../types";
import { latestSnapshot, listSnapshots, compareSnapshots } from "../pipeline/diagnostics";
import type CortexPlugin from "../main";

export const IDENTITY_VIEW_TYPE = "cortex-identity-panel";

const SEVERITY_COLOR: Record<string, string> = {
  none: "#3fb37f",
  low: "#7fb33f",
  medium: "#e88b3c",
  high: "#d04545",
};

const SEVERITY_LABEL: Record<string, string> = {
  none: "변동 없음",
  low: "경미한 drift",
  medium: "중간 drift",
  high: "큰 drift",
};

/**
 * Identity panel — vault의 정체성 코어를 한눈에.
 *
 * Sections:
 *   1. God nodes — manual locked vs auto top-N (with ⚠ if mismatch)
 *   2. Cluster gravity — top clusters by size + label
 *   3. Drift status — last snapshot vs previous (severity badge)
 *   4. Quick actions — schema/identity 파일 열기, refresh
 *
 * Reads from: lastGraphStats (in-memory), IDENTITY.md (file), latest snapshot.
 * No LLM calls; passive view.
 */
export class IdentityPanel extends ItemView {
  private plugin: CortexPlugin;
  private identity: IdentityFile | null = null;
  private snapshot: DiagnosticSnapshot | null = null;
  private previousSnapshot: DiagnosticSnapshot | null = null;
  private drift: DriftSignal | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CortexPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return IDENTITY_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Cortex — 정체성";
  }
  getIcon(): string {
    return "shield";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  async refresh(): Promise<void> {
    this.identity = await this.plugin.schemaManager.loadIdentity();
    const all = await listSnapshots(this.app);
    this.snapshot = all.length > 0 ? all[all.length - 1] : null;
    this.previousSnapshot = all.length > 1 ? all[all.length - 2] : null;
    this.drift =
      this.snapshot && this.previousSnapshot
        ? compareSnapshots(this.snapshot, this.previousSnapshot)
        : null;
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("cortex-identity");

    const header = c.createEl("div", { cls: "zc-header" });
    header.createEl("h3", { text: "Cortex — 정체성" });
    const refresh = header.createEl("button", {
      text: "새로고침",
      cls: "zc-refresh",
    });
    refresh.addEventListener("click", () => void this.refresh());

    if (!this.identity) {
      c.createEl("p", {
        text: "IDENTITY.md가 없습니다. 'Cortex: 스키마 초기화'를 먼저 실행하세요.",
        cls: "zc-hint",
      });
      const init = c.createEl("button", {
        text: "스키마 초기화",
        cls: "mod-cta",
      });
      init.addEventListener("click", async () => {
        await this.plugin.initSchema();
        await this.refresh();
      });
      return;
    }

    // ── Section 1: God Nodes ──────────────────────────
    this.section(c, "🏛 God Nodes", `manual ${this.identity.manualGodNodes.length} · auto ${this.identity.autoGodNodes.length}`);

    const godBlock = c.createEl("div", { cls: "zc-card" });

    if (this.identity.manualGodNodes.length === 0) {
      godBlock.createEl("div", {
        text: "🔒 Manual: (비어있음 — 형님이 IDENTITY.md에서 직접 잠그세요)",
        cls: "zc-meta",
      });
    } else {
      const manualHeader = godBlock.createEl("div", { cls: "zc-meta" });
      manualHeader.setText("🔒 Manual (locked)");
      manualHeader.style.fontWeight = "600";
      const ul = godBlock.createEl("ul");
      ul.style.margin = "4px 0 8px 18px";
      for (const id of this.identity.manualGodNodes) {
        const li = ul.createEl("li");
        const a = li.createEl("a", { text: id });
        a.setAttr("href", "#");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          void this.openNode(id);
        });
      }
    }

    if (this.identity.autoGodNodes.length === 0) {
      godBlock.createEl("div", {
        text: "🤖 Auto: (비어있음 — 'Cortex: God nodes 갱신' 실행 필요)",
        cls: "zc-meta",
      });
    } else {
      const autoHeader = godBlock.createEl("div", { cls: "zc-meta" });
      autoHeader.setText("🤖 Auto (latest scan)");
      autoHeader.style.fontWeight = "600";
      autoHeader.style.marginTop = "8px";
      const ul = godBlock.createEl("ul");
      ul.style.margin = "4px 0 0 18px";
      const manualSet = new Set(this.identity.manualGodNodes);
      for (const id of this.identity.autoGodNodes) {
        const li = ul.createEl("li");
        if (manualSet.has(id)) {
          // Already manually locked — green check
          li.createEl("span", { text: "✓ ", cls: "zc-id" });
        } else {
          // New auto suggestion not in manual — flag
          li.createEl("span", { text: "🆕 ", cls: "zc-id" });
        }
        const a = li.createEl("a", { text: id });
        a.setAttr("href", "#");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          void this.openNode(id);
        });
      }

      // Mismatch hint
      const newCount = this.identity.autoGodNodes.filter((id) => !manualSet.has(id)).length;
      if (newCount > 0 && this.identity.manualGodNodes.length > 0) {
        const hint = godBlock.createEl("div", { cls: "zc-reason" });
        hint.style.marginTop = "8px";
        hint.style.color = "var(--text-warning)";
        hint.setText(
          `⚠ 자동 추출에서 새 god node ${newCount}개 — IDENTITY.md를 검토하세요 (수용 시 manual_god_nodes에 추가).`,
        );
      }
    }

    // ── Section 2: Cluster Gravity ────────────────────
    this.section(c, "🌌 클러스터 중력장", `${this.identity.coreClusters.length}개`);
    const clusterBlock = c.createEl("div", { cls: "zc-card" });
    if (this.identity.coreClusters.length === 0) {
      clusterBlock.createEl("div", {
        text: "(비어있음 — 'Cortex: God nodes 갱신'으로 자동 채움)",
        cls: "zc-meta",
      });
    } else {
      const ul = clusterBlock.createEl("ul");
      ul.style.margin = "0 0 0 18px";
      for (const label of this.identity.coreClusters) {
        ul.createEl("li", { text: label });
      }
    }

    // ── Section 3: Drift ──────────────────────────────
    this.section(c, "📊 Drift 상태", "");
    const driftBlock = c.createEl("div", { cls: "zc-card" });

    if (!this.snapshot) {
      driftBlock.createEl("div", {
        text: "스냅샷이 없습니다. 'Cortex: 주간 진단 실행'으로 첫 스냅샷을 만드세요.",
        cls: "zc-meta",
      });
      const btn = driftBlock.createEl("button", {
        text: "주간 진단 지금 실행",
        cls: "mod-cta",
      });
      btn.style.marginTop = "8px";
      btn.addEventListener("click", async () => {
        await this.plugin.runWeeklyDiagnostic();
        await this.refresh();
      });
    } else {
      const date = new Date(this.snapshot.ts).toISOString().slice(0, 10);
      driftBlock.createEl("div", {
        text: `📅 마지막 스냅샷: ${date} (${this.snapshot.weekKey}) · 스냅샷 총 ${this.previousSnapshot ? "2+" : "1"}개`,
        cls: "zc-meta",
      });

      if (this.drift) {
        const sev = this.drift.severity;
        const color = SEVERITY_COLOR[sev] ?? "#888";
        const badge = driftBlock.createEl("div");
        badge.setAttr(
          "style",
          `display: inline-block; padding: 2px 10px; margin: 6px 0; border-radius: 8px; background: ${color}33; color: ${color}; border: 1px solid ${color}; font-weight: 600; font-size: 0.85em;`,
        );
        badge.setText(`${SEVERITY_LABEL[sev] ?? sev} (vs ${this.previousSnapshot?.weekKey})`);

        if (this.drift.reasons.length > 0) {
          const ul = driftBlock.createEl("ul");
          ul.style.margin = "4px 0 0 18px";
          ul.style.fontSize = "0.85em";
          for (const r of this.drift.reasons) ul.createEl("li", { text: r });
        }
      } else {
        driftBlock.createEl("div", {
          text: "비교 가능한 이전 스냅샷이 없습니다.",
          cls: "zc-meta",
        });
      }
    }

    // ── Section 4: Quick actions ──────────────────────
    this.section(c, "⚡ 빠른 작업", "");
    const actions = c.createEl("div", { cls: "zc-card" });
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "6px";

    const btnSchema = actions.createEl("button", { text: "📜 schema 열기" });
    btnSchema.addEventListener("click", () => void this.plugin.schemaManager.openSchemaFile());

    const btnIdentity = actions.createEl("button", { text: "🛡 IDENTITY 열기" });
    btnIdentity.addEventListener("click", () => void this.plugin.schemaManager.openIdentityFile());

    const btnRefreshGod = actions.createEl("button", { text: "🤖 god nodes 갱신" });
    btnRefreshGod.addEventListener("click", async () => {
      await this.plugin.refreshGodNodes();
      await this.refresh();
    });

    const btnDiag = actions.createEl("button", {
      text: "📊 주간 진단 실행",
      cls: "mod-cta",
    });
    btnDiag.addEventListener("click", async () => {
      await this.plugin.runWeeklyDiagnostic();
      await this.refresh();
    });
  }

  private section(parent: HTMLElement, title: string, badge: string): void {
    const h = parent.createEl("h4", { text: title });
    h.style.margin = "18px 0 6px";
    h.style.display = "flex";
    h.style.justifyContent = "space-between";
    h.style.alignItems = "baseline";
    if (badge) {
      const b = h.createEl("span", { text: badge });
      b.style.fontSize = "0.7em";
      b.style.color = "var(--text-muted)";
      b.style.fontWeight = "normal";
    }
  }

  private async openNode(id: string): Promise<void> {
    const node = this.plugin.graphStore.getNode(id);
    if (!node || !node.filePath) {
      // Fallback — try resolving as basename
      const file = this.app.metadataCache.getFirstLinkpathDest(id, "");
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
        return;
      }
      new Notice(`'${id}'를 찾을 수 없습니다. 그래프 빌드 후 다시 시도하세요.`);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(node.filePath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
