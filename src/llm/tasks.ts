import { codexCall, vaultBasePath } from "./codex-bridge";
import { ClusterLabel, GapPair } from "../types";
import { App } from "obsidian";

/**
 * LLM task layer — prompt assembly + JSON Schema enforcement + result parsing.
 *
 * Three task types share the same plumbing:
 *   - topic-namer: cluster summary → human-readable Korean label
 *   - question-gen: gap pair → 3-5 research questions
 *   - latent-topic: cluster summary → 3-5 missing subtopics
 *
 * All tasks pass `--output-schema schema.json` to codex so the response is
 * forced into the exact shape we parse. Failures fall back to placeholder
 * values so structural results remain usable.
 */

// ─── JSON Schemas ─────────────────────────────────────────

const TOPIC_LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "confidence"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 80 },
    confidence: { type: "integer", minimum: 0, maximum: 2 },
  },
};

const QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 8, maxLength: 240 },
    },
  },
};

const LATENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["missing_subtopics"],
  properties: {
    missing_subtopics: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 4, maxLength: 120 },
    },
  },
};

// ─── Task: topic-name ─────────────────────────────────────

export interface ClusterContext {
  clusterId: number;
  members: Array<{ id: string; claim: string; tags: string[] }>;
  topTags: string[];
}

export async function nameCluster(
  app: App,
  ctx: ClusterContext,
  timeoutMs = 45_000,
): Promise<ClusterLabel> {
  const prompt = topicNamerPrompt(ctx);
  try {
    const result = await codexCall({
      cwd: vaultBasePath(app) ?? process.cwd(),
      prompt,
      outputSchema: TOPIC_LABEL_SCHEMA,
      timeoutMs,
    });
    const parsed = safeParseJson(result.lastMessage) as
      | { label?: string; confidence?: number }
      | null;
    if (!parsed || typeof parsed.label !== "string") {
      return fallbackLabel(ctx);
    }
    const conf = clamp012(parsed.confidence ?? 0);
    return {
      clusterId: ctx.clusterId,
      label: parsed.label.trim().slice(0, 80),
      confidence: conf,
    };
  } catch (err) {
    console.warn(`[cortex] nameCluster failed for C${ctx.clusterId}:`, err);
    return fallbackLabel(ctx);
  }
}

function topicNamerPrompt(ctx: ClusterContext): string {
  const memberLines = ctx.members
    .slice(0, 12)
    .map((m) => {
      const tagStr = m.tags.length > 0 ? ` [${m.tags.slice(0, 4).join(", ")}]` : "";
      return `- ${m.id}: ${m.claim}${tagStr}`;
    })
    .join("\n");
  const tags = ctx.topTags.length > 0 ? ctx.topTags.join(", ") : "(없음)";

  return `당신은 한국어 Zettelkasten "second brain" vault의 클러스터에 이름을 붙이는 보조자입니다.

다음은 동일 클러스터에 속한 노트들입니다:
${memberLines}

상위 태그: ${tags}

작업: 이 클러스터의 핵심을 포착하는 **한국어 라벨**을 정확히 하나 출력하세요.
- 3~7 단어 (또는 한 어구)
- 사용자의 어휘를 그대로 사용 (위 노트들의 표현)
- 일반론 금지 ("지식 관리" X), 구체성 ("제텔카스텐 도구 비교" O)
- 영어/외국어 금지 (고유명사 제외)

JSON 스키마를 정확히 따르는 한 줄을 출력하세요:
{"label": "<한국어 라벨>", "confidence": <0|1|2>}
- confidence: 0=추측 / 1=그럴듯함 / 2=명확

추가 설명 없이 JSON만 출력하세요.`;
}

function fallbackLabel(ctx: ClusterContext): ClusterLabel {
  const fallback = ctx.topTags[0] ?? `C${ctx.clusterId}`;
  return {
    clusterId: ctx.clusterId,
    label: fallback,
    confidence: 0,
  };
}

// ─── Task: question generation ─────────────────────────────

export async function generateQuestions(
  app: App,
  gap: GapPair,
  timeoutMs = 60_000,
): Promise<string[]> {
  const prompt = questionsPrompt(gap);
  try {
    const result = await codexCall({
      cwd: vaultBasePath(app) ?? process.cwd(),
      prompt,
      outputSchema: QUESTIONS_SCHEMA,
      timeoutMs,
    });
    const parsed = safeParseJson(result.lastMessage) as
      | { questions?: string[] }
      | null;
    if (!parsed || !Array.isArray(parsed.questions)) return [];
    return parsed.questions
      .map((q) => String(q).trim())
      .filter((q) => q.length >= 8 && q.length <= 240)
      .slice(0, 5);
  } catch (err) {
    console.warn(
      `[cortex] generateQuestions failed for ${gap.clusterA}-${gap.clusterB}:`,
      err,
    );
    return [];
  }
}

function questionsPrompt(gap: GapPair): string {
  const sampleA = gap.sampleA
    .slice(0, 5)
    .map((m) => `- ${m.id}: ${m.claim}`)
    .join("\n");
  const sampleB = gap.sampleB
    .slice(0, 5)
    .map((m) => `- ${m.id}: ${m.claim}`)
    .join("\n");
  const sharedTags =
    gap.sharedTags.length > 0 ? gap.sharedTags.slice(0, 6).join(", ") : "(없음)";

  return `당신은 한국어 Zettelkasten의 두 클러스터 사이 **structural hole**을 메울 리서치 질문을 만드는 보조자입니다.

두 클러스터는 토픽 겹침이 있지만 서로 직접 연결된 노트가 거의 없습니다.

[클러스터 A: "${gap.labelA}"]
${sampleA}

[클러스터 B: "${gap.labelB}"]
${sampleB}

공유 태그: ${sharedTags}
A↔B 간 직접 연결 엣지 수: ${gap.interEdges}

작업: A와 B를 잇는 다리를 만들 **구체적인 한국어 리서치 질문 3~5개**를 생성하세요.
- 일반론 금지 ("두 분야는 어떻게 연결되나?" X)
- 각 질문은 위에 적힌 구체적 노트나 표현을 직접 언급해야 함
- 질문에 답하려면 두 클러스터의 지식이 모두 필요해야 함
- 한 줄 한 질문, 물음표로 끝맺음

JSON 스키마를 정확히 따라 출력:
{"questions": ["<질문1>", "<질문2>", "<질문3>", ...]}

추가 설명 없이 JSON만.`;
}

// ─── Task: latent topic ───────────────────────────────────

export async function suggestLatentTopics(
  app: App,
  ctx: ClusterContext & { label: string },
  timeoutMs = 45_000,
): Promise<string[]> {
  const prompt = latentPrompt(ctx);
  try {
    const result = await codexCall({
      cwd: vaultBasePath(app) ?? process.cwd(),
      prompt,
      outputSchema: LATENT_SCHEMA,
      timeoutMs,
    });
    const parsed = safeParseJson(result.lastMessage) as
      | { missing_subtopics?: string[] }
      | null;
    if (!parsed || !Array.isArray(parsed.missing_subtopics)) return [];
    return parsed.missing_subtopics
      .map((s) => String(s).trim())
      .filter((s) => s.length >= 4 && s.length <= 120)
      .slice(0, 5);
  } catch (err) {
    console.warn(
      `[cortex] suggestLatentTopics failed for C${ctx.clusterId}:`,
      err,
    );
    return [];
  }
}

function latentPrompt(ctx: ClusterContext & { label: string }): string {
  const memberLines = ctx.members
    .slice(0, 10)
    .map((m) => `- ${m.id}: ${m.claim}`)
    .join("\n");
  const tags = ctx.topTags.length > 0 ? ctx.topTags.join(", ") : "(없음)";

  return `한국어 Zettelkasten의 한 클러스터를 분석합니다.

라벨: "${ctx.label}"
상위 태그: ${tags}
구성원:
${memberLines}

작업: 이 클러스터에 **아직 노트로 존재하지 않지만 자연스럽게 들어와야 할 하위 토픽 3~5개**를 제안하세요.
- 클러스터의 어휘를 사용 (위 표현 그대로)
- 너무 일반적이지 않게 — 사용자가 실제로 작성하기 쉬운 단위
- 영어/외국어 금지 (고유명사 제외)

JSON 스키마:
{"missing_subtopics": ["<하위토픽1>", ...]}

JSON만 출력.`;
}

// ─── helpers ──────────────────────────────────────────────

function safeParseJson(s: string): unknown {
  if (!s) return null;
  // Strip code fences if the model added them despite instructions.
  let cleaned = s.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting the first {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clamp012(n: number): 0 | 1 | 2 {
  if (n <= 0) return 0;
  if (n >= 2) return 2;
  return 1;
}
