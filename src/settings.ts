import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CortexPlugin from "./main";

export interface CortexSettings {
  // Ranking
  topK: number;
  structuralPoolSize: number;
  structuralWeight: number; // 0..1
  semanticWeight: number; // 0..1

  // Auto trigger
  autoTrigger: boolean;
  autoTriggerFolder: string; // e.g. "2 Permanent/"
  autoTriggerDebounceMs: number;

  // Embedding provider
  embeddingProvider: "off" | "ollama";
  ollamaEndpoint: string;
  ollamaModel: string;

  // Noise filter
  noiseValues: string[];

  // Output paths
  candidatesPath: string;
  permanentFolder: string;

  // CLI handoff
  cliCommandTemplate: string;

  // Phase 5 — scheduler
  weeklyDiagnosticEnabled: boolean;
  weeklyDiagnosticUseLLM: boolean;
}

export const DEFAULT_SETTINGS: CortexSettings = {
  topK: 7,
  structuralPoolSize: 50,
  structuralWeight: 0.6,
  semanticWeight: 0.4,

  autoTrigger: true,
  autoTriggerFolder: "2 Permanent/",
  autoTriggerDebounceMs: 400,

  embeddingProvider: "ollama",
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "nomic-embed-text",

  noiseValues: ["미분류", "unclassified", ""],

  candidatesPath: "_index/connect-candidates.json",
  permanentFolder: "2 Permanent/",

  cliCommandTemplate: 'claude "/permanent --from-candidates {path}"',

  // Phase 5 defaults — opt-in (off by default to avoid surprise LLM calls)
  weeklyDiagnosticEnabled: false,
  weeklyDiagnosticUseLLM: true,
};

export class CortexSettingTab extends PluginSettingTab {
  plugin: CortexPlugin;

  constructor(app: App, plugin: CortexPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Cortex" });

    // ── Schema + Identity (Phase 1) ───────────────────
    containerEl.createEl("h3", { text: "스키마 · 정체성" });

    new Setting(containerEl)
      .setName("스키마 초기화")
      .setDesc(
        "cortex.schema.md (운영 계약) + _index/IDENTITY.md (god nodes 코어)를 생성합니다. 이미 있으면 그대로 둡니다.",
      )
      .addButton((b) =>
        b
          .setButtonText("초기화")
          .setCta()
          .onClick(async () => {
            await this.plugin.initSchema();
          }),
      );

    new Setting(containerEl)
      .setName("스키마 파일 열기")
      .addButton((b) =>
        b.setButtonText("cortex.schema.md").onClick(async () => {
          await this.plugin.schemaManager.openSchemaFile();
        }),
      )
      .addButton((b) =>
        b.setButtonText("IDENTITY.md").onClick(async () => {
          await this.plugin.schemaManager.openIdentityFile();
        }),
      );

    new Setting(containerEl)
      .setName("Lint 실행")
      .setDesc(
        "vault 전체를 스캔해 schema 위반·orphan·forbidden_word를 찾고 _index/CORTEX_LINT_REPORT.md에 기록합니다.",
      )
      .addButton((b) =>
        b
          .setButtonText("Lint 실행")
          .setCta()
          .onClick(async () => {
            await this.plugin.runLintCommand();
          }),
      )
      .addButton((b) =>
        b.setButtonText("리포트 열기").onClick(async () => {
          await this.plugin.openLintReport();
        }),
      );

    // ── Graph (Phase 2) ──────────────────────────────
    containerEl.createEl("h3", { text: "그래프 코어" });

    new Setting(containerEl)
      .setName("그래프 빌드")
      .setDesc(
        "vault를 스캔해 노드+엣지를 추출하고 PageRank·Louvain을 실행합니다. state/graph.json에 저장.",
      )
      .addButton((b) =>
        b
          .setButtonText("빌드")
          .setCta()
          .onClick(async () => {
            await this.plugin.buildGraph();
            this.display();
          }),
      )
      .addButton((b) =>
        b.setButtonText("통계 보기").onClick(() => {
          this.plugin.showGraphStats();
        }),
      );

    new Setting(containerEl)
      .setName("VAULT_INDEX 다시쓰기")
      .setDesc(
        "그래프 → _index/VAULT_INDEX.md + _index/GRAPH.md. 빌드되지 않았으면 자동 빌드.",
      )
      .addButton((b) =>
        b.setButtonText("다시쓰기").onClick(async () => {
          await this.plugin.rewriteVaultIndex();
        }),
      );

    new Setting(containerEl)
      .setName("God nodes 갱신")
      .setDesc(
        "PageRank 결과를 IDENTITY.md의 auto_god_nodes에 기록 (manual 섹션은 보존).",
      )
      .addButton((b) =>
        b.setButtonText("갱신").onClick(async () => {
          await this.plugin.refreshGodNodes();
        }),
      );

    // ── Discovery + Codex (Phase 3) ───────────────────
    containerEl.createEl("h3", { text: "발견 · Codex" });

    new Setting(containerEl)
      .setName("Codex CLI 검증")
      .setDesc("`codex --version` 실행. 미설치/미로그인이면 안내 메시지 표시.")
      .addButton((b) =>
        b.setButtonText("검증").onClick(async () => {
          await this.plugin.verifyCodexCommand();
        }),
      );

    new Setting(containerEl)
      .setName("발견 실행")
      .setDesc(
        "그래프 → 진단 + 갭 + 다리 + Codex 라벨 + 리서치 질문 + 잠재 토픽. 구조만 모드 가능.",
      )
      .addButton((b) =>
        b
          .setButtonText("LLM 포함")
          .setCta()
          .onClick(async () => {
            await this.plugin.runDiscoveryCommand(true);
          }),
      )
      .addButton((b) =>
        b.setButtonText("구조만").onClick(async () => {
          await this.plugin.runDiscoveryCommand(false);
        }),
      )
      .addButton((b) =>
        b.setButtonText("패널 열기").onClick(async () => {
          await this.plugin.activateDiscoveryView();
        }),
      );

    new Setting(containerEl)
      .setName("LLM 캐시")
      .setDesc(
        ".obsidian/plugins/cortex/state/discovery-cache.json — 클러스터/갭 입력이 같으면 캐시 사용 (TTL 14일).",
      )
      .addButton((b) =>
        b.setButtonText("캐시 초기화").onClick(async () => {
          await this.plugin.discoveryCache.clear();
          new Notice("발견 LLM 캐시 초기화됨");
        }),
      );

    // ── Compile Pipeline (Phase 4) ────────────────────
    containerEl.createEl("h3", { text: "컴파일 파이프라인" });

    new Setting(containerEl)
      .setName("현재 노트 컴파일")
      .setDesc(
        "현재 열린 노트를 raw로 간주하고 Codex로 컨셉/엔티티 추출 → 1 wiki/candidates/ 생성. 동일 source_hash는 자동 skip.",
      )
      .addButton((b) =>
        b
          .setButtonText("컴파일")
          .setCta()
          .onClick(async () => {
            await this.plugin.compileActiveCommand(false);
          }),
      )
      .addButton((b) =>
        b.setButtonText("강제 재컴파일").onClick(async () => {
          await this.plugin.compileActiveCommand(true);
        }),
      );

    new Setting(containerEl)
      .setName("0 raw/ 일괄 컴파일")
      .setDesc("0 raw/ 폴더 모든 마크다운 파일 순차 컴파일.")
      .addButton((b) =>
        b.setButtonText("일괄 실행").onClick(async () => {
          await this.plugin.compileFolderCommand("0 raw/");
        }),
      );

    new Setting(containerEl)
      .setName("리뷰 패널")
      .setDesc(
        "wiki/candidates/ 의 후보를 검토하고 wiki/concepts·entities/ 로 promote 또는 거절.",
      )
      .addButton((b) =>
        b.setButtonText("리뷰 패널 열기").onClick(async () => {
          await this.plugin.activateReviewView();
        }),
      );

    // ── Lint + Drift (Phase 5) ────────────────────────
    containerEl.createEl("h3", { text: "Lint · Drift" });

    new Setting(containerEl)
      .setName("확장 lint")
      .setDesc(
        "그래프 기반 — orphan(완전 고립), broken-wikilink(존재 안 하는 노트 참조), weak-connection(degree 1), isolated-component(silo).",
      )
      .addButton((b) =>
        b
          .setButtonText("Lint 실행")
          .setCta()
          .onClick(async () => {
            await this.plugin.runExtendedLintCommand();
          }),
      );

    new Setting(containerEl)
      .setName("주간 진단")
      .setDesc(
        "스냅샷(state/diagnostics/<week>.json) + 이전과 drift 비교 + _index/CORTEX_DIAGNOSTIC_<week>.md 작성.",
      )
      .addButton((b) =>
        b
          .setButtonText("지금 실행")
          .setCta()
          .onClick(async () => {
            await this.plugin.runWeeklyDiagnostic();
          }),
      )
      .addButton((b) =>
        b.setButtonText("최근 리포트 열기").onClick(async () => {
          await this.plugin.openLatestDiagnostic();
        }),
      );

    new Setting(containerEl)
      .setName("자동 진단 스케줄러")
      .setDesc(
        "ON 시 24시간마다 체크 → 마지막 스냅샷이 7일 이상이면 자동 실행. 옵트인 (기본 OFF). LLM 호출 포함.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.weeklyDiagnosticEnabled)
          .onChange(async (v) => {
            this.plugin.settings.weeklyDiagnosticEnabled = v;
            await this.plugin.saveSettings();
            if (v) await this.plugin.scheduler.start();
            else this.plugin.scheduler.stop();
          }),
      );

    new Setting(containerEl)
      .setName("자동 진단에 LLM 사용")
      .setDesc(
        "OFF 시 구조 진단만 (Codex 호출 0). 자동 실행이 의도치 않은 비용/시간 낭비 위험을 피하려면 OFF 권장.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.weeklyDiagnosticUseLLM)
          .onChange(async (v) => {
            this.plugin.settings.weeklyDiagnosticUseLLM = v;
            await this.plugin.saveSettings();
          }),
      );

    // Compact stats display when available
    const stats = this.plugin.lastGraphStats;
    if (stats) {
      const block = containerEl.createEl("div", { cls: "cortex-stats-block" });
      block.setAttr(
        "style",
        "padding: 8px 12px; margin-bottom: 12px; border-left: 3px solid var(--text-accent); background: var(--background-secondary); font-size: 0.85em; line-height: 1.6;",
      );
      const date = new Date(stats.builtAt).toISOString().slice(0, 19).replace("T", " ");
      const top = stats.topGodNodes
        .slice(0, 5)
        .map((g) => `${g.id} (${(g.combined * 100).toFixed(0)})`)
        .join(", ");
      block.createEl("div", {
        text: `📊 마지막 빌드: ${date} (${stats.durationMs}ms)`,
      });
      block.createEl("div", {
        text: `노드 ${stats.realNodeCount} 실 + ${stats.phantomNodeCount} phantom · 엣지 ${stats.edgeCount} · 클러스터 ${stats.clusterCount}`,
      });
      if (top) {
        block.createEl("div", { text: `🏛 Top god: ${top}` });
      }
    }

    // ── Ranking ─────────────────────────────────────
    containerEl.createEl("h3", { text: "추천 알고리즘" });

    new Setting(containerEl)
      .setName("Top K (표시할 후보 수)")
      .setDesc("사이드 패널에 표시할 최대 후보 개수")
      .addSlider((s) =>
        s
          .setLimits(3, 20, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.topK)
          .onChange(async (v) => {
            this.plugin.settings.topK = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("구조 점수 풀 크기")
      .setDesc("임베딩 재정렬 전 구조 점수로 선별할 후보 수")
      .addSlider((s) =>
        s
          .setLimits(20, 150, 10)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.structuralPoolSize)
          .onChange(async (v) => {
            this.plugin.settings.structuralPoolSize = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("구조 가중치 (vs 의미)")
      .setDesc(
        "최종 점수 = α · 구조 + (1-α) · 의미. 1.0 = 구조만, 0.0 = 의미만",
      )
      .addSlider((s) =>
        s
          .setLimits(0, 1, 0.05)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.structuralWeight)
          .onChange(async (v) => {
            this.plugin.settings.structuralWeight = v;
            this.plugin.settings.semanticWeight = 1 - v;
            await this.plugin.saveSettings();
          }),
      );

    // ── Auto trigger ────────────────────────────────
    containerEl.createEl("h3", { text: "자동 추천 트리거" });

    new Setting(containerEl)
      .setName("자동 계산 활성화")
      .setDesc("지정 폴더의 노트를 열면 자동으로 추천 계산")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.autoTrigger)
          .onChange(async (v) => {
            this.plugin.settings.autoTrigger = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("자동 트리거 대상 폴더")
      .setDesc("이 경로로 시작하는 파일만 자동 계산")
      .addText((t) =>
        t
          .setPlaceholder("2 Permanent/")
          .setValue(this.plugin.settings.autoTriggerFolder)
          .onChange(async (v) => {
            this.plugin.settings.autoTriggerFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("디바운스 (ms)")
      .setDesc("파일 전환 후 계산까지 대기 시간")
      .addSlider((s) =>
        s
          .setLimits(100, 2000, 50)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.autoTriggerDebounceMs)
          .onChange(async (v) => {
            this.plugin.settings.autoTriggerDebounceMs = v;
            await this.plugin.saveSettings();
          }),
      );

    // ── Embedding ───────────────────────────────────
    containerEl.createEl("h3", { text: "의미 검색 (임베딩)" });

    new Setting(containerEl)
      .setName("임베딩 제공자")
      .setDesc(
        "OFF: 구조 점수만 사용. OLLAMA: 로컬 Ollama 서버로 claim 임베딩 계산 → 코사인 유사도로 재정렬",
      )
      .addDropdown((d) =>
        d
          .addOption("off", "OFF (구조 점수만)")
          .addOption("ollama", "Ollama (로컬)")
          .setValue(this.plugin.settings.embeddingProvider)
          .onChange(async (v) => {
            this.plugin.settings.embeddingProvider = v as "off" | "ollama";
            await this.plugin.saveSettings();
            this.display(); // re-render to show/hide ollama fields
          }),
      );

    if (this.plugin.settings.embeddingProvider === "ollama") {
      new Setting(containerEl)
        .setName("Ollama 엔드포인트")
        .addText((t) =>
          t
            .setPlaceholder("http://localhost:11434")
            .setValue(this.plugin.settings.ollamaEndpoint)
            .onChange(async (v) => {
              this.plugin.settings.ollamaEndpoint = v.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Ollama 임베딩 모델")
        .setDesc(
          "권장: nomic-embed-text (274MB, 경량) · bge-m3 (한국어 최적) · exaone3.5:2.4b (이미 설치돼 있다면)",
        )
        .addText((t) =>
          t
            .setPlaceholder("nomic-embed-text")
            .setValue(this.plugin.settings.ollamaModel)
            .onChange(async (v) => {
              this.plugin.settings.ollamaModel = v.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("임베딩 캐시")
        .setDesc(
          ".obsidian/plugins/cortex/state/embeddings.json (mtime 기반 증분 갱신)",
        )
        .addButton((b) =>
          b.setButtonText("캐시 초기화").onClick(async () => {
            await this.plugin.clearEmbeddingCache();
          }),
        )
        .addButton((b) =>
          b
            .setButtonText("연결 테스트")
            .setCta()
            .onClick(async () => {
              await this.plugin.testOllama();
            }),
        );
    }

    // ── Noise ───────────────────────────────────────
    containerEl.createEl("h3", { text: "노이즈 필터" });

    new Setting(containerEl)
      .setName("무시할 cluster/tag 값")
      .setDesc("쉼표 구분. 예: 미분류, unclassified, misc")
      .addText((t) =>
        t
          .setPlaceholder("미분류, unclassified")
          .setValue(this.plugin.settings.noiseValues.join(", "))
          .onChange(async (v) => {
            this.plugin.settings.noiseValues = v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );

    // ── Paths ────────────────────────────────────────
    containerEl.createEl("h3", { text: "경로 설정" });

    new Setting(containerEl)
      .setName("영구노트 폴더")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.permanentFolder)
          .onChange(async (v) => {
            this.plugin.settings.permanentFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("candidates.json 저장 경로")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.candidatesPath)
          .onChange(async (v) => {
            this.plugin.settings.candidatesPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("CLI 명령 템플릿")
      .setDesc("{path} 가 candidates.json 경로로 치환됩니다")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.cliCommandTemplate)
          .onChange(async (v) => {
            this.plugin.settings.cliCommandTemplate = v;
            await this.plugin.saveSettings();
          }),
      );
  }
}
