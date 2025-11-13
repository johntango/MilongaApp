#!/usr/bin/env node
/**
 * Merge durationSec (from format.durationSec) in tracks.enriched.json
 * into the catalog-MyMusicFull.json "tags" object, matching by file.wavPath.
 *
 * Usage:
 *   node merge-duration.js --enriched ./tracks.enriched.json --catalog ./catalog-MyMusicFull.json [--out ./catalog-updated.json]
 *
 * If --out is omitted, writes <catalog basename>.with-duration.json next to the catalog.
 */

import fs from "node:fs/promises";
import path from "node:path";
const ENRICH_PATH = "./tracks.enriched.json";
const CATALOG_PATH = "./catalog-MyMusicFull.json";
const OUT_PATH = "./catalog-MyMusicFullRev2 .json";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--enriched") out.enriched = argv[++i];
    else if (a === "--catalog") out.catalog = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function normPath(p) {
  if (!p) return null;
  let s = String(p).trim();
  s = s.replace(/^file:\/\//i, "");
  try { s = decodeURIComponent(s); } catch {}
  return s.replace(/\\/g, "/").toLowerCase();
}

/** best-effort extract of a duration (seconds) as an integer */
function toIntSecondsFromEnriched(t) {
  const v = t?.format?.durationSec ?? t?.format?.duration ?? t?.tags?.durationSec ?? null;
  if (v == null) return null;
  const num = Number(v);
  if (Number.isFinite(num)) return Math.round(num);
  // strings like "4:22" (m:ss)
  if (typeof v === "string" && /^\d+:\d{2}(:\d{2})?$/.test(v)) {
    const parts = v.split(":").map(Number);
    const sec = parts.length === 3 ? (parts[0]*3600 + parts[1]*60 + parts[2]) : (parts[0]*60 + parts[1]);
    return Math.round(sec);
  }
  return null;
}

async function main() {
  const { enriched, catalog, out, help } = parseArgs(process.argv);
  if (help || !enriched || !catalog) {
    console.log(`Merge durationSec from enriched → catalog by wavPath.

Usage:
  node merge-duration.js --enriched ./tracks.enriched.json --catalog ./catalog-MyMusicFull.json --out ./catalog-updated.json
`);
    process.exit(help ? 0 : 1);
  }

  const enrichedRaw = await fs.readFile(enriched, "utf8");
  const catalogRaw  = await fs.readFile(catalog, "utf8");

  /** Read inputs (accept either {tracks:[...]} or [...] at root) */
  const enrichedJson = JSON.parse(enrichedRaw);
  const enrichedTracks = Array.isArray(enrichedJson) ? enrichedJson
                        : Array.isArray(enrichedJson.tracks) ? enrichedJson.tracks
                        : [];

  const catalogJson = JSON.parse(catalogRaw);
  if (!Array.isArray(catalogJson.tracks)) {
    throw new Error("catalog JSON must look like { tracks: [...] }");
  }

  // Build wavPath → durationSec map from enriched
  const map = new Map();
  let enrichedWithDur = 0;
  for (const t of enrichedTracks) {
    const wav = normPath(t?.file?.wavPath || t?.file?.absPath || t?.file?.path);
    if (!wav) continue;
    const sec = toIntSecondsFromEnriched(t);
    if (sec != null) {
      // If duplicates exist, keep the first seen
      if (!map.has(wav)) map.set(wav, sec);
      enrichedWithDur++;
    }
  }

  // Merge into catalog
  let updated = 0;
  let noWav = 0;
  let noMatch = 0;

  for (const t of catalogJson.tracks) {
    const wav = normPath(t?.file?.wavPath || t?.file?.absPath || t?.file?.absolutePath || t?.file?.path);
    if (!wav) { noWav++; continue; }
    const sec = map.get(wav);
    if (sec == null) { noMatch++; continue; }

    // Ensure tags exists and set integer durationSec
    t.tags = t.tags && typeof t.tags === "object" ? t.tags : {};
    t.tags.durationSec = sec;
    updated++;
  }

  // Decide output path
  let outPath = out;
  if (!outPath) {
    const dir = path.dirname(path.resolve(catalog));
    const base = path.basename(catalog);
    const stem = base.replace(/\.json$/i, "");
    outPath = path.join(dir, `${stem}.with-duration.json`);
  }

  await fs.writeFile(outPath, JSON.stringify(catalogJson, null, 2), "utf8");

  console.log(`Merged durationSec by wavPath:
  Enriched tracks:        ${enrichedTracks.length}
  Enriched with duration: ${enrichedWithDur}
  Catalog tracks:         ${catalogJson.tracks.length}
  Updated:                ${updated}
  Missing wavPath:        ${noWav}
  No match in enriched:   ${noMatch}
  Wrote:                  ${outPath}`);
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
