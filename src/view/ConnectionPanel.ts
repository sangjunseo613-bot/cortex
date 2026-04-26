import {
  ItemView,
  Notice,
  TFile,
  WorkspaceLeaf,
  MarkdownView,
} from "obsidian";
import { Candidate, SeedInfo, VaultIndex } from "../types";
import { loadVaultIndex, seedFromActiveFile } from "../engine/index-reader";
import { rankHybrid } from "../engine/hybrid-ranker";
import {
  buildPermanentCommand,
  copyToClipboard,
  saveCandidatesFile,
  tryOpenTerminal,
} from "../actions/save-candidates";
import {
  ClaudeRunHandle,
  ProgressRow,
  runClaude,
  summarizeEvent,
  vaultBasePath,
} from "../actions/run-claude";
import type CortexPlugin from "../main";

export const CONNECTION_VIEW_TYPE = "cortex-recommend-panel";

export class ConnectionPanel extends ItemView {
  private plugin: CortexPlugin;
  private cachedIndex: VaultIndex | null = null;
  private lastSeed: SeedInfo | null = null;
  private lastCandidates: Candidate[] = [];
  private selected = new Set<string>();
  private computing = false;

  constructor(leaf: WorkspaceLeaf, plugin: CortexPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CONNECTION_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Cortex — 추천";
  }
  getIcon(): string {
    return "link";
  }

  async onOpen(): Promise<void> {
    await this.renderEmpty();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private get noiseSet(): Set<string> {
    return new Set(this.plugin.settings.noiseValues);
  }

  private async ensureIndex(force = false): Promise<VaultIndex> {
    if (!this.cachedIndex || force) {
      this.cachedIndex = await loadVaultIndex(this.app);
    }
    return this.cachedIndex;
  }

  /** Public entry: triggered by command, button, or auto-trigger. */
  async recommendForActive(): Promise<void> {
    if (this.computing) return; // prevent overlapping runs
    this.computing = true;
    try {
      const file = this.app.workspace.getActiveFile();
      const seed = seedFromActiveFile(this.app, file);
      if (!file || !seed) {
        await this.renderEmpty("현재 파일에서 frontmatter를 읽을 수 없습니다.");
        return;
      }
      await this.renderLoading(seed.id);

      const index = await this.ensureIndex();
      const warnings: string[] = [];
      if (seed.isRaw) {
        warnings.push(
          `📝 raw 노트입니다 ("${seed.sourcePath}"). 태그·제목 단어 기반 + 의미 임베딩으로 후보를 선별합니다. [영구노트로 승격] 버튼으로 /fleeting scan 파이프라인을 실행할 수 있습니다.`,
        );
      } else if (!index.notes.has(seed.id)) {
        warnings.push(
          `ℹ VAULT_INDEX에 "${seed.id}"가 없습니다. /index 로 갱신하면 추천이 정확해집니다.`,
        );
      }
      if (!seed.isRaw && index.duplicateIds.has(seed.id)) {
        warnings.push(
          `⚠ id "${seed.id}"가 여러 노트에 중복되어 있습니다. 후보가 부정확할 수 있습니다.`,
        );
      }
      const noise = this.noiseSet;
      const clusterMissing = !seed.cluster || noise.has(seed.cluster);
      const meaningfulTags = seed.tags.filter((t) => !noise.has(t));
      if (clusterMissing && meaningfulTags.length === 0 && seed.links.length === 0) {
        warnings.push(
          "ℹ 클러스터·태그·링크가 모두 비어있습니다. 메타데이터를 보강하거나 임베딩을 켜세요.",
        );
      } else if (clusterMissing && meaningfulTags.length === 0) {
        warnings.push(
          "ℹ cluster/tags가 노이즈 값입니다. 링크 그래프 + 임베딩(켜졌다면)으로 추천 중입니다.",
        );
      }

      const s = this.plugin.settings;
      const result = await rankHybrid(
        this.app,
        seed,
        index,
        this.plugin.embedder,
        {
          poolSize: s.structuralPoolSize,
          topK: s.topK,
          structuralWeight: s.structuralWeight,
          semanticWeight: s.semanticWeight,
        },
        (id) => this.findFileById(id),
      );
      warnings.push(...result.warnings);

      this.lastSeed = seed;
      this.lastCandidates = result.candidates;
      this.selected.clear();
      await this.renderCandidates(seed, result.candidates, warnings);
    } catch (err) {
      console.error("[cortex]", err);
      new Notice(
        `추천 계산 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.computing = false;
    }
  }

  // ─── Empty / Loading states ─────────────────────────────────────────

  private async renderEmpty(message?: string): Promise<void> {
    const c = this.contentEl;
    c.empty();
    c.addClass("zc-panel");
    c.createEl("h3", { text: "Cortex" });
    const p = c.createEl("p", { cls: "zc-hint" });
    p.setText(
      message ??
        "id가 있는 영구노트를 여세요. 자동 계산이 켜져 있으면 자동으로, 아니면 아래 버튼을 누르세요.",
    );
    const btn = c.createEl("button", { text: "추천 받기", cls: "mod-cta" });
    btn.addEventListener("click", () => void this.recommendForActive());

    const reload = c.createEl("button", {
      text: "인덱스 재로드",
      cls: "zc-reload",
    });
    reload.setAttr("style", "margin-left: 8px;");
    reload.addEventListener("click", async () => {
      await this.ensureIndex(true);
      new Notice("인덱스 재로드 완료");
    });
  }

  private async renderLoading(seedId: string): Promise<void> {
    const c = this.contentEl;
    c.empty();
    c.addClass("zc-panel");
    c.createEl("h3", { text: "Cortex" });
    c.createEl("div", { cls: "zc-seed", text: `🎯 Seed: ${seedId}` });
    c.createEl("div", { text: "계산 중…", cls: "zc-loading" });
  }

  // ─── Main results render ────────────────────────────────────────────

  private async renderCandidates(
    seed: SeedInfo,
    candidates: Candidate[],
    warnings: string[] = [],
  ): Promise<void> {
    const c = this.contentEl;
    c.empty();
    c.addClass("zc-panel");

    const header = c.createEl("div", { cls: "zc-header" });
    header.createEl("h3", { text: "Cortex" });
    const meta = header.createEl("div", { cls: "zc-seed" });
    const noise = this.noiseSet;
    const clusterLabel =
      seed.cluster && !noise.has(seed.cluster) ? seed.cluster : "—";
    const tagLabel =
      seed.tags.filter((t) => !noise.has(t)).join(", ") || "—";
    if (seed.isRaw) {
      meta.setText(
        `📝 Raw: ${seed.claim} · tags: ${tagLabel}`,
      );
    } else {
      meta.setText(
        `🎯 Seed: ${seed.id} · cluster: ${clusterLabel} · tags: ${tagLabel}`,
      );
    }
    const refresh = header.createEl("button", {
      text: "다시 계산",
      cls: "zc-refresh",
    });
    refresh.addEventListener("click", () => void this.recommendForActive());

    for (const w of warnings) {
      const warn = c.createEl("div", { cls: "zc-warn" });
      warn.setText(w);
    }

    if (candidates.length === 0) {
      c.createEl("p", {
        text: "후보가 없습니다. 태그/클러스터/링크를 점검해보세요.",
        cls: "zc-empty",
      });
      return;
    }

    const list = c.createEl("div", { cls: "zc-list" });
    for (const cand of candidates) {
      this.renderCard(list, cand);
    }

    this.renderActionBar(c);
  }

  private renderCard(parent: HTMLElement, cand: Candidate): void {
    const card = parent.createEl("div", { cls: "zc-card" });

    const titleRow = card.createEl("div", { cls: "zc-title-row" });
    const checkbox = titleRow.createEl("input", {
      type: "checkbox",
      cls: "zc-check",
    }) as HTMLInputElement;
    checkbox.checked = this.selected.has(cand.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selected.add(cand.id);
      else this.selected.delete(cand.id);
      this.updateSelectionCount();
    });

    const title = titleRow.createEl("label", { cls: "zc-title" });
    title.createEl("span", { text: `${cand.id}  `, cls: "zc-id" });
    title.createEl("span", { text: cand.claim, cls: "zc-claim" });
    title.addEventListener("click", (ev) => {
      ev.preventDefault();
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });

    const metaLine = card.createEl("div", { cls: "zc-meta" });
    const tagStr = cand.tags.length > 0 ? ` · tags: ${cand.tags.join(", ")}` : "";
    const scoreStr = this.formatScore(cand);
    metaLine.setText(
      `cluster: ${cand.cluster || "—"}${tagStr} · ${scoreStr}`,
    );

    if (cand.reasons.length > 0) {
      const reason = card.createEl("div", { cls: "zc-reason" });
      reason.setText(`이유: ${cand.reasons.slice(0, 3).join(" · ")}`);
    }

    const actions = card.createEl("div", { cls: "zc-actions" });
    const insertBtn = actions.createEl("button", { text: "🔗 링크 삽입" });
    insertBtn.addEventListener("click", () => void this.insertLink(cand));
    const openBtn = actions.createEl("button", { text: "📖 열기" });
    openBtn.addEventListener("click", () => void this.openNote(cand.id));
  }

  private formatScore(cand: Candidate): string {
    const s = cand.score;
    if (typeof s.semantic === "number") {
      return `점수 ${s.combined.toFixed(2)} (구조 ${s.structural}, 의미 ${s.semantic.toFixed(2)})`;
    }
    return `score ${s.structural}`;
  }

  // ─── Action bar ─────────────────────────────────────────────────────

  private selectionCountEl: HTMLElement | null = null;

  private renderActionBar(parent: HTMLElement): void {
    const bar = parent.createEl("div", { cls: "zc-actionbar" });

    const left = bar.createEl("div", { cls: "zc-actionbar-left" });
    this.selectionCountEl = left.createEl("span", { cls: "zc-count" });
    this.updateSelectionCount();

    const quickAll = left.createEl("button", {
      text: "전체 선택",
      cls: "zc-linkbtn",
    });
    quickAll.addEventListener("click", () => this.toggleSelectAll());

    const right = bar.createEl("div", { cls: "zc-actionbar-right" });
    const saveBtn = right.createEl("button", {
      text: "💾 저장만",
      cls: "zc-savebtn",
    });
    saveBtn.addEventListener("click", () => void this.saveOnly());

    const isRawSeed = this.lastSeed?.isRaw === true;
    const runBtn = right.createEl("button", {
      text: isRawSeed ? "📝 영구노트로 승격" : "🧠 영구노트 생성",
      cls: "mod-cta zc-runbtn",
    });
    runBtn.setAttr(
      "title",
      isRawSeed
        ? "/fleeting scan \"<raw 파일>\" 를 실행해 이 fleeting 노트를 영구노트로 전환합니다"
        : "/permanent --from-candidates 를 실행해 선택된 후보들의 교차점에서 새 영구노트를 생성합니다",
    );
    runBtn.addEventListener("click", () => void this.saveAndHandoff());
  }

  private updateSelectionCount(): void {
    if (!this.selectionCountEl) return;
    this.selectionCountEl.setText(`선택된 후보: ${this.selected.size}개`);
  }

  private toggleSelectAll(): void {
    const allIds = this.lastCandidates.map((c) => c.id);
    const allSelected = allIds.every((id) => this.selected.has(id));
    this.selected = allSelected ? new Set() : new Set(allIds);
    const boxes = this.contentEl.querySelectorAll<HTMLInputElement>(".zc-check");
    boxes.forEach((box, idx) => {
      box.checked = this.selected.has(allIds[idx]);
    });
    this.updateSelectionCount();
  }

  // ─── Hand-off ───────────────────────────────────────────────────────

  private getPicked(): Candidate[] {
    return this.lastCandidates.filter((c) => this.selected.has(c.id));
  }

  private async saveOnly(): Promise<void> {
    if (!this.lastSeed) return;
    const picked = this.getPicked();
    if (picked.length === 0 && !this.lastSeed.isRaw) {
      new Notice("후보가 선택되지 않았습니다.");
      return;
    }
    const path = await saveCandidatesFile(
      this.app,
      this.lastSeed,
      picked,
      this.plugin.settings.candidatesPath,
    );
    new Notice(`저장됨: ${path} (${picked.length}개 후보)`);
  }

  // ─── Live CLI execution ─────────────────────────────────────────────

  private runHandle: ClaudeRunHandle | null = null;
  private progressRows: ProgressRow[] = [];
  private progressEl: HTMLElement | null = null;
  private progressListEl: HTMLElement | null = null;
  private progressHeaderEl: HTMLElement | null = null;
  private runStartedAt = 0;
  private runTickTimer: number | null = null;

  private async saveAndHandoff(): Promise<void> {
    if (!this.lastSeed) return;
    const picked = this.getPicked();

    // Permanent-seed path requires at least 1 picked (we're creating a new
    // permanent at the intersection of picks). Raw-seed path can run with 0
    // because /fleeting scan does its own searching; picked (if any) is a
    // hint written to candidates.json for enrichment.
    if (!this.lastSeed.isRaw && picked.length === 0) {
      new Notice("영구노트 생성 전에 후보를 1개 이상 선택하세요.");
      return;
    }

    // 1. Save JSON (always — empty `picked` is valid for raw path)
    const path = await saveCandidatesFile(
      this.app,
      this.lastSeed,
      picked,
      this.plugin.settings.candidatesPath,
    );

    // 2. Build prompt: branch by seed type.
    //    - Permanent: /permanent --from-candidates (autonomous mode per SKILL.md)
    //    - Raw      : /fleeting scan "<path>"    (single-file mode per SKILL.md)
    const prompt = this.lastSeed.isRaw
      ? `/fleeting scan "${this.lastSeed.sourcePath}"`
      : `/permanent --from-candidates ${path}`;

    // 3. Resolve cwd
    const cwd = vaultBasePath(this.app);
    if (!cwd) {
      new Notice(
        "볼트 경로를 해석할 수 없습니다. 대신 터미널 오픈으로 폴백합니다.",
      );
      const cmd = buildPermanentCommand(
        path,
        this.plugin.settings.cliCommandTemplate,
      );
      await copyToClipboard(cmd, true);
      tryOpenTerminal(this.app);
      return;
    }

    // 4. Kick off live run
    this.ensureProgressPanel();
    this.progressRows = [];
    this.renderProgress();
    this.runStartedAt = Date.now();
    this.updateRunHeader("실행 중…");
    this.startTick();

    const before = await this.snapshotPermanentFiles();

    this.runHandle = runClaude({
      cwd,
      prompt,
      onEvent: (evt) => {
        const rows = summarizeEvent(evt);
        if (rows.length === 0) return;
        this.progressRows.push(...rows);
        this.renderProgress();
      },
      onStderr: (chunk) => {
        // Only surface stderr when it contains something obviously wrong
        const trimmed = chunk.trim();
        if (!trimmed) return;
        if (/error|failed|refused/i.test(trimmed)) {
          this.progressRows.push({
            kind: "error",
            icon: "⚠",
            text: "stderr",
            detail: trimmed.slice(0, 200),
            isError: true,
          });
          this.renderProgress();
        } else {
          console.log("[claude stderr]", trimmed);
        }
      },
      onError: (err) => {
        this.progressRows.push({
          kind: "error",
          icon: "❌",
          text: "spawn 에러",
          detail: err.message,
          isError: true,
        });
        this.renderProgress();
      },
      onClose: async (code) => {
        this.stopTick();
        const durationS = Math.round((Date.now() - this.runStartedAt) / 1000);
        const ok = code === 0;
        this.updateRunHeader(
          ok ? `완료 (${durationS}s)` : `종료 (code=${code}, ${durationS}s)`,
          ok ? "success" : "error",
        );
        this.runHandle = null;

        // Open newly-created permanent note if any
        const newFile = await this.findNewPermanentFile(before);
        if (newFile) {
          this.progressRows.push({
            kind: "result",
            icon: "📝",
            text: "새 영구노트",
            detail: newFile.path,
          });
          this.renderProgress();
          this.attachOpenButton(newFile);
        }
      },
    });
  }

  private ensureProgressPanel(): void {
    if (this.progressEl && this.contentEl.contains(this.progressEl)) return;
    const panel = this.contentEl.createEl("div", { cls: "zc-progress" });
    this.progressEl = panel;

    const header = panel.createEl("div", { cls: "zc-progress-header" });
    this.progressHeaderEl = header;
    header.setText("실행 대기");

    const cancel = panel.createEl("button", {
      text: "중단",
      cls: "zc-progress-cancel",
    });
    cancel.addEventListener("click", () => {
      if (this.runHandle) {
        this.runHandle.cancel();
        this.updateRunHeader("중단 요청됨", "error");
      }
    });

    this.progressListEl = panel.createEl("div", { cls: "zc-progress-list" });
  }

  private renderProgress(): void {
    if (!this.progressListEl) return;
    this.progressListEl.empty();
    for (const row of this.progressRows) {
      const item = this.progressListEl.createEl("div", {
        cls: `zc-progress-row${row.isError ? " zc-progress-err" : ""}`,
      });
      const ic = item.createEl("span", { cls: "zc-progress-icon", text: row.icon });
      ic.setText(row.icon);
      const main = item.createEl("span", { cls: "zc-progress-main" });
      main.createEl("span", { cls: "zc-progress-text", text: row.text });
      if (row.detail) {
        main.createEl("span", {
          cls: "zc-progress-detail",
          text: ` · ${row.detail}`,
        });
      }
    }
    // Auto-scroll to bottom
    this.progressListEl.scrollTop = this.progressListEl.scrollHeight;
  }

  private updateRunHeader(
    text: string,
    status: "running" | "success" | "error" = "running",
  ): void {
    if (!this.progressHeaderEl) return;
    this.progressHeaderEl.setText(text);
    this.progressHeaderEl.removeClass("zc-progress-running");
    this.progressHeaderEl.removeClass("zc-progress-success");
    this.progressHeaderEl.removeClass("zc-progress-error");
    this.progressHeaderEl.addClass(`zc-progress-${status}`);
  }

  private startTick(): void {
    this.stopTick();
    this.updateRunHeader("실행 중… 0s");
    this.runTickTimer = window.setInterval(() => {
      const s = Math.round((Date.now() - this.runStartedAt) / 1000);
      if (this.progressHeaderEl && this.runHandle) {
        this.progressHeaderEl.setText(`실행 중… ${s}s`);
      }
    }, 1000);
  }

  private stopTick(): void {
    if (this.runTickTimer !== null) {
      window.clearInterval(this.runTickTimer);
      this.runTickTimer = null;
    }
  }

  private async snapshotPermanentFiles(): Promise<Set<string>> {
    const set = new Set<string>();
    const folder = this.plugin.settings.permanentFolder;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (folder && !f.path.startsWith(folder)) continue;
      set.add(f.path);
    }
    return set;
  }

  private async findNewPermanentFile(
    before: Set<string>,
  ): Promise<TFile | null> {
    const folder = this.plugin.settings.permanentFolder;
    // Small delay so the vault has a chance to index the new file
    await new Promise((r) => setTimeout(r, 400));
    const after = this.app.vault.getMarkdownFiles();
    let newest: TFile | null = null;
    let newestMtime = 0;
    for (const f of after) {
      if (folder && !f.path.startsWith(folder)) continue;
      if (before.has(f.path)) continue;
      if ((f.stat.mtime ?? 0) > newestMtime) {
        newest = f;
        newestMtime = f.stat.mtime ?? 0;
      }
    }
    return newest;
  }

  private attachOpenButton(file: TFile): void {
    if (!this.progressEl) return;
    const btn = this.progressEl.createEl("button", {
      text: `📖 ${file.basename} 열기`,
      cls: "mod-cta zc-progress-open",
    });
    btn.addEventListener("click", async () => {
      await this.app.workspace.getLeaf(false).openFile(file);
    });
  }

  // ─── Link insert / navigate ─────────────────────────────────────────

  private async insertLink(cand: Candidate): Promise<void> {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = this.app.workspace.getActiveFile();
    if (!mdView || !activeFile) {
      new Notice("활성 마크다운 편집기가 없습니다.");
      return;
    }
    const targetFile = this.findFileById(cand.id);
    const linkText = targetFile ? `[[${targetFile.basename}]]` : `[[${cand.id}]]`;

    // Insert at cursor
    mdView.editor.replaceSelection(linkText);

    // Also add to frontmatter links[] if not present (M3)
    try {
      await this.app.fileManager.processFrontMatter(activeFile, (fm) => {
        const existing: string[] = Array.isArray(fm.links) ? fm.links : [];
        if (!existing.includes(cand.id)) {
          fm.links = [...existing, cand.id];
        }
      });
      new Notice(`🔗 링크 삽입: ${linkText} (frontmatter에도 추가)`);
    } catch (err) {
      console.warn("[cortex] frontmatter update failed:", err);
      new Notice(`🔗 링크 삽입: ${linkText} (frontmatter 갱신 실패)`);
    }
  }

  private findFileById(id: string): TFile | null {
    const files = this.app.vault.getMarkdownFiles();
    const folder = this.plugin.settings.permanentFolder;
    for (const f of files) {
      if (folder && !f.path.startsWith(folder)) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache?.frontmatter?.id === id) return f;
      if (f.basename.startsWith(`${id} `) || f.basename.startsWith(`${id}.`)) {
        return f;
      }
    }
    return null;
  }

  private async openNote(id: string): Promise<void> {
    const file = this.findFileById(id);
    if (!file) {
      new Notice(`${id}에 해당하는 파일을 찾지 못했습니다.`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }
}
