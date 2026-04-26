import { App, normalizePath } from "obsidian";
import {
  DiagnosticSnapshot,
  DriftSignal,
  DriftSeverity,
  GraphStats,
  DiscoveryResult,
} from "../types";

/**
 * Diagnostics — periodic snapshots of vault structure + drift detection.
 *
 * One snapshot per week. Stored as JSON under
 * `.obsidian/plugins/cortex/state/diagnostics/<weekKey>.json`. Drift signals
 * compare the latest snapshot against the previous one.
 *
 * Quarter comparison: aggregates 12-13 weekly snapshots into one
 * `<quarterKey>.json` summary so multi-month drift is easy to spot.
 *
 * Why JSON files instead of one big file: easier to inspect by hand, easier
 * to delete a single bad snapshot, naturally namespaced by week/quarter.
 */

const DIAGNOSTICS_DIR = ".obsidian/plugins/cortex/state/diagnostics";
const AUDIT_LOG_PATH = ".obsidian/plugins/cortex/state/audit-log.ndjson";

// ─── Snapshot create / persist ────────────────────────

export interface BuildSnapshotInput {
  /** Latest GraphStats from buildGraph() */
  graphStats: GraphStats;
  /** Latest DiscoveryResult (for diagnostic stage + cluster labels) */
  discovery: DiscoveryResult;
  /** Previous snapshot's ts, used to compute audit delta. Pass 0 for none. */
  previousSnapshotTs: number;
}

export async function buildSnapshot(
  app: App,
  input: BuildSnapshotInput,
): Promise<DiagnosticSnapshot> {
  const now = new Date();
  const ts = now.getTime();

  const auditDelta = await computeAuditDelta(app, input.previousSnapshotTs, ts);

  return {
    ts,
    date: isoDate(now),
    weekKey: isoWeekKey(now),
    quarterKey: quarterKey(now),
    graphStats: {
      realNodes: input.graphStats.realNodeCount,
      edges: input.graphStats.edgeCount,
      clusters: input.graphStats.clusterCount,
    },
    godNodes: input.graphStats.topGodNodes.slice(0, 10).map((g) => g.id),
    clusterLabels: Object.values(input.discovery.clusterLabels)
      .sort((a, b) => a.clusterId - b.clusterId)
      .slice(0, 10)
      .map((c) => c.label),
    diagnostic: input.discovery.diagnostic,
    auditDelta,
  };
}

export async function saveSnapshot(app: App, snapshot: DiagnosticSnapshot): Promise<string> {
  await ensureDir(app, DIAGNOSTICS_DIR);
  const path = normalizePath(`${DIAGNOSTICS_DIR}/${snapshot.weekKey}.json`);
  await app.vault.adapter.write(path, JSON.stringify(snapshot, null, 2));
  return path;
}

// ─── Read snapshots ───────────────────────────────────

export async function listSnapshots(app: App): Promise<DiagnosticSnapshot[]> {
  const dir = normalizePath(DIAGNOSTICS_DIR);
  if (!(await app.vault.adapter.exists(dir))) return [];
  const list = await app.vault.adapter.list(dir);
  const out: DiagnosticSnapshot[] = [];
  for (const f of list.files) {
    if (!f.endsWith(".json")) continue;
    // Skip quarter aggregates (they have a different filename pattern Q1, Q2, ...)
    if (/-Q\d\.json$/i.test(f)) continue;
    try {
      const raw = await app.vault.adapter.read(f);
      out.push(JSON.parse(raw) as DiagnosticSnapshot);
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export async function latestSnapshot(app: App): Promise<DiagnosticSnapshot | null> {
  const all = await listSnapshots(app);
  return all.length > 0 ? all[all.length - 1] : null;
}

// ─── Drift comparison ─────────────────────────────────

export function compareSnapshots(
  current: DiagnosticSnapshot,
  previous: DiagnosticSnapshot,
): DriftSignal {
  const reasons: string[] = [];

  // God-node Jaccard distance
  const a = new Set(current.godNodes);
  const b = new Set(previous.godNodes);
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  const godNodeDrift = union === 0 ? 0 : 1 - inter / union;
  if (godNodeDrift >= 0.3) {
    reasons.push(
      `God nodes 변동률 ${(godNodeDrift * 100).toFixed(0)}% — 정체성 코어 흔들림.`,
    );
  }

  // Cluster label drift (positional)
  const labelChanges = Math.max(current.clusterLabels.length, previous.clusterLabels.length);
  let changed = 0;
  for (let i = 0; i < labelChanges; i++) {
    if (current.clusterLabels[i] !== previous.clusterLabels[i]) changed++;
  }
  const clusterDrift = labelChanges === 0 ? 0 : changed / labelChanges;
  if (clusterDrift >= 0.4) {
    reasons.push(`클러스터 라벨 ${changed}/${labelChanges} 변경.`);
  }

  // Stage change
  const stageChanged = current.diagnostic.stage !== previous.diagnostic.stage;
  if (stageChanged) {
    reasons.push(
      `진단 단계 ${previous.diagnostic.stage} → ${current.diagnostic.stage}.`,
    );
  }

  // Severity policy — conservative, errs toward "low" rather than spamming.
  let severity: DriftSeverity = "none";
  if (godNodeDrift >= 0.6 || clusterDrift >= 0.6) severity = "high";
  else if (godNodeDrift >= 0.4 || clusterDrift >= 0.4 || stageChanged) severity = "medium";
  else if (godNodeDrift >= 0.2 || clusterDrift >= 0.2) severity = "low";

  return {
    ts: current.ts,
    comparedToTs: previous.ts,
    godNodeDrift,
    clusterDrift,
    stageChanged,
    oldStage: previous.diagnostic.stage,
    newStage: current.diagnostic.stage,
    severity,
    reasons,
  };
}

// ─── Markdown report ──────────────────────────────────

export function renderDriftReport(
  current: DiagnosticSnapshot,
  previous: DiagnosticSnapshot | null,
  signal: DriftSignal | null,
): string {
  const lines: string[] = [];
  lines.push(`# Cortex Diagnostic Report — ${current.weekKey}\n\n`);
  lines.push(`> Snapshot: ${current.date} (${current.weekKey} · ${current.quarterKey})\n\n`);

  lines.push(`## 그래프 상태\n\n`);
  lines.push(
    `- 실 노드: **${current.graphStats.realNodes}** · 엣지: **${current.graphStats.edges}** · 클러스터: **${current.graphStats.clusters}**\n`,
  );
  lines.push(
    `- 진단: **${current.diagnostic.stage}** — ${current.diagnostic.reason}\n\n`,
  );

  lines.push(`## God Nodes (Top ${current.godNodes.length})\n\n`);
  for (const id of current.godNodes) lines.push(`- \`${id}\`\n`);
  lines.push("\n");

  lines.push(`## 클러스터 라벨\n\n`);
  for (const l of current.clusterLabels) lines.push(`- ${l}\n`);
  lines.push("\n");

  lines.push(`## Audit 활동 (이전 스냅샷 이후)\n\n`);
  lines.push(`- compile: ${current.auditDelta.compiles}\n`);
  lines.push(`- approve: ${current.auditDelta.approves}\n`);
  lines.push(`- reject: ${current.auditDelta.rejects}\n\n`);

  if (previous && signal) {
    const sevLabel: Record<DriftSeverity, string> = {
      none: "✅ 변동 없음",
      low: "🟢 경미",
      medium: "🟡 중간",
      high: "🔴 높음",
    };
    lines.push(`## Drift (vs ${previous.weekKey})\n\n`);
    lines.push(`- 심각도: **${sevLabel[signal.severity]}**\n`);
    lines.push(`- God-node Jaccard distance: ${(signal.godNodeDrift * 100).toFixed(0)}%\n`);
    lines.push(`- 클러스터 라벨 변화율: ${(signal.clusterDrift * 100).toFixed(0)}%\n`);
    lines.push(
      `- 단계 변화: ${signal.stageChanged ? `${signal.oldStage} → ${signal.newStage}` : "유지"}\n`,
    );
    if (signal.reasons.length > 0) {
      lines.push("\n### 사유\n\n");
      for (const r of signal.reasons) lines.push(`- ${r}\n`);
    }
    lines.push("\n");
  } else {
    lines.push(`## Drift\n\n비교 가능한 이전 스냅샷이 없습니다 (이번이 최초).\n\n`);
  }

  return lines.join("");
}

// ─── helpers ──────────────────────────────────────────

async function computeAuditDelta(
  app: App,
  fromTs: number,
  toTs: number,
): Promise<DiagnosticSnapshot["auditDelta"]> {
  const out = { compiles: 0, approves: 0, rejects: 0 };
  const path = normalizePath(AUDIT_LOG_PATH);
  if (!(await app.vault.adapter.exists(path))) return out;
  let raw = "";
  try {
    raw = await app.vault.adapter.read(path);
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { ts: number; action: string };
      if (e.ts <= fromTs || e.ts > toTs) continue;
      if (e.action === "compile") out.compiles++;
      else if (e.action === "approve") out.approves++;
      else if (e.action === "reject") out.rejects++;
    } catch {
      // skip bad line
    }
  }
  return out;
}

async function ensureDir(app: App, dir: string): Promise<void> {
  const path = normalizePath(dir);
  const segments = path.split("/").filter(Boolean);
  let cur = "";
  for (const seg of segments) {
    cur = cur ? `${cur}/${seg}` : seg;
    if (!(await app.vault.adapter.exists(cur))) {
      await app.vault.adapter.mkdir(cur);
    }
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function quarterKey(d: Date): string {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

/** ISO 8601 week numbering (1..53). */
function isoWeekKey(d: Date): string {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = target.getTime();
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  let yearStartDay = yearStart.getUTCDay();
  if (yearStartDay !== 4) {
    yearStart.setUTCMonth(0, 1 + ((4 - yearStartDay + 7) % 7));
  }
  const week = 1 + Math.floor((firstThursday - yearStart.getTime()) / 604_800_000);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
