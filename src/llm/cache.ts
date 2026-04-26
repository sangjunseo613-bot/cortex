import { App, normalizePath } from "obsidian";

/**
 * LLM result cache — hash-keyed JSON store.
 *
 * Keying: `${task}::${stableJSONOf(input)}` → SHA-256 → hex.
 * The cache survives between sessions (`state/discovery-cache.json`) so
 * re-running discovery on the same graph doesn't re-hit Codex needlessly.
 *
 * Invalidation: cache is keyed on the structural input (cluster member ids,
 * tags). When the graph rebuilds and any of those change, the key changes
 * naturally and we re-call Codex. There is also a manual "캐시 초기화" button.
 *
 * TTL: entries older than 14 days are evicted on load.
 */

const CACHE_PATH = ".obsidian/plugins/cortex/state/discovery-cache.json";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface CacheEntry<T = unknown> {
  generatedAt: number;
  value: T;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export class DiscoveryCache {
  private map = new Map<string, CacheEntry>();
  private loaded = false;
  private dirty = false;

  constructor(private app: App) {}

  static path(): string {
    return normalizePath(CACHE_PATH);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const path = DiscoveryCache.path();
    try {
      const raw = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== 1 || !parsed.entries) return;
      const now = Date.now();
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (now - v.generatedAt > TTL_MS) continue; // TTL eviction
        this.map.set(k, v);
      }
    } catch {
      // No cache file — fresh slate.
    }
  }

  async get<T>(task: string, input: unknown): Promise<T | null> {
    await this.ensureLoaded();
    const key = stableKey(task, input);
    const entry = this.map.get(key);
    if (!entry) return null;
    return entry.value as T;
  }

  async set<T>(task: string, input: unknown, value: T): Promise<void> {
    await this.ensureLoaded();
    const key = stableKey(task, input);
    this.map.set(key, { generatedAt: Date.now(), value });
    this.dirty = true;
  }

  /** Persist to disk if anything changed. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const path = DiscoveryCache.path();
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir && !(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    const entries: Record<string, CacheEntry> = {};
    for (const [k, v] of this.map) entries[k] = v;
    const payload: CacheFile = { version: 1, entries };
    await this.app.vault.adapter.write(path, JSON.stringify(payload));
    this.dirty = false;
  }

  async clear(): Promise<void> {
    this.map.clear();
    this.dirty = false;
    const path = DiscoveryCache.path();
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }

  size(): number {
    return this.map.size;
  }
}

/**
 * Build a deterministic cache key. Stringifying with sorted keys gives us
 * structural stability — two semantically-equal inputs produce identical hashes.
 */
function stableKey(task: string, input: unknown): string {
  return `${task}::${stableStringify(input)}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",") +
    "}"
  );
}
