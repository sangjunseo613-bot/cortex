import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import {
  DiscoveryResult,
  GapPair,
  BridgeNode,
  DiagnosticStage,
} from "../types";
import { gapKey } from "../engine/discovery";
import type CortexPlugin from "../main";

export const DISCOVERY_VIEW_TYPE = "cortex-discovery-panel";

const STAGE_COLOR: Record<DiagnosticStage, string> = {
  BIASED: "#e88b3c",
  FOCUSED: "#3fb37f",
  DIVERSIFIED: "#3c9ee8",
  DISPERSED: "#d04545",
};

const STAGE_LABEL: Record<DiagnosticStage, string> = {
  BIASED: "BIASED — 한 토픽 편중",
  FOCUSED: "FOCUSED — 건강한 집중",
  DIVERSIFIED: "DIVERSIFIED — 다양성 양호",
  DISPERSED: "DISPERSED — 구조 약함",
};

/**
 * Discovery panel — surfaces structural diagnostics + gap/bridge/latent
 * findings + LLM-generated research questions.
 *
 * UX:
 *   - Top: diagnostic badge with one-line reason
 *   - Section "갭 탐지": gap pairs with shared tags, expandable to see questions
 *   - Section "다리 노드": bridge nodes ranked
 *   - Section "잠재 토픽": per-cluster missing subtopics
 *   - Bottom: errors block (if any LLM call failed)
 *
 * Run state is managed by main.ts; this view is purely presentational.
 */
export class DiscoveryPanel extends ItemView {
  private plugin: CortexPlugin;
  private lastResult: DiscoveryResult | null = null;
  private running = false;

  constructor(leaf: WorkspaceLeaf, plugin: CortexPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return DISCOVERY_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Cortex — 발견";
  }
  getIcon(): string {
    return "compass";
  }

  async onOpen(): Promise<void> {
    // If we already have a cached result, render it; else show empty state.
    this.lastResult = this.plugin.lastDiscoveryResult;
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  setResult(result: DiscoveryResult): void {
    this.lastResult = result;
    this.render();
  }

  setRunning(on: boolean, label?: string): void {
    this.running = on;
    if (on) this.renderRunning(label);
    else this.render();
  }

  // ─── Renders ──────────────────────────────────────────

  private render(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("cortex-discovery");

    const header = c.createEl("div", { cls: "zc-header" });
    header.createEl("h3", { text: "Cortex — 발견" });

    const runBtn = header.createEl("button", {
      text: "발견 실행",
      cls: "mod-cta",
    });
    runBtn.addEventListener("click", () => void this.plugin.runDiscoveryCommand());

    const refreshBtn = header.createEl("button", {
      text: "구조만 (LLM 끄기)",
      cls: "zc-refresh",
    });
    refreshBtn.setAttr("style", "margin-left: 6px;");
    refreshBtn.addEventListener("click", () => void this.plugin.runDiscoveryCommand(false));

    if (!this.lastResult) {
      c.createEl("p", {
        text: "먼저 그래프를 빌드한 뒤 [발견 실행]을 누르세요. Codex가 클러스터에 한국어 라벨을 붙이고, 갭에서 리서치 질문을 생성합니다.",
        cls: "zc-hint",
      });
      return;
    }

    const r = this.lastResult;

    // ── Diagnostic badge ─────────────────────────────────
    const badge = c.createEl("div", { cls: "cortex-diag" });
    badge.setAttr(
      "style",
      `background: ${STAGE_COLOR[r.diagnostic.stage]}22; border-left: 4px solid ${STAGE_COLOR[r.diagnostic.stage]}; padding: 8px 10px; margin: 8px 0 12px; border-radius: 4px;`,
    );
    badge.createEl("div", {
      text: STAGE_LABEL[r.diagnostic.stage],
      cls: "cortex-diag-stage",
    }).setAttr("style", "font-weight: 600; font-size: 0.95em;");
    badge.createEl("div", {
      text: r.diagnostic.reason,
      cls: "cortex-diag-reason",
    }).setAttr("style", "font-size: 0.85em; color: var(--text-muted); margin-top: 4px;");
    const meta = badge.createEl("div", { cls: "cortex-diag-meta" });
    meta.setAttr("style", "font-size: 0.78em; color: var(--text-faint); margin-top: 4px;");
    meta.setText(
      `Modularity ${r.diagnostic.modularity.toFixed(2)} · top cluster ${(r.diagnostic.topClusterRatio * 100).toFixed(0)}% · 의미 클러스터 ${r.diagnostic.meaningfulClusterCount}`,
    );

    if (!r.llmUsed) {
      const note = c.createEl("div", { cls: "zc-warn" });
      note.setText("ℹ LLM 끔 — 구조 분석만 표시됩니다. Codex 라벨/질문/잠재토픽이 비어 있을 수 있습니다.");
    }

    // ── Section: Gaps ──────────────────────────────────
    this.renderSectionHeader(c, "🕳 갭 탐지", `${r.gaps.length}개`);
    if (r.gaps.length === 0) {
      c.createEl("p", {
        text: "감지된 갭이 없습니다. 클러스터가 너무 적거나 토픽 겹침이 약합니다.",
        cls: "zc-empty",
      });
    } else {
      const list = c.createEl("div", { cls: "cortex-gap-list" });
      for (const gap of r.gaps) this.renderGap(list, gap, r);
    }

    // ── Section: Bridges ───────────────────────────────
    this.renderSectionHeader(c, "🌉 다리 노드", `${r.bridges.length}개`);
    if (r.bridges.length === 0) {
      c.createEl("p", {
        text: "다리 노드가 없습니다 (그래프가 너무 작거나 단일 클러스터).",
        cls: "zc-empty",
      });
    } else {
      const list = c.createEl("div", { cls: "cortex-bridge-list" });
      for (const b of r.bridges) this.renderBridge(list, b);
    }

    // ── Section: Latent topics ─────────────────────────
    const clustersWithLatent = Object.keys(r.latentTopics).length;
    this.renderSectionHeader(c, "💡 잠재 토픽", `${clustersWithLatent} 클러스터`);
    if (clustersWithLatent === 0) {
      c.createEl("p", {
        text: r.llmUsed
          ? "Codex가 잠재 토픽을 제안하지 못했습니다."
          : "(LLM이 꺼져 있어 표시 안 됨)",
        cls: "zc-empty",
      });
    } else {
      const list = c.createEl("div", { cls: "cortex-latent-list" });
      for (const [cid, topics] of Object.entries(r.latentTopics)) {
        if (!topics || topics.length === 0) continue;
        const label = r.clusterLabels[Number(cid)]?.label ?? `C${cid}`;
        this.renderLatent(list, label, topics);
      }
    }

    // ── Errors ────────────────────────────────────────
    if (r.errors.length > 0) {
      const errBlock = c.createEl("div", { cls: "zc-warn" });
      errBlock.setAttr("style", "margin-top: 12px;");
      errBlock.createEl("div", { text: `⚠ LLM 오류 ${r.errors.length}건` });
      const ul = errBlock.createEl("ul");
      ul.setAttr("style", "font-size: 0.8em; margin: 4px 0 0 16px;");
      for (const e of r.errors.slice(0, 5)) {
        ul.createEl("li", { text: e });
      }
    }
  }

  private renderRunning(label?: string): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("cortex-discovery");
    c.createEl("h3", { text: "Cortex — 발견" });
    const box = c.createEl("div", { cls: "zc-loading" });
    box.setText(label ?? "발견 실행 중…");
  }

  private renderSectionHeader(parent: HTMLElement, title: string, badge: string): void {
    const h = parent.createEl("h4", { text: title });
    h.setAttr("style", "margin: 18px 0 6px; display: flex; justify-content: space-between; align-items: baseline;");
    const span = h.createEl("span", { text: badge });
    span.setAttr("style", "font-size: 0.7em; color: var(--text-muted); font-weight: normal;");
  }

  private renderGap(parent: HTMLElement, gap: GapPair, r: DiscoveryResult): void {
    const card = parent.createEl("div", { cls: "zc-card" });

    const title = card.createEl("div", { cls: "zc-title-row" });
    title.createEl("span", {
      text: `${gap.labelA}  ↔  ${gap.labelB}`,
      cls: "zc-claim",
    }).setAttr("style", "font-weight: 600;");

    const meta = card.createEl("div", { cls: "zc-meta" });
    const tagStr = gap.sharedTags.length > 0 ? gap.sharedTags.slice(0, 4).join(", ") : "(태그 겹침 없음)";
    meta.setText(
      `점수 ${gap.score.toFixed(2)} · 공유 태그 ${tagStr} · 직접 엣지 ${gap.interEdges}`,
    );

    const samples = card.createEl("div", { cls: "zc-reason" });
    samples.setAttr("style", "font-size: 0.78em;");
    const aLine = `A 샘플: ${gap.sampleA.slice(0, 3).map((m) => m.id).join(", ") || "(없음)"}`;
    const bLine = `B 샘플: ${gap.sampleB.slice(0, 3).map((m) => m.id).join(", ") || "(없음)"}`;
    samples.setText(`${aLine}\n${bLine}`);
    samples.setAttr("style", "white-space: pre-line; font-size: 0.78em; color: var(--text-faint);");

    const qs = r.questions[gapKey(gap)];
    if (qs && qs.length > 0) {
      const qHeader = card.createEl("div");
      qHeader.setAttr("style", "margin-top: 6px; font-size: 0.82em; color: var(--text-accent); font-weight: 500;");
      qHeader.setText(`💭 리서치 질문 (${qs.length})`);
      const qList = card.createEl("ol");
      qList.setAttr("style", "margin: 4px 0 0 18px; font-size: 0.85em; line-height: 1.45;");
      for (const q of qs) qList.createEl("li", { text: q });
    }
  }

  private renderBridge(parent: HTMLElement, b: BridgeNode): void {
    const card = parent.createEl("div", { cls: "zc-card" });
    const titleRow = card.createEl("div", { cls: "zc-title-row" });
    const link = titleRow.createEl("span", { cls: "zc-claim" });
    link.setText(b.claim);
    link.setAttr("style", "font-weight: 500; cursor: pointer;");
    link.addEventListener("click", () => void this.openNode(b.id));

    const meta = card.createEl("div", { cls: "zc-meta" });
    meta.setText(
      `bridge ${b.bridgeScore.toFixed(2)} · betweenness ${b.betweenness.toFixed(2)} · pagerank ${b.pagerank.toFixed(3)} · cluster C${b.cluster}`,
    );
  }

  private renderLatent(parent: HTMLElement, label: string, topics: string[]): void {
    const card = parent.createEl("div", { cls: "zc-card" });
    card.createEl("div", { text: `클러스터: ${label}`, cls: "zc-meta" }).setAttr(
      "style",
      "font-weight: 600; color: var(--text-normal); margin-bottom: 4px;",
    );
    const ul = card.createEl("ul");
    ul.setAttr("style", "margin: 0 0 0 18px; font-size: 0.88em;");
    for (const t of topics) ul.createEl("li", { text: t });
  }

  private async openNode(id: string): Promise<void> {
    const node = this.plugin.graphStore.getNode(id);
    if (!node || !node.filePath) {
      new Notice(`'${id}' 노드의 파일을 찾을 수 없습니다.`);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(node.filePath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
