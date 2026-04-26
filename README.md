# Cortex — Second Brain for Obsidian

> Phase 0 (Foundation) — `Zettel Connect`를 fork한 직후 상태. 추천 패널만 동작.
> Phase 1 부터 Schema · Identity · Graph Core · Discovery · Compile · Lint 추가 예정.

## 정체성 (왜 Cortex인가)

- **외부 도구 다운로드 없이** 형님 vault에 직접 통합되는 단일 옵시디언 플러그인
- **5개 도구의 정수**를 종합:
  - LLM Wiki (Karpathy) — raw / wiki / schema 패턴
  - SwarmVault — provenance edges, approval queue, save-first
  - Zettel Connect Starter — 4-Way 구조점수 + 의미점수 하이브리드 (출발점)
  - Graphify — god nodes, surprising connections, confidence labels
  - InfraNodus — content gap detection, biased/focused/diversified/dispersed 진단
- **정체성 보존**: schema = 필터-깔때기, god nodes = vault의 목소리, approval queue = silent mutation 차단

## v0.0.1 (Phase 0) 현재 동작

| 영역 | 구현 |
|------|------|
| **구조 점수** | 4-Way (1-hop / 2-hop / cluster / tag / cousin), 노이즈 필터 |
| **의미 점수** | Ollama 임베딩 + 코사인 유사도 (OFF 가능). v0.1에서는 Codex 분석으로 대체 예정 |
| **하이브리드** | `α · structural + (1-α) · semantic`, α 슬라이더 조절 |
| **자동 트리거** | 지정 폴더 파일 열면 debounce 후 자동 계산 |
| **링크 삽입** | 커서 위치에 `[[파일명]]` + frontmatter `links[]` 자동 추가 |
| **CLI 핸드오프** | `connect-candidates.json` 저장 + 클립보드 복사 + Terminal 오픈 (Claude Code) |

> Phase 3에서 Claude Code 핸드오프 → Codex CLI 핸드오프로 전환 예정.

## 빌드

```bash
cd <your-vault>/.obsidian/plugins/cortex
npm install
npm run build        # production
npm run dev          # watch
```

빌드 후 옵시디언에서 `Settings → 커뮤니티 플러그인 → Cortex` 토글 ON.

## 디렉토리

```
.obsidian/plugins/cortex/
├── manifest.json
├── main.js                       # esbuild 산출물
├── styles.css
├── src/
│   ├── main.ts                   # 엔트리
│   ├── settings.ts
│   ├── types.ts
│   ├── engine/
│   │   ├── index-reader.ts       # VAULT_INDEX/GRAPH 파싱
│   │   ├── structural-score.ts   # 4-Way 구조 점수
│   │   ├── embeddings.ts         # Ollama + mtime 캐시 (v0.1에서 Codex 분석으로 대체 예정)
│   │   └── hybrid-ranker.ts
│   ├── view/
│   │   └── ConnectionPanel.ts
│   └── actions/
│       ├── save-candidates.ts
│       └── run-claude.ts         # Phase 3에서 codex-bridge.ts로 교체 예정
└── state/                        # 런타임 생성: graph.json / god-nodes.json / candidates.json / embeddings.json
```

## 로드맵 (전체 플랜에서)

- [x] **Phase 0** — Foundation: Fork + rebrand + 빌드
- [ ] **Phase 1** — Schema + Identity (`cortex.schema.md`, `IDENTITY.md`)
- [ ] **Phase 2** — Graph Core (Louvain, PageRank, god nodes 자동 추출)
- [ ] **Phase 3** — Discovery + Codex 통합 (gap, bridge, latent topic)
- [ ] **Phase 4** — Compile Pipeline (raw → wiki/concepts, approval queue)
- [ ] **Phase 5** — Lint + Drift (orphan, 끊긴 링크, 분기 비교)
- [ ] **Phase 6** — UI 통합 (4 패널 + 명령 + 핫키)
- [ ] **Phase 7** — 옵션 확장 (MCP 서버, 영상 가이드 등)

## 제한사항 (Phase 0)

- isDesktopOnly — 모바일 미지원
- VAULT_INDEX 의존: `_index/VAULT_INDEX.md`, `GRAPH.md` 필요
- 읽기 전용: VAULT_INDEX 직접 갱신은 cascade에 위임
- 중복 ID는 경고만, 자동 수정 없음
