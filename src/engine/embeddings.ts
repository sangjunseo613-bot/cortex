import { App, Notice, TFile, normalizePath, requestUrl } from "obsidian";

export interface EmbeddingProviderConfig {
  provider: "off" | "ollama";
  ollamaEndpoint: string;
  ollamaModel: string;
}

interface CacheEntry {
  mtime: number;
  model: string;
  vector: number[];
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const CACHE_REL = ".obsidian/plugins/cortex/state/embeddings.json";

export class EmbeddingEngine {
  private cache: Map<string, CacheEntry> = new Map();
  private cacheLoaded = false;
  private cacheDirty = false;
  private inflight: Map<string, Promise<number[]>> = new Map();

  constructor(
    private app: App,
    private config: EmbeddingProviderConfig,
  ) {}

  updateConfig(config: EmbeddingProviderConfig): void {
    this.config = config;
  }

  isEnabled(): boolean {
    return this.config.provider !== "off";
  }

  // ─── Cache I/O ──────────────────────────────────────

  private async ensureCacheLoaded(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    try {
      const raw = await this.app.vault.adapter.read(normalizePath(CACHE_REL));
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version === 1 && parsed.entries) {
        for (const [k, v] of Object.entries(parsed.entries)) this.cache.set(k, v);
      }
    } catch {
      // No cache file yet — that's fine.
    }
  }

  async flushCache(): Promise<void> {
    if (!this.cacheDirty) return;
    const entries: Record<string, CacheEntry> = {};
    for (const [k, v] of this.cache) entries[k] = v;
    const payload: CacheFile = { version: 1, entries };
    const path = normalizePath(CACHE_REL);
    const dir = path.substring(0, path.lastIndexOf("/"));
    try {
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(path, JSON.stringify(payload));
      this.cacheDirty = false;
    } catch (err) {
      console.error("[cortex] cache flush failed:", err);
    }
  }

  async clearCache(): Promise<void> {
    this.cache.clear();
    this.cacheDirty = false;
    try {
      const path = normalizePath(CACHE_REL);
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
      }
    } catch (err) {
      console.warn("[cortex] cache clear failed:", err);
    }
  }

  // ─── Embedding API ──────────────────────────────────

  /** Last error message captured by `embed()` — useful for UI to explain
   *  why a fallback happened. Cleared on successful embed. */
  lastError: string | null = null;

  /** Returns `null` if disabled or provider unreachable. */
  async embed(text: string): Promise<number[] | null> {
    if (!this.isEnabled()) return null;
    const clean = text.trim();
    if (!clean) return null;
    try {
      const vec = await this.ollamaEmbed(clean);
      this.lastError = null;
      return vec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      console.warn("[cortex] embed failed:", msg);
      return null;
    }
  }

  private async ollamaEmbed(text: string): Promise<number[]> {
    const url = `${this.config.ollamaEndpoint.replace(/\/+$/, "")}/api/embeddings`;
    let res;
    try {
      res = await requestUrl({
        url,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ model: this.config.ollamaModel, prompt: text }),
        throw: false,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Ollama 서버 연결 실패 (${this.config.ollamaEndpoint}). 'ollama serve' 실행 중인지 확인. [${m}]`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      const body = res.text?.slice(0, 200) ?? "";
      if (res.status === 404 || body.includes("not found")) {
        throw new Error(
          `Ollama 모델 "${this.config.ollamaModel}" 없음. 'ollama pull ${this.config.ollamaModel}' 실행하거나 설정에서 다른 모델로 변경.`,
        );
      }
      throw new Error(`Ollama ${res.status}: ${body}`);
    }
    const data = res.json as { embedding?: number[] };
    if (!data.embedding || !Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error(
        `Ollama 응답에 embedding 필드 없음 (모델 ${this.config.ollamaModel}이 임베딩을 지원하는지 확인).`,
      );
    }
    return data.embedding;
  }

  /** Test connectivity. Returns embedding dim on success, throws on failure. */
  async testConnection(): Promise<number> {
    const v = await this.ollamaEmbed("connection test");
    return v.length;
  }

  // ─── Cached note embedding ──────────────────────────

  /**
   * Get (or compute) the embedding for a note, keyed by noteId.
   * Uses file mtime for cache invalidation. Returns null if disabled or
   * if the embedding provider fails.
   */
  async embedNote(
    noteId: string,
    claim: string,
    file: TFile | null,
  ): Promise<number[] | null> {
    if (!this.isEnabled()) return null;
    await this.ensureCacheLoaded();

    const mtime = file?.stat?.mtime ?? 0;
    const cached = this.cache.get(noteId);
    if (
      cached &&
      cached.model === this.config.ollamaModel &&
      cached.mtime === mtime &&
      cached.vector.length > 0
    ) {
      return cached.vector;
    }

    // Deduplicate in-flight requests for the same id
    const existing = this.inflight.get(noteId);
    if (existing) return existing;

    const promise = (async () => {
      const vec = await this.embed(claim);
      if (vec) {
        this.cache.set(noteId, {
          mtime,
          model: this.config.ollamaModel,
          vector: vec,
        });
        this.cacheDirty = true;
      }
      return vec;
    })();
    this.inflight.set(noteId, promise as Promise<number[]>);
    try {
      return await promise;
    } finally {
      this.inflight.delete(noteId);
    }
  }

  /** Batched embed: computes in parallel with a concurrency cap. */
  async embedMany(
    items: Array<{ id: string; claim: string; file: TFile | null }>,
    concurrency = 4,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!this.isEnabled() || items.length === 0) return out;
    await this.ensureCacheLoaded();

    let done = 0;
    let idx = 0;
    const total = items.length;

    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < total) {
        const my = idx++;
        const it = items[my];
        try {
          const v = await this.embedNote(it.id, it.claim, it.file);
          if (v) out.set(it.id, v);
        } catch {
          // swallow; continue
        }
        done++;
        onProgress?.(done, total);
      }
    });
    await Promise.all(workers);
    await this.flushCache();
    return out;
  }
}

/** Cosine similarity, returns 0 when either vector is empty. */
export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** One-shot helper to show a progress Notice during batch embedding. */
export function progressNotice(prefix: string) {
  const n = new Notice(prefix, 0);
  return {
    update(done: number, total: number) {
      n.setMessage(`${prefix} ${done}/${total}`);
    },
    done(msg: string) {
      n.setMessage(msg);
      setTimeout(() => n.hide(), 3000);
    },
  };
}
