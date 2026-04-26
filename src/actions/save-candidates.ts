import { App, Notice, normalizePath } from "obsidian";
import { Candidate, SeedInfo } from "../types";

const DEFAULT_CANDIDATES_PATH = "_index/connect-candidates.json";

export interface CandidatesPayload {
  version: 1;
  seed: {
    id: string;
    claim: string;
    cluster: string;
    tags: string[];
    links: string[];
  };
  picked: Array<{
    id: string;
    claim: string;
    cluster: string;
    tags: string[];
    score: number;
    reasons: string[];
  }>;
  pickedAt: string; // ISO timestamp
  vaultRoot: string;
}

/**
 * Write the user-selected candidate set to _index/connect-candidates.json
 * so that the /permanent CLI skill can read it.
 */
export async function saveCandidatesFile(
  app: App,
  seed: SeedInfo,
  picked: Candidate[],
  customPath?: string,
): Promise<string> {
  const payload: CandidatesPayload = {
    version: 1,
    seed: {
      id: seed.id,
      claim: seed.claim,
      cluster: seed.cluster,
      tags: seed.tags,
      links: seed.links,
    },
    picked: picked.map((c) => ({
      id: c.id,
      claim: c.claim,
      cluster: c.cluster,
      tags: c.tags,
      score: c.score.structural,
      reasons: c.reasons,
    })),
    pickedAt: new Date().toISOString(),
    // @ts-expect-error adapter.basePath exists on FileSystemAdapter
    vaultRoot: app.vault.adapter.basePath ?? "",
  };

  const path = normalizePath(customPath ?? DEFAULT_CANDIDATES_PATH);
  const json = JSON.stringify(payload, null, 2);

  // Ensure parent directory exists
  const dir = path.substring(0, path.lastIndexOf("/"));
  if (dir && !(await app.vault.adapter.exists(dir))) {
    await app.vault.adapter.mkdir(dir);
  }

  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) {
    await app.vault.adapter.write(path, json);
  } else {
    await app.vault.create(path, json);
  }

  return path;
}

/** Build the command string that the user pastes into their Terminal to
 *  hand off to Claude Code CLI. */
export function buildPermanentCommand(
  relativePath: string,
  template = 'claude "/permanent --from-candidates {path}"',
): string {
  return template.replace(/\{path\}/g, relativePath);
}

/** Try to write a string to the system clipboard. */
export async function copyToClipboard(
  text: string,
  silent = false,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (!silent) new Notice("명령어가 클립보드에 복사되었습니다.");
    return true;
  } catch (err) {
    console.warn("[cortex] clipboard write failed:", err);
    if (!silent) new Notice("클립보드 복사 실패. 수동으로 복사하세요.");
    return false;
  }
}

/**
 * Try to open the Terminal plugin if installed. Returns true if a terminal
 * command was successfully invoked.
 */
export function tryOpenTerminal(app: App): boolean {
  const commandId = findTerminalCommand(app);
  if (!commandId) return false;
  // @ts-expect-error executeCommandById is public but not typed on App
  app.commands.executeCommandById(commandId);
  return true;
}

function findTerminalCommand(app: App): string | null {
  // @ts-expect-error commands.commands is public but untyped
  const all = app.commands.commands as Record<string, unknown>;
  // Prefer opening a vault-root terminal (most useful for CLI work)
  const preferred = [
    "terminal:open-terminal.integrated.root",
    "terminal:open-terminal-root",
    "terminal:open-vault-root",
  ];
  for (const id of preferred) if (id in all) return id;
  // Fallback: any terminal command
  for (const id of Object.keys(all)) {
    if (id.startsWith("terminal:")) return id;
  }
  return null;
}
