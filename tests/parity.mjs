#!/usr/bin/env node
/**
 * Parity sanity test (pure Node, no Obsidian).
 * Mirrors index-reader + structural-score to produce Top-7 for a given seed
 * from the real vault index files.
 *
 * Usage:  node tests/parity.mjs [seedId]       (default: 9380a)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = path.resolve(__dirname, "../../../..");

const seedId = (process.argv[2] ?? "9380a").trim();

async function readFile(rel) {
  return await fs.readFile(path.join(VAULT_ROOT, rel), "utf8");
}

function parseVaultIndex(raw) {
  const notes = new Map();
  let cluster = "";
  const clusterHeader = /^##\s+클러스터:\s+(.+?)\s*\(\d+개\)/;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(clusterHeader);
    if (m) {
      cluster = m[1].trim();
      continue;
    }
    if (!line.trim().startsWith("|")) continue;
    if (line.includes("---") || line.includes("| ID ")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const [idCell, claim, tagsCell, linksCell] = cells;
    const id = idCell.replace(/^\s+/, "");
    if (!id) continue;
    const tags = tagsCell ? tagsCell.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const links = linksCell ? linksCell.split(",").map((t) => t.trim()).filter(Boolean) : [];
    if (notes.has(id)) {
      const ex = notes.get(id);
      for (const t of tags) if (!ex.tags.includes(t)) ex.tags.push(t);
      for (const l of links) if (!ex.links.includes(l)) ex.links.push(l);
      continue;
    }
    notes.set(id, { id, claim, cluster, tags, links });
  }
  return notes;
}

function mergeGraph(notes, raw) {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(">")) continue;
    const arr = t.split("→");
    if (arr.length !== 2) continue;
    const id = arr[0].trim();
    const targets = arr[1].split(",").map((x) => x.trim()).filter(Boolean);
    if (!notes.has(id)) continue;
    const n = notes.get(id);
    for (const x of targets) if (!n.links.includes(x)) n.links.push(x);
  }
}

function buildBacklinks(notes) {
  const back = new Map();
  for (const [id, n] of notes) {
    for (const t of n.links) {
      if (!back.has(t)) back.set(t, new Set());
      back.get(t).add(id);
    }
  }
  return back;
}

function score(seedId, notes, back) {
  const seed = notes.get(seedId);
  if (!seed) throw new Error(`seed ${seedId} not in index`);
  const excluded = new Set([seedId, ...seed.links]);

  const seedNeighbors = new Set(seed.links);
  for (const b of back.get(seedId) ?? []) seedNeighbors.add(b);
  const hop1 = new Set();
  for (const n of seedNeighbors) if (!excluded.has(n)) hop1.add(n);
  const hop2 = new Set();
  for (const pivot of seedNeighbors) {
    const n = notes.get(pivot);
    if (!n) continue;
    for (const l of n.links) if (!excluded.has(l) && !hop1.has(l) && l !== seedId) hop2.add(l);
    for (const b of back.get(pivot) ?? []) if (!excluded.has(b) && !hop1.has(b) && b !== seedId) hop2.add(b);
  }

  const scores = new Map();
  const bump = (id, s, reason) => {
    if (excluded.has(id) || id === seedId || !notes.has(id)) return;
    const c = scores.get(id) ?? { score: 0, reasons: [] };
    c.score += s;
    c.reasons.push(reason);
    scores.set(id, c);
  };
  for (const id of hop1) bump(id, 5, "1-hop");
  for (const id of hop2) bump(id, 2, "2-hop");
  const NOISE = new Set(["미분류", "unclassified", ""]);
  const clusterMeaningful = seed.cluster && !NOISE.has(seed.cluster);
  const seedTags = new Set(seed.tags.filter((t) => !NOISE.has(t)));
  for (const [id, n] of notes) {
    if (excluded.has(id) || id === seedId) continue;
    if (clusterMeaningful && n.cluster && n.cluster === seed.cluster && !NOISE.has(n.cluster))
      bump(id, 3, `cluster:${n.cluster}`);
    const shared = n.tags.filter((t) => seedTags.has(t) && !NOISE.has(t));
    if (shared.length) bump(id, 2 * shared.length, `tags:${shared.join(",")}`);
    const cousin = n.links.filter((l) => seedNeighbors.has(l)).length;
    if (cousin) bump(id, Math.min(cousin, 3), `cousin:${cousin}`);
  }
  const out = [];
  for (const [id, { score, reasons }] of scores) {
    const n = notes.get(id);
    out.push({ id, claim: n.claim, cluster: n.cluster, score, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 10);
}

const indexRaw = await readFile("_index/VAULT_INDEX.md");
const graphRaw = await readFile("_index/GRAPH.md");
const notes = parseVaultIndex(indexRaw);
mergeGraph(notes, graphRaw);
const back = buildBacklinks(notes);

const seed = notes.get(seedId);
console.log(`\n=== Seed ${seedId}: ${seed?.claim ?? "(not found)"}`);
console.log(`    cluster=${seed?.cluster} tags=[${seed?.tags.join(",")}] links=[${seed?.links.join(",")}]\n`);

const top = score(seedId, notes, back);
console.log(`Total notes indexed: ${notes.size}`);
console.log(`Top-10 candidates:\n`);
for (const c of top) {
  console.log(`  ${c.score.toString().padStart(3)}  ${c.id.padEnd(10)} ${c.claim.slice(0, 60)}`);
  console.log(`       └─ ${c.reasons.slice(0, 3).join(" · ")}`);
}
