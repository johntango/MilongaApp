/// server.js
// Minimal backend for a single-page Milonga planner/player.
// Env:
//   PORT=3000
//   LIBRARY_JSON=./catalog-Art.json"
//   CORTINAS_DIR=/path/to/cortinas   (optional)
//   OPENAI_API_KEY=...               (optional; used by agent in generate.js)

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Route module that registers /api/agent/generate (Agent-only planner)
// ---------- Register Agent routes (LLM planning) ----------
import {registerAgentRoutes, registerAgentStreamRoutes } from "./generate.js";
import { time } from "node:console";
//import { registerCortinaRoutes } from "./generate.js"; // adjust path if needed

// after other route registrations:

// ...
dotenv.config();

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "public");
const MUSIC_ROOT = "/Users/johnwilliams/Music/MyMusic"
const ART_DIR    = "/Users/johnwilliams/Music/Art"; 
// ---- Config (top of server.js) ----
const PAIRS_JSON = process.env.PAIRS_JSON || path.join(process.cwd(), "catalog-Art.json");


// ---------- App ----------
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/album-art", express.static(ART_DIR));
// NEW: mount /files to expose covers referenced by tags.coverUrl
app.use("/files", express.static(MUSIC_ROOT, {
  maxAge: "1d",
  dotfiles: "ignore",
  fallthrough: false,
}));
app.use(express.static(path.join(__dirname, 'public')));

registerAgentRoutes(app);         // existing JSON endpoint
registerAgentStreamRoutes(app);   // NEW: NDJSON streaming endpoint



const PORT         = process.env.PORT || 4000;
const LIBRARY_JSON = process.env.LIBRARY_JSON || path.join(process.cwd(), "catalog-Art.json");
const CORTINAS_DIR = process.env.CORTINAS_DIR || "";

// ---------- Utility: base64url encode/decode for file path IDs ----------
const b64u = {
  enc: (s) => Buffer.from(String(s)).toString("base64url"),
  dec: (s) => Buffer.from(String(s), "base64url").toString(),
};

// ---------- Load library (supports array OR {tracks:[]}) ----------
function loadLibrary() {
  const raw = fs.readFileSync(LIBRARY_JSON, "utf8");
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return data;                 // common for enriched exports
  if (data && Array.isArray(data.tracks)) return data.tracks;
  throw new Error("Invalid library JSON: expected array or {tracks:[]}");
}
let LIBRARY = [];
try {
  LIBRARY = loadLibrary();
  console.log(`[lib] loaded ${LIBRARY.length} tracks from ${LIBRARY_JSON}`);
} catch (e) {
  console.error("[lib] failed to load:", e.message);
  LIBRARY = [];
}

// Auto-reload if file changes (simple watcher)
fs.watch(LIBRARY_JSON, { persistent: false }, () => {
  try {
    LIBRARY = loadLibrary();
    console.log("[lib] reloaded:", LIBRARY.length);
  } catch (e) {
    console.error("[lib] reload error:", e.message);
  }
});

// ---- Loader with caching / hot reload ----
// ---------- BPM helper: accept both legacy BPM and new tempoBPM ----------
function readBPM(tags) {
  const a = tags?.BPM;
  const b = tags?.tempoBPM;
  const na = a == null ? null : Number.parseFloat(a);
  const nb = b == null ? null : Number.parseFloat(b);
  if (Number.isFinite(na)) return na;
  if (Number.isFinite(nb)) return nb;
  return null;
}
function getBPM(x) {
  // accept object-level or nested tags/audio; prefer explicit BPM over tempoBPM
  const cands = [
    x?.BPM,        // UIs / bulk responses (PascalCase)
    x?.bpm,        // streaming responses (lowercase)
    x?.tempoBPM,
    x?.tags?.BPM,
    x?.tags?.tempoBPM,
    x?.audio?.bpm,
  ];
  for (const v of cands) {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return Math.round(n * 10) / 10;
  }
  return null;
}

// ---------- File path helper: accept absPath | absPath | path | fullPath ----------
function getAbsolutePath(file) {
  if (!file) return null;
  return (
    file.absPath ||
    file.absPath ||
    file.path ||
    file.fullPath ||
    null
  );
}
async function readJSONSafe(p) {
  try { return JSON.parse(await fs.promises.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeJSONAtomic(p, obj, spaces = 2) {
  const tmp = `${p}.tmp`;
  const json = JSON.stringify(obj, null, spaces) + '\n';
  await fs.promises.writeFile(tmp, json, 'utf8');
  await fs.promises.rename(tmp, p);
}
// ---------- Style canon ----------
function canonStyles(arrOrStr) {
  if (!arrOrStr) return [];
  const raw = Array.isArray(arrOrStr) ? arrOrStr : [arrOrStr];
  const set = new Set();
  for (const s of raw) {
    const v = String(s || "").trim().toLowerCase();
    if (v === "tango") set.add("Tango");
    else if (v === "vals" || v === "valse" || v === "waltz") set.add("Vals");
    else if (v === "milonga") set.add("Milonga");
  }
  return [...set];
}

// ---------- Compact catalog row ----------
// server.js (same module where toCompactTrack lives)
function toFilesUrl(p) {
  if (!p) return null;
  const MUSIC_ROOT = "/Users/johnwilliams/Music/MyMusic";
  let x = String(p).replace(/\\/g, "/");

  // Already a web path?
  if (x.startsWith("/files/")) return x;

  // Absolute filesystem path under MUSIC_ROOT -> convert to /files/...
  const root = MUSIC_ROOT.replace(/\\/g, "/");
  if (x.startsWith(root)) return "/files" + x.slice(root.length);

  // Some catalogs store only the tail (e.g., "ROCK Artists/.../Folder.jpg")
  if (!x.startsWith("/")) x = "/" + x;
  // Assume it's relative to MUSIC_ROOT:
  return "/files" + x; // -> /files/ROCK Artists/.../Folder.jpg
}

function toCompactTrack(t) {
  const genres = Array.isArray(t.tags?.genre) ? t.tags.genre : (t.tags?.genre ? [t.tags.genre] : []);
  const abs = getAbsolutePath(t.file);

  // compute cover fallback once
  const coverFallback =
    toFilesUrl(t.tags?.coverUrl) ??
    toFilesUrl(t.tags?.coverPath) ?? null;

  return {
    id: abs ? b64u.enc(abs) : null,
    title: t.tags?.title ?? (abs ? path.basename(abs) : "Unknown"),
    artist: t.tags?.artist ?? null,
    album: t.tags?.album ?? null,
    durationSec: t.format?.durationSec != null && Number.isFinite(t.format.durationSec)
      ? Math.round(t.format.durationSec) : null,
    BPM: (() => {
      const v = readBPM(t.tags);
      return v == null ? null : Math.round(v * 10) / 10;
    })(),
    Energy: (t.tags?.Energy ?? null) == null ? null : Math.round(t.tags.Energy * 10) / 10,
    Key: t.tags?.Key ?? null,
    camelotKey: t.tags?.camelotKey ?? null,
    absolutePath: abs,
    styles: canonStyles(genres),

    // Prefer artUrl if present; else normalized cover
    artUrl: t.artUrl ?? coverFallback,
    // (optional) also surface coverUrl itself
    coverUrl: coverFallback,
    year: t.tags?.year,

    // keep tags (with normalized coverUrl for convenience)
    tags: { ...t.tags, coverUrl: coverFallback },
  };
}

//=========
// NEW: mount /files to expose covers referenced by tags.coverUrl
app.use("/files", express.static(MUSIC_ROOT, {
  maxAge: "1d",
  dotfiles: "ignore",
  fallthrough: false,
}));
// GET /api/catalog/full  -> returns an array of tracks
app.get('/api/catalog/full', async (_req, res) => {
  try {
    const artHyphen = 'catalog-Art.json';
    const fullHyphen = 'catalog-Full.json';
    const fullCamel  = 'catalogFull.json';

    // pick the first existing file
    const filePath =
      (fs.existsSync(artHyphen)  && artHyphen)  ||
      (fs.existsSync(fullHyphen) && fullHyphen) ||
      (fs.existsSync(fullCamel)  && fullCamel);

    if (!filePath) {
      // no catalog present -> return empty list (front-end expects an array)
      return res.json([]);
    }

    const doc = await readJSONSafe(filePath);
    // Support both shapes:
    // 1) { tracks: [...] }
    // 2) [...] (rare, but be tolerant)
    const tracks = Array.isArray(doc) ? doc : Array.isArray(doc?.tracks) ? doc.tracks : [];

    return res.json(tracks);
  } catch (e) {
    console.error('GET /api/catalog/full error:', e);
    return res.status(500).json([]);
  }
});

// ---------- GET /api/catalog/compact ----------
app.get("/api/catalog/compact", (req, res) => {
  const styles = String(req.query.style || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean); // e.g., ["tango","vals"]

  const q = String(req.query.search || "").trim().toLowerCase();
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
  const pageSize = Math.min(1000, Math.max(50, parseInt(String(req.query.pageSize || "500"), 10)));

  // filter by style (from tags.genre) and free-text (title/artist/album/path)
  let list = LIBRARY.filter((t) => {
    const genres = Array.isArray(t.tags?.genre) ? t.tags.genre : (t.tags?.genre ? [t.tags.genre] : []);
    const gset = genres.map((g) => String(g).toLowerCase());
    const hasStyle = !styles.length || gset.some((g) => styles.includes(g));
    if (!hasStyle) return false;
    if (!q) return true;
    const hay = [
      t.tags?.title,
      t.tags?.artist,
      t.tags?.album,
      t.tags?.albumartist,
      t.file?.absPath,
      t.artUrl,
      t.tags?.year
    ]
      .filter(Boolean)
      .join(" • ")
      .toLowerCase();
    return hay.includes(q);
  });

  // map to compact
  const all = list.map(toCompactTrack);

  // stable sort (artist -> album -> title)
  all.sort(
    (a, b) =>
      (a.artist || "").localeCompare(b.artist || "") ||
      (a.album || "").localeCompare(b.album || "") ||
      (a.title || "").localeCompare(b.title || "")
  );

  const start = (page - 1) * pageSize;
  const slice = all.slice(start, start + pageSize);

  res.set("Cache-Control", "no-store");
  res.json({
    paging: { page, pageSize, total: all.length, pages: Math.ceil(all.length / pageSize) },
    tracks: slice,
  });
});

// ---------- Cortinas ----------
async function listCortinas() {
  if (!CORTINAS_DIR) return [];
  try {
    const files = await fsp.readdir(CORTINAS_DIR);
    return files
      .filter((f) => /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(f))
      .map((f) => ({
        id: b64u.enc(path.join(CORTINAS_DIR, f)),
        title: f.replace(/\.[^.]+$/, ""),
        minutes: 1.0, // UI target; real duration comes from client audio
      }));
  } catch {
    return [];
  }
}

// ---------- MIME map ----------
const MIME = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
};

// ---------- Stream local files with Range support ----------
app.get("/stream/:id", async (req, res) => {
  try {
    const absPath = b64u.dec(req.params.id);
    if (!fs.existsSync(absPath)) return res.status(404).send("Not found");
    const stat = await fsp.stat(absPath);
    const total = stat.size;
    const ext = path.extname(absPath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";

    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { "Content-Type": type, "Content-Length": total });
      fs.createReadStream(absPath).pipe(res);
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    const chunk = Math.min(end - start + 1, 1 << 20); // up to 1MB
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${start + chunk - 1}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunk,
      "Content-Type": type,
    });
    fs.createReadStream(absPath, { start, end: start + chunk - 1 }).pipe(res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});
// DELETE /api/playlists/:id  -> { ok: true }
app.delete("/api/playlists/:id", async (req, res) => {
  try {
    const want = String(req.params.id || "");
    if (!want) return res.status(400).json({ error: "Missing id" });

    const files = (await fsp.readdir(PLAYLISTS_DIR))
      .filter(f => f.endsWith(".json") && f.includes(`-${want}-`));

    if (!files.length) return res.status(404).json({ error: "Not found" });

    // If multiple match (shouldn’t), remove all; typically there’s one
    await Promise.all(files.map(fn => fsp.unlink(path.join(PLAYLISTS_DIR, fn))));
    return res.json({ ok: true, deleted: files.length });
  } catch (e) {
    console.error("[playlists] delete failed:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------- Simple deterministic planner (kept for /api/plan demo UI) ----------
function hasStyle(track, style) {
  const g = Array.isArray(track?.tags?.genre) ? track.tags.genre : (track?.tags?.genre ? [track.tags.genre] : []);
  return g.map((x) => String(x).toLowerCase()).includes(style.toLowerCase());
}
function dec(y) {
  return y && Number.isFinite(y) ? Math.floor(y / 10) * 10 : null;
}
function camelotOk(prev, curr) {
  if (!prev || !curr) return true;
  const a = /^(\d{1,2})([AB])$/.exec(prev);
  const b = /^(\d{1,2})([AB])$/.exec(curr);
  if (!a || !b) return true;
  const na = parseInt(a[1], 10),
    nb = parseInt(b[1], 10);
  const d = Math.abs(na - nb);
  return na === nb || d === 1 || d === 11; // wrap
}
function durMin(t) {
  return Math.max(2, (t.format?.durationSec ?? 180) / 60);
}
function pickId(tr) {
  const abs = getAbsolutePath(tr.file);
  return abs ? b64u.enc(abs) : null;
}

function scoreWithinTanda(cand, size) {
  const byCluster = new Map();
  for (const t of cand) {
    const key = `${t.tags?.artist ?? "Unknown"}|${dec(t.tags?.year) ?? "?"}`;
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(t);
  }
  const [_, seedPool] =
    [...byCluster.entries()].sort((a, b) => b[1].length - a[1].length)[0] || [null, cand.slice()];
  const pool = seedPool ?? cand.slice();

  const bpms = pool.map((x) => getBPM(x) ?? 0).filter(Boolean).sort((a, b) => a - b);
  const median = bpms.length ? bpms[Math.floor(bpms.length / 2)] : null;
  pool.sort((a, b) => {
    const da = Math.abs((getBPM(a) ?? median ?? 0) - (median ?? 0));
    const db = Math.abs((getBPM(b) ?? median ?? 0) - (median ?? 0));
    return da - db;
  });

  const chosen = [];
  for (const t of pool) {
    if (!chosen.length) {
      chosen.push(t);
      if (chosen.length === size) break;
      continue;
    }
    const last = chosen[chosen.length - 1];
    const bt = getBPM(t), bl = getBPM(last);
    const bpmOk = !bt || !bl || Math.abs(bt - bl) <= 6;
    const eraOk = dec(t.tags?.year) === dec(last.tags?.year);
    const artOk = (t.tags?.artist ?? "") === (last.tags?.artist ?? "");
    const keyOk = camelotOk(last.tags?.camelotKey ?? null, t.tags?.camelotKey ?? null);
    if (bpmOk && keyOk && (eraOk || artOk)) chosen.push(t);
    if (chosen.length === size) break;
  }
  if (chosen.length < size) {
    const need = size - chosen.length;
    const rest = cand
      .filter((t) => !chosen.includes(t))
      .sort((a, b) =>
        Math.abs((getBPM(a) ?? median ?? 0) - (median ?? 0)) -
        Math.abs((getBPM(b) ?? median ?? 0) - (median ?? 0))
      );
    chosen.push(...rest.slice(0, need));
  }
  return chosen.slice(0, size);
}

function makePlan(
  library,
  pattern = ["Tango", "Tango", "Vals", "Tango", "Tango", "Milonga"],
  minutesTarget = 180,
  sizes = { Tango: 4, Vals: 3, Milonga: 3 },
  cortinas = []
) {
  const byStyle = {
    Tango: library.filter((t) => hasStyle(t, "Tango")),
    Vals:  library.filter((t) => hasStyle(t, "Vals")),
    Milonga: library.filter((t) => hasStyle(t, "Milonga")),
  };

  const tandas = [];
  let minutes = 0;
  const used = new Set();

  const cortinaSeq = (cortinas.length ? cortinas : []).map((c) => ({ ...c }));
  let cortinaIdx = 0;

  outer: while (minutes < minutesTarget - 5) {
    for (const style of pattern) {
      // Use normalized absolute path & the used set
      const pool = byStyle[style].filter((t) => {
        const abs = getAbsolutePath(t.file);
        return abs && !used.has(abs);
      });
      if (pool.length === 0) break outer;

      const size = sizes[style];
      const chosen = scoreWithinTanda(pool, size);
      if (chosen.length < Math.min(3, size)) break outer;

      // Mark chosen as used by normalized path
      chosen.forEach((t) => {
        const abs = getAbsolutePath(t.file);
        if (abs) used.add(abs);
      });

      const tMin = chosen.reduce((s, t) => s + durMin(t), 0);

      const tanda = {
        id: crypto.randomUUID(),
        type: "tanda",
        style,
        size,
        approxMinutes: Math.round(tMin),
        tracks: chosen.map((t) => {
          const abs = getAbsolutePath(t.file);
          return {
            id: pickId(t),
            title: t.tags?.title || (abs ? path.basename(abs) : "Unknown"),
            artist: t.tags?.artist || null,
            album: t.tags?.album || null,
            BPM: (() => { const v = getBPM(t); return v == null ? null : Math.round(v * 10) / 10; })(),
            Energy: t.tags?.Energy || null,
            Key: t.tags?.Key || null,
            camelotKey: t.tags?.camelotKey || null,
            absPath: abs || null,
          };
        }),
      };

      tandas.push(tanda);
      minutes += tMin;

      // Cortina
      const c = cortinaSeq.length ? cortinaSeq[cortinaIdx % cortinaSeq.length] : null;
      cortinaIdx++;
      tandas.push({
        id: crypto.randomUUID(),
        type: "cortina",
        title: c?.title || "Cortina",
        absPath: c?.id || null,
        approxMinutes: 1.0,
      });
      minutes += 1.0;

      if (minutes >= minutesTarget) break outer;
    }
  }

  // Trim trailing cortina if we overshot by just the cortina minute
  if (
    tandas.length &&
    tandas[tandas.length - 1].type === "cortina" &&
    minutes - 1.0 >= minutesTarget - 0.5
  ) {
    tandas.pop();
    minutes -= 1.0;
  }

  return { id: `plan-${Date.now()}`, pattern, tandas, totalMinutes: Math.round(minutes) };
}

// ---------- API: library / cortinas / deterministic plan ----------
app.get("/api/library", (_req, res) => {
  res.json({
    tracks: LIBRARY.map((t) => {

      const abs = getAbsolutePath(t.file);
      return ({
        id: pickId(t),
        title: t.tags?.title || (abs ? path.basename(abs) : "Unknown"),
        artist: t.tags?.artist || null,
        album: t.tags?.album || null,
        styles: Array.isArray(t.tags?.genre) ? t.tags.genre : t.tags?.genre ? [t.tags.genre] : [],
        BPM: (() => { const v = readBPM(t.tags); return v == null ? null : Math.round(v * 10) / 10; })(),
        Energy: t.tags?.Energy || null,
        Key: t.tags?.Key || null,
        camelotKey: t.tags?.camelotKey || null,
        absPath: abs,
      });
    })
  });
});

app.get("/api/cortinas", async (_req, res) => {
  const pool = await listCortinas();
  res.json({ cortinas: pool });
});

app.post("/api/plan", async (req, res) => {
  try {
    const minutes = Number(req.body?.minutes || 180);
    const pattern = Array.isArray(req.body?.pattern)
      ? req.body.pattern
      : ["Tango", "Tango", "Vals", "Tango", "Tango", "Milonga"];
    const sizes = req.body?.sizes || { Tango: 4, Vals: 3, Milonga: 3 };
    const cortinas = await listCortinas();
    const plan = makePlan(LIBRARY, pattern, minutes, sizes, cortinas);
    res.json({ plan });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/api/plan/swap", (req, res) => {
  try {
    const plan = req.body?.plan;
    const i = Number(req.body?.i), j = Number(req.body?.j);
    if (!plan || !Array.isArray(plan.tandas)) throw new Error("Invalid plan");
    if (i === j) return res.json({ plan });
    if (i < 0 || j < 0 || i >= plan.tandas.length || j >= plan.tandas.length) throw new Error("Index out of range");
    if (plan.tandas[i].type !== "tanda" || plan.tandas[j].type !== "tanda") throw new Error("Swap requires tanda indices");
    const copy = typeof structuredClone === "function" ? structuredClone(plan) : JSON.parse(JSON.stringify(plan));
    [copy.tandas[i], copy.tandas[j]] = [copy.tandas[j], copy.tandas[i]];
    res.json({ plan: copy });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ====== Playlists persistence ======

const PLAYLISTS_DIR = process.env.PLAYLISTS_DIR || path.join(process.cwd(), "playlists");
const TANDAS_DIR = process.env.TANDAS_DIR || path.join(process.cwd(), "tandas");

// Ensure dirs exist
try {
  fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
  fs.mkdirSync(TANDAS_DIR, { recursive: true });
} catch (e) {
  console.error("[playlists/tandas] failed to create dirs:", e.message);
}

function slugifyName(name) {
  return String(name || "Untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "playlist";
}

function playlistMetaFromFile(fn) {
  // filename format: <timestamp>-<id>-<slug>.json
  const m = /^(\d{13})-([a-f0-9]{12})-(.+)\.json$/.exec(fn);
  if (!m) return null;
  const [ , ts, id, slug ] = m;
  return {
    id,
    name: slug.replace(/-/g, " "),
    slug,
    createdAt: new Date(Number(ts)).toISOString(),
    file: fn,
  };
}

// POST /api/playlists { name: string, plan: object }
app.post("/api/playlists", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim() || "Untitled";
    const plan = req.body?.plan;
    if (!plan || !Array.isArray(plan.tandas)) {
      return res.status(400).json({ error: "Invalid or missing plan" });
    }
    const id = crypto.randomBytes(6).toString("hex");     // 12 hex chars
    const ts = Date.now();
    const slug = slugifyName(name);
    const filename = `${ts}-${id}-${slug}.json`;
    const abs = path.join(PLAYLISTS_DIR, filename);

    const record = {
      id,
      name,
      createdAt: new Date(ts).toISOString(),
      plan,                       // store full plan object you already send to client
      meta: { version: 1 },       // room to evolve format
    };
    await fsp.writeFile(abs, JSON.stringify(record, null, 2), "utf8");
    return res.json({ id, name, createdAt: record.createdAt });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/playlists  -> [{id,name,createdAt}, ...] newest first
app.get("/api/playlists", async (_req, res) => {
  try {
    const files = (await fsp.readdir(PLAYLISTS_DIR)).filter(f => f.endsWith(".json"));
    const metas = files
      .map(playlistMetaFromFile)
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Read names from file (more reliable than slug); do a light peek
    const out = [];
    for (const m of metas) {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(PLAYLISTS_DIR, m.file), "utf8"));
        out.push({ id: j.id || m.id, name: j.name || m.name, createdAt: j.createdAt || m.createdAt });
      } catch {
        out.push({ id: m.id, name: m.name, createdAt: m.createdAt });
      }
    }
    res.json({ playlists: out });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/playlists/:id -> { id,name,createdAt,plan }
app.get("/api/playlists/:id", async (req, res) => {
  try {
    const want = String(req.params.id || "");
    const files = (await fsp.readdir(PLAYLISTS_DIR)).filter(f => f.includes(`-${want}-`) && f.endsWith(".json"));
    if (!files.length) return res.status(404).json({ error: "Not found" });
    // If multiple due to same id (shouldn't happen), pick most recent
    files.sort().reverse();
    const record = JSON.parse(await fsp.readFile(path.join(PLAYLISTS_DIR, files[0]), "utf8"));
    res.json(record);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ====== Tanda Library persistence ======

function tandaMetaFromFile(fn) {
  // filename format: <timestamp>-<id>-<slug>.json
  const m = /^(\d{13})-([a-f0-9]{12})-(.+)\.json$/.exec(fn);
  if (!m) return null;
  const [ , ts, id, slug ] = m;
  return {
    id,
    name: slug.replace(/-/g, " "),
    slug,
    createdAt: new Date(Number(ts)).toISOString(),
    file: fn,
  };
}

// POST /api/tandas { name: string, tanda: object }
app.post("/api/tandas", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim() || "Untitled Tanda";
    const tanda = req.body?.tanda;
    if (!tanda || !tanda.orchestra || !Array.isArray(tanda.tracks)) {
      return res.status(400).json({ error: "Invalid tanda: missing orchestra or tracks" });
    }
    
    const id = crypto.randomBytes(6).toString("hex");
    const ts = Date.now();
    const slug = slugifyName(name);
    const filename = `${ts}-${id}-${slug}.json`;
    const abs = path.join(TANDAS_DIR, filename);

    // Calculate metadata
    const trackCount = tanda.tracks.length;
    const totalSeconds = tanda.tracks.reduce((sum, t) => sum + (t.seconds || 0), 0);
    const approxMinutes = Math.round(totalSeconds / 60 * 10) / 10;
    const bpms = tanda.tracks.map(t => t.BPM).filter(Boolean);
    const avgBPM = bpms.length ? Math.round(bpms.reduce((sum, bpm) => sum + bpm, 0) / bpms.length) : null;

    const record = {
      id,
      name,
      createdAt: new Date(ts).toISOString(),
      tanda: {
        ...tanda,
        metadata: {
          trackCount,
          totalSeconds,
          approxMinutes,
          avgBPM,
          keys: tanda.tracks.map(t => t.camelotKey || t.Key).filter(Boolean),
          artists: [...new Set(tanda.tracks.map(t => t.artist).filter(Boolean))],
          savedFrom: "manual" // vs "generated"
        }
      },
      meta: { version: 1 }
    };
    
    await fsp.writeFile(abs, JSON.stringify(record, null, 2), "utf8");
    console.log(`[tandas] Saved tanda "${name}" (${trackCount} tracks, ${tanda.orchestra})`);
    
    return res.json({ 
      id, 
      name, 
      createdAt: record.createdAt,
      metadata: record.tanda.metadata 
    });
  } catch (e) {
    console.error("[tandas] Save failed:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/tandas -> [{id,name,createdAt,metadata}, ...] newest first
app.get("/api/tandas", async (_req, res) => {
  try {
    const files = (await fsp.readdir(TANDAS_DIR)).filter(f => f.endsWith(".json"));
    const out = [];
    
    for (const fn of files) {
      try {
        const meta = tandaMetaFromFile(fn);
        if (!meta) continue;
        
        const content = JSON.parse(await fsp.readFile(path.join(TANDAS_DIR, fn), "utf8"));
        out.push({
          id: content.id || meta.id,
          name: content.name || meta.name,
          createdAt: content.createdAt || meta.createdAt,
          orchestra: content.tanda?.orchestra,
          style: content.tanda?.style,
          metadata: content.tanda?.metadata || {
            trackCount: content.tanda?.tracks?.length || 0,
            approxMinutes: 0
          }
        });
      } catch (e) {
        console.warn(`[tandas] Failed to read ${fn}:`, e.message);
      }
    }
    
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ tandas: out });
  } catch (e) {
    console.error("[tandas] List failed:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /api/tandas/:id -> { id,name,createdAt,tanda }
app.get("/api/tandas/:id", async (req, res) => {
  try {
    const want = String(req.params.id || "");
    const files = (await fsp.readdir(TANDAS_DIR)).filter(f => f.includes(`-${want}-`) && f.endsWith(".json"));
    if (!files.length) return res.status(404).json({ error: "Tanda not found" });
    
    files.sort().reverse(); // Most recent if duplicates
    const record = JSON.parse(await fsp.readFile(path.join(TANDAS_DIR, files[0]), "utf8"));
    res.json(record);
  } catch (e) {
    console.error("[tandas] Get failed:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// DELETE /api/tandas/:id
app.delete("/api/tandas/:id", async (req, res) => {
  try {
    const want = String(req.params.id || "");
    const files = (await fsp.readdir(TANDAS_DIR)).filter(f => f.includes(`-${want}-`) && f.endsWith(".json"));
    
    if (files.length === 0) {
      return res.status(404).json({ error: "Tanda not found" });
    }
    
    // Delete all matching files (shouldn't be multiple, but just in case)
    await Promise.all(files.map(fn => fsp.unlink(path.join(TANDAS_DIR, fn))));
    console.log(`[tandas] Deleted tanda ${want} (${files.length} files)`);
    
    res.json({ ok: true, deletedFiles: files.length });
  } catch (e) {
    console.error("[tandas] Delete failed:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

let viewerWin = null;

function openOrUpdateViewer(trackMeta) {
  if (!viewerWin || viewerWin.closed) {
    viewerWin = window.open("/viewer.html", "NowPlaying", "width=400,height=600");
  }
  // Send metadata once the viewer is ready
  setTimeout(() => {
    viewerWin?.postMessage(trackMeta, "*");
  }, 300); // allow time for viewer to load
}
// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Milonga planner listening on http://localhost:${PORT}`);
})