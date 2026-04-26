import { App } from "obsidian";
import { codexCall, vaultBasePath } from "./codex-bridge";
import { CompiledConcept, CompiledEntity } from "../types";

/**
 * Compile-task prompts.
 *
 * One Codex call per source note. The model returns:
 *   - 3-7 concepts (one-sentence claims with supporting excerpts)
 *   - 0-N entities (people, organizations, products, places)
 *
 * JSON Schema enforces shape. Provenance/confidence labels are applied so
 * downstream code can color-flag uncertain extractions in the Review UI.
 */

// ─── JSON Schema ──────────────────────────────────────────

const COMPILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["concepts", "entities"],
  properties: {
    concepts: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "tags", "excerpt", "confidence", "provenance"],
        properties: {
          claim: { type: "string", minLength: 8, maxLength: 220 },
          tags: {
            type: "array",
            minItems: 0,
            maxItems: 6,
            items: { type: "string", minLength: 1, maxLength: 32 },
          },
          excerpt: { type: "string", minLength: 4, maxLength: 600 },
          confidence: { type: "integer", minimum: 0, maximum: 2 },
          provenance: {
            type: "string",
            enum: ["extracted", "inferred", "ambiguous"],
          },
        },
      },
    },
    entities: {
      type: "array",
      minItems: 0,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "mentions", "confidence", "provenance"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80 },
          type: {
            type: "string",
            enum: ["person", "organization", "product", "place", "concept", "other"],
          },
          mentions: {
            type: "array",
            minItems: 0,
            maxItems: 3,
            items: { type: "string", minLength: 1, maxLength: 240 },
          },
          confidence: { type: "integer", minimum: 0, maximum: 2 },
          provenance: {
            type: "string",
            enum: ["extracted", "inferred", "ambiguous"],
          },
        },
      },
    },
  },
};

export interface CompileTaskInput {
  /** Vault-relative source path */
  source: string;
  /** Source title (frontmatter title or basename) */
  title: string;
  /** Source body, possibly truncated */
  body: string;
  /** Existing tags from source frontmatter */
  inheritedTags: string[];
}

export interface CompileTaskOutput {
  concepts: CompiledConcept[];
  entities: CompiledEntity[];
}

/**
 * Run one compile pass via Codex. Returns parsed concepts/entities or
 * throws — caller is responsible for fallback behavior.
 */
export async function compileNote(
  app: App,
  input: CompileTaskInput,
  timeoutMs = 120_000,
): Promise<CompileTaskOutput> {
  const prompt = compilePrompt(input);
  const result = await codexCall({
    cwd: vaultBasePath(app) ?? process.cwd(),
    prompt,
    outputSchema: COMPILE_SCHEMA,
    timeoutMs,
  });

  const parsed = safeParseJson(result.lastMessage) as
    | {
        concepts?: Array<{
          claim: string;
          tags: string[];
          excerpt: string;
          confidence: number;
          provenance: string;
        }>;
        entities?: Array<{
          name: string;
          type: string;
          mentions: string[];
          confidence: number;
          provenance: string;
        }>;
      }
    | null;

  if (!parsed || !Array.isArray(parsed.concepts)) {
    throw new Error("Codex 응답이 예상 JSON 형식과 맞지 않습니다.");
  }

  const concepts: CompiledConcept[] = parsed.concepts.map((c, idx) => ({
    slug: slugify(c.claim, idx),
    claim: c.claim.trim(),
    tags: dedupeTags([...input.inheritedTags, ...(c.tags ?? [])]),
    excerpt: c.excerpt.trim(),
    confidence: clamp012(c.confidence ?? 0),
    provenance: clampProvenance(c.provenance),
  }));

  const entities: CompiledEntity[] = (parsed.entities ?? []).map((e, idx) => ({
    slug: slugify(e.name, idx),
    name: e.name.trim(),
    type: clampEntityType(e.type),
    mentions: (e.mentions ?? []).map((m) => m.trim()).filter(Boolean).slice(0, 3),
    confidence: clamp012(e.confidence ?? 0),
    provenance: clampProvenance(e.provenance),
  }));

  return { concepts, entities };
}

// ─── Prompt ───────────────────────────────────────────────

function compilePrompt(input: CompileTaskInput): string {
  const tagStr = input.inheritedTags.length > 0 ? input.inheritedTags.join(", ") : "(없음)";

  return `당신은 한국어 Zettelkasten "second brain"의 컴파일러입니다.
원본 노트(raw)에서 **재사용 가능한 영구 단위(컨셉)와 엔티티**를 추출합니다.

# 입력

source: ${input.source}
title: ${input.title}
inherited_tags: ${tagStr}

--- BODY ---
${input.body}
--- END ---

# 작업

## A. 컨셉 추출 (concepts)
원본에서 **3~8개의 단일-문장 명제(claim)**를 뽑으세요. 각 컨셉은:
- claim: 한 문장의 명제, 한국어, 8~220자 (어조: 명제형, "~다.")
- tags: 컨셉을 분류할 태그 0~6개 (소문자, 한글/영문/하이픈만)
- excerpt: 원본에서 그대로 가져온 근거 발췌 (4~600자)
- confidence: 0(추측) | 1(그럴듯) | 2(명확)
- provenance:
  - "extracted" = 원본에 명시적으로 적힌 내용
  - "inferred" = 원본에서 자연스럽게 도출되지만 직접 명시되진 않음
  - "ambiguous" = 해석에 따라 달라짐

## B. 엔티티 추출 (entities)
원본에서 언급된 **사람·조직·제품·장소·핵심개념** 0~10개를 뽑으세요. 각 엔티티는:
- name: 표기명 (예: "Andrej Karpathy", "InfraNodus", "MCP")
- type: "person" | "organization" | "product" | "place" | "concept" | "other"
- mentions: 원본 발췌 0~3개
- confidence, provenance: 위와 동일

# 규칙

- 출력은 JSON Schema를 정확히 따라야 함 (코드펜스/설명 추가 금지)
- 컨셉의 claim은 vault에 그대로 저장될 영구노트의 본문 — 명료하고 인용 가능해야 함
- 일반론 금지: "이것은 중요하다" X / "Karpathy의 LLM Wiki는 raw→wiki→schema 3계층 분리를 제안한다" O
- 영문/외국어 금지 (고유명사 제외)
- inherited_tags는 받은 그대로 활용 가능 (선택)

JSON만 출력:`;
}

// ─── helpers ──────────────────────────────────────────────

function safeParseJson(s: string): unknown {
  if (!s) return null;
  let cleaned = s.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  }
  try {
    return JSON.parse(cleaned);
  } catch {
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

function clampProvenance(p: string): "extracted" | "inferred" | "ambiguous" {
  if (p === "inferred" || p === "ambiguous") return p;
  return "extracted";
}

function clampEntityType(t: string): CompiledEntity["type"] {
  const allowed = ["person", "organization", "product", "place", "concept", "other"];
  return (allowed.includes(t) ? t : "other") as CompiledEntity["type"];
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.trim().toLowerCase().replace(/^#/, "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.slice(0, 8);
}

/**
 * Slugify a Korean+English string for filename use.
 * - Lowercases ASCII
 * - Replaces whitespace and punctuation with hyphens
 * - Preserves hangul (renders fine in filenames)
 * - Falls back to a stable index suffix if collision-prone
 */
export function slugify(s: string, fallbackIndex = 0): string {
  let slug = s
    .trim()
    .toLowerCase()
    .replace(/[\s ]+/g, "-")
    .replace(/[!@#$%^&*()_+={}\[\]|\\:;"'<>,.?/`~·…—–]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  if (!slug) slug = `concept-${fallbackIndex}`;
  // Append stable 6-char FNV-1a hash for collision resistance.
  // Original full claim is preserved in the candidate file's H1 heading,
  // so truncating the visible slug doesn't lose information.
  return `${slug}-${shortHash(s, 6)}`;
}

/** Tiny non-cryptographic hash (FNV-1a 32-bit) → base36 truncated. */
function shortHash(s: string, len = 6): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0).toString(36) + "000000").slice(0, len);
}
