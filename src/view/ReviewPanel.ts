import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { ApprovalItem } from "../types";
import {
  listApprovalQueue,
  promoteCandidate,
  rejectCandidate,
} from "../pipeline/approval";
import type CortexPlugin from "../main";

export const REVIEW_VIEW_TYPE = "cortex-review-panel";

const PROVENANCE_COLOR: Record<string, string> = {
  extracted: "#3fb37f",
  inferred: "#3c9ee8",
  ambiguous: "#e88b3c",
};

const CONFIDENCE_LABEL: Record<number, string> = {
  0: "추측",
  1: "그럴듯",
  2: "명확",
};

/**
 * Review panel — list pending candidates, promote/reject individually or
 * in bulk. Each item shows source, claim, tags, provenance, confidence.
 */
export class ReviewPanel extends ItemView {
  private plugin: CortexPlugin;
  private items: ApprovalItem[] = [];
  private selected = new Set<string>();
  private filterType: "all" | "concept" | "entity" = "all";

  constructor(leaf: WorkspaceLeaf, plugin: CortexPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return REVIEW_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Cortex — 리뷰";
  }
  getIcon(): string {
    return "check-square";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  async refresh(): Promise<void> {
    this.items = await listApprovalQueue(this.app);
    this.selected.clear();
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("cortex-review");

    const header = c.createEl("div", { cls: "zc-header" });
    header.createEl("h3", { text: "Cortex — 리뷰" });
    const refreshBtn = header.createEl("button", {
      text: "새로고침",
      cls: "zc-refresh",
    });
    refreshBtn.addEventListener("click", () => void this.refresh());

    // Filter tabs
    const filterRow = c.createEl("div");
    filterRow.setAttr(
      "style",
      "display: flex; gap: 6px; margin: 6px 0 10px; font-size: 0.85em;",
    );
    for (const f of ["all", "concept", "entity"] as const) {
      const btn = filterRow.createEl("button");
      btn.setText(f === "all" ? "전체" : f === "concept" ? "컨셉" : "엔티티");
      btn.style.background =
        this.filterType === f ? "var(--interactive-accent)" : "transparent";
      btn.style.color =
        this.filterType === f ? "var(--text-on-accent)" : "var(--text-muted)";
      btn.addEventListener("click", () => {
        this.filterType = f;
        this.render();
      });
    }

    const filtered = this.items.filter((it) =>
      this.filterType === "all" ? true : it.type === this.filterType,
    );

    if (filtered.length === 0) {
      c.createEl("p", {
        text:
          this.items.length === 0
            ? "승인 대기 후보가 없습니다. `Cortex: 현재 노트 컴파일` 또는 `0 raw/ 일괄 컴파일`을 실행하세요."
            : "현재 필터로 일치하는 후보가 없습니다.",
        cls: "zc-empty",
      });
      return;
    }

    // Bulk action bar
    const bar = c.createEl("div", { cls: "zc-actionbar" });
    bar.style.marginBottom = "10px";
    bar.style.position = "static";

    const count = bar.createEl("span", { cls: "zc-count" });
    count.setText(`${filtered.length}개 후보 · ${this.selected.size}개 선택`);

    const selectAll = bar.createEl("button", {
      text: "전체 선택",
      cls: "zc-linkbtn",
    });
    selectAll.addEventListener("click", () => {
      const allKeys = filtered.map((it) => it.path);
      const everyone = allKeys.every((k) => this.selected.has(k));
      this.selected = everyone ? new Set() : new Set(allKeys);
      this.render();
    });

    const right = bar.createEl("div", { cls: "zc-actionbar-right" });

    const bulkApprove = right.createEl("button", {
      text: "✅ 일괄 승인",
      cls: "mod-cta",
    });
    bulkApprove.addEventListener("click", async () => {
      await this.bulkApprove();
    });

    const bulkReject = right.createEl("button", { text: "❌ 일괄 거절" });
    bulkReject.addEventListener("click", async () => {
      await this.bulkReject();
    });

    // List
    const list = c.createEl("div", { cls: "zc-list" });
    for (const it of filtered) this.renderCard(list, it);
  }

  private renderCard(parent: HTMLElement, item: ApprovalItem): void {
    const card = parent.createEl("div", { cls: "zc-card" });

    const titleRow = card.createEl("div", { cls: "zc-title-row" });
    const checkbox = titleRow.createEl("input", {
      type: "checkbox",
      cls: "zc-check",
    }) as HTMLInputElement;
    checkbox.checked = this.selected.has(item.path);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selected.add(item.path);
      else this.selected.delete(item.path);
      this.render();
    });

    const title = titleRow.createEl("label", { cls: "zc-title" });
    title.createEl("span", {
      text: item.type === "concept" ? "🧩 " : "👤 ",
      cls: "zc-id",
    });
    title.createEl("span", { text: item.claim, cls: "zc-claim" });

    // Meta line
    const meta = card.createEl("div", { cls: "zc-meta" });
    const tagStr = item.tags.length > 0 ? item.tags.slice(0, 4).join(", ") : "—";
    meta.setText(
      `source: ${item.source} · tags: ${tagStr} · confidence: ${CONFIDENCE_LABEL[item.confidence] ?? "?"}`,
    );

    // Provenance pill
    const prov = card.createEl("span");
    prov.setText(item.provenance);
    prov.setAttr(
      "style",
      `display: inline-block; padding: 1px 8px; margin-top: 4px; border-radius: 8px; font-size: 0.72em; background: ${PROVENANCE_COLOR[item.provenance] ?? "#888"}33; color: ${PROVENANCE_COLOR[item.provenance] ?? "#888"}; border: 1px solid ${PROVENANCE_COLOR[item.provenance] ?? "#888"};`,
    );

    // Action buttons
    const actions = card.createEl("div", { cls: "zc-actions" });
    const previewBtn = actions.createEl("button", { text: "📖 미리보기" });
    previewBtn.addEventListener("click", () => void this.openPath(item.path));

    const approveBtn = actions.createEl("button", {
      text: "✅ 승인",
      cls: "mod-cta",
    });
    approveBtn.addEventListener("click", async () => {
      await this.approveOne(item);
    });

    const rejectBtn = actions.createEl("button", { text: "❌ 거절" });
    rejectBtn.addEventListener("click", async () => {
      await this.rejectOne(item);
    });
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private async approveOne(item: ApprovalItem): Promise<void> {
    const result = await promoteCandidate(this.app, item.path);
    if (result.kind === "moved") {
      new Notice(`✅ 승인: ${item.path} → ${result.dest}`, 5000);
    } else if (result.kind === "merged") {
      new Notice(
        `🔀 병합: ${item.path} → ${result.dest} (+${result.addedMentions} 발췌)`,
        5000,
      );
    } else if (result.kind === "skipped") {
      new Notice(`⏭ 건너뜀: ${result.reason}`, 5000);
    } else {
      new Notice(`❌ 승인 실패: ${result.message}`, 8000);
    }
    await this.refresh();
  }

  private async rejectOne(item: ApprovalItem): Promise<void> {
    try {
      await rejectCandidate(this.app, item.path);
      new Notice(`🗑 거절: ${item.path}`, 5000);
      await this.refresh();
    } catch (err) {
      new Notice(
        `❌ 거절 실패: ${err instanceof Error ? err.message : String(err)}`,
        8000,
      );
    }
  }

  private async bulkApprove(): Promise<void> {
    const targets = [...this.selected];
    if (targets.length === 0) {
      new Notice("선택된 후보가 없습니다.");
      return;
    }
    let moved = 0,
      merged = 0,
      skipped = 0,
      errors = 0;
    const errMsgs: string[] = [];
    for (const p of targets) {
      const r = await promoteCandidate(this.app, p);
      if (r.kind === "moved") moved++;
      else if (r.kind === "merged") merged++;
      else if (r.kind === "skipped") skipped++;
      else {
        errors++;
        errMsgs.push(`${p}: ${r.message}`);
      }
    }
    const parts: string[] = [];
    if (moved > 0) parts.push(`✅ ${moved} 승인`);
    if (merged > 0) parts.push(`🔀 ${merged} 병합`);
    if (skipped > 0) parts.push(`⏭ ${skipped} 건너뜀`);
    if (errors > 0) parts.push(`❌ ${errors} 실패`);
    new Notice(parts.join(" · "), 8000);
    if (errors > 0) {
      console.warn("[cortex] bulkApprove errors:", errMsgs);
    }
    await this.refresh();
  }

  private async bulkReject(): Promise<void> {
    const targets = [...this.selected];
    if (targets.length === 0) {
      new Notice("선택된 후보가 없습니다.");
      return;
    }
    let ok = 0;
    for (const p of targets) {
      try {
        await rejectCandidate(this.app, p);
        ok++;
      } catch {
        // continue
      }
    }
    new Notice(`🗑 ${ok}개 거절`, 6000);
    await this.refresh();
  }
}
