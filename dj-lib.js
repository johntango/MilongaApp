// agent/dj-lib.js (ESM)
//
// Minimal DJ utilities + an in-memory library model that match generate.js.
// You can replace the in-memory LIBRARY with a DB/JSON loader later.

// ------------------------------------------------------------
// In-memory library (you can replace this with your datastore)
// ------------------------------------------------------------

/**
 * Track shape (example)
 * {
 *   id?: string,                          // stable ID (optional if file.absolutePath is stable)
 *   title: string,
 *   artist?: string | null,
 *   album?: string | null,
 *   genre?: "Tango" | "Vals" | "Milonga" | string,
 *   tags?: { genre?: string, [k: string]: any },  // tag map; tags.genre preferred by our code
 *   styles?: Record<string, any>,         // custom style metadata
 *   key?: string,                         // e.g., "G"
 *   camelotKey?: string,                  // e.g., "9B"
 *   BPM?: number,                         // BPM if you have it
 *   Energy?: number,                      // 0..10 scale (or whatever you prefer)
 *   audio?: { duration?: number },        // seconds (preferred) or
 *   duration?: number,                    // seconds
 *   durationMs?: number,                  // milliseconds
 *   file: { absolutePath: string, id?: string, path?: string }
 * }
 */
import path from "node:path";
// Exported as a mutable array so you can replace its contents at runtime.
export let LIBRARY = [];

/** Replace the in-memory library with your own array of tracks (same shape). */
export function setLibrary(tracksArray) {
  if (!Array.isArray(tracksArray)) throw new Error("setLibrary expects an array");
  LIBRARY = tracksArray;
}

/** Append tracks to the current in-memory library. */
export function addToLibrary(tracksArray) {
  if (!Array.isArray(tracksArray)) throw new Error("addToLibrary expects an array");
  LIBRARY.push(...tracksArray);
}
// create library by reading in ./tracks.enriched.json 
import fs from "fs";
//const data = fs.readFileSync("./tracks.enriched.json", "utf-8");

const data = fs.readFileSync("./catalog-Art.json", "utf-8");
const json = JSON.parse(data);
setLibrary(json.tracks);
console.log(`Loaded ${LIBRARY.length} tracks into the in-memory library.`);
// ------------------------------------------------------------
// Cortinas
// ------------------------------------------------------------


// ------------------------------------------------------------
// Catalog extraction & merging
// ------------------------------------------------------------

/**
 * From the incoming catalog, collect resolvable track IDs and style overrides.
 * We treat `file.absolutePath` as the canonical key when available (it’s what
 * generate.js uses to look up overrides), but we also accept plain `id`.
 */

function normKey(s) {
  if (!s) return "";
  let x = String(s).trim();
  x = x.replace(/^file:\/\//i, "");     // drop file:// prefix
  try { x = decodeURIComponent(x); } catch {}
  x = x.replace(/\\/g, "/");            // win → posix
  return x.toLowerCase();               // case-insensitive match
}
function stripExt(p) {
  return p ? p.replace(/\.[a-z0-9]+$/i, "") : p;
}

/**
 * From the incoming catalog, collect resolvable track IDs and style overrides.
 * We treat `file.absolutePath` as canonical when available, but also accept plain `id`,
 * `file.id`, `path`, `uri`, and `file.wavPath`. For each raw key we also add:
 *  - decoded/normalized variant
 *  - extensionless variant (to bridge .mp3 vs .wav, etc.)
 */
// dj-lib.js



// Minimal base64url helper (id = base64url(absolutePath))
const b64u = {
  enc: (s) => Buffer.from(String(s)).toString("base64url"),
  dec: (s) => Buffer.from(String(s), "base64url").toString(),
};

function canonStyles(arrOrStr) {
  if (!arrOrStr) return [];
  const src = Array.isArray(arrOrStr) ? arrOrStr : [arrOrStr];
  const out = new Set();
  for (const s of src) {
    const v = String(s || "").trim().toLowerCase();
    if (v === "tango") out.add("Tango");
    else if (v === "vals" || v === "valse" || v === "waltz") out.add("Vals");
    else if (v === "milonga") out.add("Milonga");
  }
  return [...out];
}

// Canonicalize to a single absolute path string (no variants)
function canonicalAbs(item) {
  // Prefer the original library path if present
  const abs =
    item?.file?.absPath ||
    item?.absPath ||
    (item?.id ? b64u.dec(item.id) : null) ||
    null;

  if (!abs) return null;

  // Normalize separators / remove trailing slashes; keep case (macOS HFS+ can be case-insensitive)
  const norm = path.normalize(String(abs)).replace(/[\\/]+$/, "");
  // Enforce absolute
  return norm.startsWith(path.sep) ? norm : path.sep + norm;
}
const norm = (s) => {
  if (!s) return "";
  let x = String(s).trim().replace(/^file:\/\//i, "");
  try { x = decodeURIComponent(x); } catch {}
  return x.replace(/\\/g, "/").toLowerCase();
};

export function extractCatalogPathsAndStyles({ tracks }) {
  const ids = new Set();           // normalized, exact
  const idsNoExt = new Set();      // normalized, extensionless
  const overrides = new Map();     // absPath|id -> override (styles/tags/etc.)

  for (const t of tracks || []) {
    const cands = [
      t?.file?.absPath,
      t?.file?.absolutePath,
      t?.file?.wavPath,
      t?.id,
      t?.path,
      t?.uri,
    ].filter(Boolean);

    for (const raw of cands) {
      const n  = norm(raw);
      if (!n) continue;
      ids.add(n);
      idsNoExt.add(stripExt(n));
      // Keep an override keyed by both exact and extensionless
      if (t?.styles || t?.tags) {
        overrides.set(n, { styles: t.styles ?? null, tags: t.tags ?? null });
        overrides.set(stripExt(n), { styles: t.styles ?? null, tags: t.tags ?? null });
      }
    }
  }
  return { ids, idsNoExt, overrides };
}

/**
 * Merge catalog-provided overrides into a library track.
 * We do not mutate the original track; we return a new object.
 */
export function mergeSlotsAndTagsIntoTrack(track, override) {
  if (!override) return track;

  const mergedTags = { ...(track.tags ?? {}), ...(override.tags ?? {}) };

  // sync genre to both top-level and tags.genre (array or string tolerated)
  const mergedGenre = override.genre ?? track.genre ?? mergedTags?.genre;
  if (mergedGenre) {
    mergedTags.genre = mergedGenre;
  }

  // adopt schedule “slots” and artUrl if provided
  const merged = {
    ...track,
    tags: mergedTags,
    styles: { ...(track.styles ?? {}), ...(override.styles ?? {}) },
    genre: mergedGenre,
    artUrl: override.tags?.artUrl ?? override.artUrl ?? track.artUrl ?? null,
    // normalize a usable year on top-level to simplify scorers:
    year: mergedTags.year ?? track.year ?? null,
    // carry optional catalog slot signals:
    slot: override.slot ?? track.slot ?? null,
    role: override.role ?? track.role ?? null,
  };

  return merged;
}


// ------------------------------------------------------------
// Fallback deterministic planner
// ------------------------------------------------------------

/** Internal: best-effort conversion to seconds from various fields. */
function toSeconds(v) {
  if (v == null) return 0;
  if (typeof v === "number" && isFinite(v)) return v > 6000 ? Math.round(v / 1000) : Math.round(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
    const parts = s.split(":").map(Number);
    if (parts.every(Number.isFinite)) {
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }
  return 0;
}

/** Get a track’s duration in seconds (prefers audio.duration). */
function getTrackSeconds(t) {
  return (
    toSeconds(t?.audio?.duration) ||
    toSeconds(t?.duration) ||
    toSeconds(t?.durationMs) ||
    toSeconds(t?.length) ||
    0
  );
}

/**
 * Very simple deterministic planner used as a fallback when the agent fails.
 * - Partitions by genre (Tango/ Vals/ Milonga)
 * - Greedily fills pattern with requested sizes until time budget is exhausted
 */
export function makePlan(merged, pattern, minutes, sizes, cortinas) {
  const genreOf = (t) => (t?.tags?.genre ?? t?.genre ?? "")
  
  const byGenre = {
    Tango:   merged.filter((t) => genreOf(t) === "Tango"),
    Vals:    merged.filter((t) => genreOf(t) === "Vals"),
    Milonga: merged.filter((t) => genreOf(t) === "Milonga"),
  };

  const picks = { Tango: 0, Vals: 0, Milonga: 0 };
  const tandas = [];
  let timeLeft = Math.max(60, Math.floor(minutes) * 60);

  for (const style of pattern) {
    const size = Math.max(2, Number(sizes?.[style] ?? 3));
    const pool = byGenre[style] ?? [];
    const chosen = [];

    while (chosen.length < size && picks[style] < pool.length) {
      chosen.push(pool[picks[style]++]);
    }
    if (!chosen.length) continue;

    const seconds = chosen.reduce((s, t) => s + getTrackSeconds(t), 0);
    if (seconds <= 0) continue; // skip empty/invalid durations

    if (seconds > timeLeft) break; // can’t fit this tanda; stop

    tandas.push({
      style,
      tracks: chosen,
      seconds,
      notes: `Fallback planner: ${style} x${chosen.length}`,
    });
    timeLeft -= seconds;

    if (timeLeft <= 0) break;
  }

  return { tandas, cortinas };
}
