// agent/generate.js  (ESM)
// npm i @openai/agents @openai/agents-openai zod dotenv
// Ensure: export OPENAI_API_KEY in your environment.

import dotenv from "dotenv";
dotenv.config();

import { Agent, run, system } from "@openai/agents";
import { setDefaultOpenAIKey } from "@openai/agents-openai";
import { z } from "zod";
// NOTE: generate.js is already inside /agent, so import sibling:
import { orchestraAgent } from "./agent/orchestraAgent.js";
import crypto from "node:crypto";
import { scoreTrackByRole, inferRoleByPosition } from "./agent/scoring.js";

// Your shared library helpers/singleton
import {
  LIBRARY,
  extractCatalogPathsAndStyles,
  mergeSlotsAndTagsIntoTrack,
} from "./dj-lib.js";

// -------------------- OpenAI key for Agents SDK --------------------
setDefaultOpenAIKey(process.env.OPENAI_API_KEY);

// ==================================================================
//                           SCHEMAS / AGENTS
// ==================================================================

const NextTanda = z.object({
  style: z.enum(["Tango", "Vals", "Milonga"]),
  tracks: z.array(z.string()).min(2).max(6), // IDs from candidates only
  notes: z.string().nullable(),
  warnings: z.array(z.string()).nullable(),
});

const PlaylistReview = z.object({
  orchestraAnalysis: z.string(),
  musicalFlow: z.string(),
  styleBalance: z.string(),
  danceability: z.string(),
  djCraft: z.string(),
  audienceEngagement: z.string(),
  overallAssessment: z.string(),
  recommendations: z.array(z.string()).nullable(),
});

const playlistReviewAgent = new Agent({
  name: "PlaylistReviewer",
  instructions: [
    "You are an expert Argentine tango DJ and musicologist with decades of experience in milonga programming.",
    "Analyze playlists from the perspective of a seasoned milonguero and professional DJ.",
    "Provide detailed, insightful reviews that help DJs improve their craft.",
    "Be specific about track and orchestra choices where relevant.",
    "Write in a conversational, expert tone as if advising a fellow DJ.",
    "Focus on practical aspects: danceability, energy flow, orchestra variety, and audience engagement.",
    "Consider both traditional milonga expectations and modern DJ techniques.",
  ].join(" "),
  outputType: PlaylistReview,
  model: "gpt-4o",
});

const nextTandaAgent = new Agent({
  name: "NextTandaPlanner",
  instructions: [
    "You plan exactly ONE tanda at a time for a milonga.",
    "Hard rules:",
    "- Use ONLY track IDs from the provided CANDIDATES list.",
    "- Do NOT repeat any ID from the provided USED_IDS list.",
    "- Match the requested style and size.",
    "- Prefer stylistic coherence (era/energy/artist); avoid back-to-back same artist unless needed.",
    "- Keep within the remaining time when possible; prefer typical lengths.",
    "Return ONLY JSON that matches the output schema.",
  ].join(" "),
  outputType: NextTanda,
  model: "gpt-4o",
  modelSettings: { temperature: 0.7 },
});

// Structured output the agent must produce (for replacement route)
const ReplacementResult = z.object({
  chosenId: z.string(), // ID of the selected replacement
  suggestions: z
    .array(
      z.object({
        id: z.string(),
        reason: z.string().nullable(),
      })
    )
    .min(1),
});

const replaceAgent = new Agent({
  name: "TrackReplaceAgent",
  instructions: [
    "You replace ONE track in a tanda, keeping musical coherence.",
    "CRITICAL: Use ONLY IDs from CANDIDATES list - never use IDs from AVOID_IDS.",
    "CRITICAL: Do not select the same track repeatedly - check previous suggestions.",
    "Prefer the SAME orchestra if provided; otherwise a close stylistic match.",
    "Consider the neighbors' BPM, energy, and key to minimize discontinuities.",
    "Select different tracks for chosenId and suggestions to provide variety.",
    "Return only JSON matching the output schema.",
  ].join(" "),
  outputType: ReplacementResult,
  model: "gpt-4o",
});

// Replacement options schema used for ranked list
const ReplacementOptions = z.object({
  tracks: z.array(z.string()).min(1).max(10), // candidate IDs
  notes: z.string().nullable(),
  warnings: z.array(z.string()).nullable(),
});


// ==================================================================
//                               HELPERS
// ==================================================================
function trackToCompactPlayable(t) {
  const abs = getAbsolutePath(t?.file);
  return {
    id: abs ? b64u.enc(abs) : (getId(t) || null),         // streamable id
    title: t?.tags?.title ?? t?.title ?? (abs ? abs.split(/[\\/]/).pop() : "Unknown"),
    artist: t?.tags?.artist ?? t?.artist ?? t?.metadata?.artist ?? null,
    album: t?.tags?.album ?? t?.album ?? null,
    BPM: bpmOf(t),
    Energy: energyOf(t),
    Key: t?.tags?.Key ?? t?.Key ?? null,
    camelotKey: keyToCamelot(t),
    absPath: abs || null,
    seconds: durationSec(t) || null,
  };
}
function interleaveWithCortinas(tandasResolved, cortinas) {
  const seq = [];
  let minutes = 0;
  let ci = 0;

  for (const td of tandasResolved) {
    const approxMin = Math.round((td.seconds || 0) / 60);

    // tanda item for UI
    seq.push({
      id: crypto.randomUUID(),
      type: "tanda",
      style: td.style,
      size: td.tracks.length,
      approxMinutes: approxMin,
      notes: td.notes ?? null,
      tracks: td.tracks.map(trackToCompactPlayable),
    });
    minutes += approxMin;

    // follow with a cortina (loop the list)
    if (cortinas.length) {
      const c = cortinas[ci % cortinas.length];
      ci++;
      seq.push({
        id: crypto.randomUUID(),
        type: "cortina",
        title: c?.title || "Cortina",
        streamId: c?.id || null,
        approxMinutes: 1,
      });
      minutes += 1;
    }
  }

  // if the very last item is a cortina, you can optionally drop it:
  if (seq.length && seq[seq.length - 1].type === "cortina") {
    // keep it if your UI expects one after each tanda; otherwise:
    // minutes -= 1;
    // seq.pop();
  }

  return { sequence: seq, totalMinutes: minutes };
}
function bpmOf(t) {
  const cands = [t?.BPM, t?.bpm, t?.audio?.bpm, t?.tags?.BPM, t?.tags?.tempoBPM, t?.tempoBPM];
  for (const v of cands) {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return Math.round(n * 10) / 10;
  }
  return null;
}

function energyOf(t) {
  return t?.tags?.Energy ?? t?.Energy ?? t?.audio?.energy ?? null;
}

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
  // if no time then assume typical length
  return 165;
}

function getAbsolutePath(file) {
  if (!file) return null;
  return file.absPath || file.path || file.fullPath || null;
}

function durationSec(t) {
  return (
    toSeconds(t?.audio?.duration) ||
    toSeconds(t?.format?.durationSec) || // many enriched tracks
    toSeconds(t?.duration) ||
    toSeconds(t?.durationMs) ||
    toSeconds(t?.length) ||
    0
  );
}

function getId(t) {
  return t?.id ?? t?.file?.id ?? getAbsolutePath(t?.file) ?? t?.path ?? t?.uri ?? null;
}

function getGenre(t) {
  const g = t?.tags?.genre ?? t?.genre ?? "";
  if (Array.isArray(g)) return (g[0] ?? "").trim();
  return String(g).trim();
}

function fmtClock(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function pickTrackFields(t) {
  const id = getId(t) ?? "";
  const title = t?.title ?? t?.tags?.title ?? t?.metadata?.title ?? "Unknown";
  const artist = t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? null;
  const genre = t?.tags?.genre ?? t?.genre ?? null;
  const BPM = bpmOf(t);
  const energy = t?.Energy ?? t?.energy ?? t?.audio?.energy ?? t?.tags?.Energy ?? null;
  const seconds = durationSec(t);
  const key = t?.camelotKey ?? t?.Key ?? t?.key ?? t?.tags?.camelotKey ?? null;
  const album = t?.album ?? t?.tags?.album ?? null;
  const artUrl = t.artUrl;
  const year = t.year;
  return { id, title, artist, genre, BPM, energy, seconds, key, album, artUrl, year};
}
function pickTrackFieldsForClient(t) {
  return {
    id: getId(t),
    title: t?.title ?? t?.tags?.title ?? t?.metadata?.title ?? "Unknown",
    artist: (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim(),
    seconds: durationSec(t),
    BPM: bpmOf(t),
    Energy: energyOf(t),
    Key: t?.Key ?? t?.key ?? t?.tags?.Key ?? null,
    camelotKey: keyToCamelot(t),
    artUrl: t?.artUrl ?? t?.tags?.coverUrl ?? null, // normalized by toCompactTrack
    year: t?.tags?.year
  };
}

function buildDisplayTimeline(resolvedTandas) {
  const timeline = [];
  let cursor = 0;
  for (let i = 0; i < resolvedTandas.length; i++) {
    const td = resolvedTandas[i];
    const tandaStart = cursor;
    let trackCursor = tandaStart;

    const tracks = td.tracks.map((tr, j) => {
      const trPlain = pickTrackFields(tr);
      const trLen = trPlain.seconds > 0 ? trPlain.seconds : Math.round(td.seconds / Math.max(1, td.tracks.length));
      const startSec = trackCursor;
      const endSec = trackCursor + trLen;
      trackCursor = endSec;

      return {
        index: j + 1,
        ...trPlain,
        startSec,
        endSec,
        startClock: fmtClock(startSec),
        endClock: fmtClock(endSec),
      };
    });

    const tandaEnd = tandaStart + td.seconds;

    timeline.push({
      index: i + 1,
      style: td.style,
      durationSec: td.seconds,
      startSec: tandaStart,
      endSec: tandaEnd,
      startClock: fmtClock(tandaStart),
      endClock: fmtClock(tandaEnd),
      notes: td.notes ?? null,
      tracks,
    });

    cursor = tandaEnd;
  }
  return timeline;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Key helpers (Camelot mapping)
const CAMELOT_ORDER = [
  "1A",
  "2A",
  "3A",
  "4A",
  "5A",
  "6A",
  "7A",
  "8A",
  "9A",
  "10A",
  "11A",
  "12A",
  "1B",
  "2B",
  "3B",
  "4B",
  "5B",
  "6B",
  "7B",
  "8B",
  "9B",
  "10B",
  "11B",
  "12B",
];
const KEY_TO_CAMELOT = {
  // minor (A)
  Am: "8A",
  Em: "9A",
  Bm: "10A",
  "F#m": "11A",
  "C#m": "12A",
  "G#m": "1A",
  "D#m": "2A",
  "A#m": "3A",
  Dm: "7A",
  Gm: "6A",
  Cm: "5A",
  Fm: "4A",
  Bbm: "3A",
  Ebm: "2A",
  Abm: "1A",
  // major (B)
  C: "8B",
  G: "9B",
  D: "10B",
  A: "11B",
  E: "12B",
  B: "1B",
  "F#": "2B",
  "C#": "3B",
  F: "7B",
  Bb: "6B",
  Eb: "5B",
  Ab: "4B",
  Db: "3B",
  Gb: "2B",
  Cb: "1B",
};

function keyToCamelot(track) {
  const cam = track?.camelotKey || track?.Camelot || track?.camelot || track?.tags?.camelotKey || null;
  if (cam && CAMELOT_ORDER.includes(cam)) return cam;
  const k = track?.Key || track?.key || track?.tags?.Key || null;
  if (k && KEY_TO_CAMELOT[k]) return KEY_TO_CAMELOT[k];
  return null;
}

function camelotDistance(k1, k2) {
  if (!k1 || !k2) return 99;
  const i = CAMELOT_ORDER.indexOf(k1);
  const j = CAMELOT_ORDER.indexOf(k2);
  if (i < 0 || j < 0) return 99;
  const diff = Math.abs(i - j);
  return Math.min(diff, 24 - diff);
}

// Build compact per-orchestra profiles
function buildOrchestraProfiles(tracks) {
  const byArtist = new Map();
  for (const t of tracks) {
    const artist = (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim();
    if (!byArtist.has(artist)) byArtist.set(artist, []);
    byArtist.get(artist).push(t);
  }
  const profiles = [];
  for (const [artist, arr] of byArtist.entries()) {
    const styles = new Set(arr.map(getGenre).filter(Boolean));
    const era = new Set(arr.map((x) => (x?.tags?.era ?? x?.era ?? null)).filter(Boolean));
    const bpms = arr
      .map((x) => x?.BPM ?? x?.bpm ?? x?.audio?.bpm ?? x?.tags?.BPM)
      .filter((v) => typeof v === "number" && isFinite(v));
    const energies = arr
      .map((x) => x?.Energy ?? x?.energy ?? x?.audio?.energy ?? x?.tags?.Energy)
      .filter((v) => typeof v === "number" && isFinite(v));
    const cams = arr.map(keyToCamelot).filter(Boolean);
    const secs = arr.map(durationSec).filter((v) => v > 0);
    const ids = arr.map(getId).filter(Boolean).slice(0, 30);

    const freq = {};
    for (const c of cams) freq[c] = (freq[c] || 0) + 1;
    const commonCamelot = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k);

    profiles.push({
      orchestra: artist,
      styles: Array.from(styles),
      eras: Array.from(era),
      bpmMedian: bpms.length ? Math.round(median(bpms)) : null,
      energyMedian: energies.length ? Math.round(median(energies) * 10) / 10 : null,
      commonCamelot,
      avgSeconds: secs.length ? Math.round(secs.reduce((s, x) => s + x, 0) / secs.length) : null,
      sampleIds: ids,
    });
  }
  return profiles;
}

// Get compatible styles for broadening search when replacement fails
function getCompatibleStyles(mainStyle) {
  const styleMap = {
    'tango': ['tango', 'vals', 'milonga'],
    'vals': ['vals', 'tango'],
    'milonga': ['milonga', 'tango'],
    'waltz': ['vals', 'tango'],
    'valz': ['vals', 'tango']
  };
  
  const normalized = mainStyle.toLowerCase();
  return styleMap[normalized] || [normalized];
}

// ---------- Normalization helpers (ID/path) ----------
const norm = (s) => {
  if (!s) return "";
  let x = String(s).trim().replace(/^file:\/\//i, "");
  try {
    x = decodeURIComponent(x);
  } catch {}
  return x.replace(/\\/g, "/").toLowerCase();
};
const stripExt = (p) => p.replace(/\.[a-z0-9]+$/i, "");
const matchKey = (s) => stripExt(norm(s));

// ensure we always have a Set<string> (normalized keys)
function toSet(maybeSetOrArray) {
  if (maybeSetOrArray instanceof Set) return new Set(Array.from(maybeSetOrArray).map(matchKey));
  if (Array.isArray(maybeSetOrArray)) return new Set(maybeSetOrArray.map(matchKey));
  return new Set();
}

function getIdSafe(t) {
  return t?.id ?? t?.file?.id ?? getAbsolutePath(t?.file) ?? t?.path ?? t?.uri ?? null;
}

function getStyleSet(t) {
  const styles =
    (Array.isArray(t?.styles) && t.styles.length ? t.styles
      : Array.isArray(t?.tags?.genre) ? t.tags.genre
      : t?.tags?.genre ? [t.tags.genre]
      : []);
  return new Set(styles.map((s) => String(s || "").trim().toLowerCase()));
}

function durationSecSafe(t) {
  const v =
    t?.tags?.durationSec ??
    t?.format?.durationSec ??
    t?.durationSec ??
    t?.duration ??
    t?.durationMs ??
    t?.length ??
    null;
  if (v == null) return 0;
  if (typeof v === "number" && isFinite(v)) {
    return v > 6000 ? Math.round(v / 1000) : Math.round(v);
  }
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

/** shortlist ≤ maxN candidates for a style, excluding used IDs; lightweight rows for the LLM */
function shortlistCandidates(style, library, usedIds, maxN = 80) {
  const usedNorm = toSet(usedIds);
  const want = String(style || "").trim().toLowerCase();

  const pool = library
    .filter((t) => {
      const g = Array.isArray(t?.tags?.genre) ? t.tags.genre : t?.tags?.genre ? [t.tags.genre] : [];
      return g.map((x) => String(x).toLowerCase()).includes(want);
    })
    .map((t) => {
      const id = getId(t);
      return {
        t,
        id,
        key: matchKey(id),
        sec: durationSec(t),
        energy: t?.Energy ?? t?.energy ?? t?.audio?.energy ?? t?.tags?.Energy ?? null,
      };
    })
    .filter((x) => x.id && !usedNorm.has(x.key) && x.sec >= 60 && x.sec <= 480)
  ;
  pool.sort(
    (a, b) => Math.abs((a.energy ?? 7) - 7) - Math.abs((b.energy ?? 7) - 7)
  );

  const chosen = pool.slice(0, maxN).map((x) => x.t);
  const slim = chosen.map((t) => ({
    id: getId(t),
    title: t.title ?? t?.tags?.title ?? t?.metadata?.title ?? "Unknown",
    artist: (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim(),
    seconds: durationSec(t) || null,
    bpm: t?.BPM ?? t?.bpm ?? t?.audio?.bpm ?? t?.tags?.BPM ?? t?.tags?.tempoBPM ?? null,
    energy: t?.Energy ?? t?.energy ?? t?.audio?.energy ?? t?.tags?.Energy ?? null,
    camelotKey: keyToCamelot(t),
  }));

  return { slim, chosenSet: new Set(slim.map((s) => matchKey(s.id))) };
}

/** Validate if a tanda has sufficient real tracks (not just placeholders) */
function isValidTanda(tracks, minRealTracks = 2) {
  const realTracks = tracks.filter(t => t.id !== null && t.title !== "replace this");
  return realTracks.length >= minRealTracks;
}

/** Get alternative orchestras for retry attempts with better diversity */
function getAlternativeOrchestras(profiles, excludeOrchestras = []) {
  const exclude = new Set(excludeOrchestras.filter(Boolean));
  const available = profiles.filter(p => !exclude.has(p.orchestra));
  
  // Calculate diversity score: balance between having enough tracks and not being overrepresented
  const withDiversityScores = available.map(p => {
    const trackCount = p.sampleIds?.length || 0;
    // Penalize orchestras with too many tracks to promote variety
    // Sweet spot: orchestras with 5-15 tracks get higher scores
    let diversityScore;
    if (trackCount < 3) {
      diversityScore = trackCount * 10; // Low penalty for few tracks
    } else if (trackCount <= 15) {
      diversityScore = 100 + (15 - trackCount) * 2; // Peak score for medium-sized orchestras
    } else {
      diversityScore = Math.max(20, 100 - (trackCount - 15) * 3); // Decreasing score for large orchestras
    }
    
    return {
      orchestra: p.orchestra,
      trackCount,
      diversityScore,
      profile: p
    };
  });
  
  // Sort by diversity score (higher is better), then by track count as tiebreaker
  return withDiversityScores
    .sort((a, b) => {
      if (Math.abs(a.diversityScore - b.diversityScore) < 5) {
        // If scores are close, prefer orchestras with adequate tracks (3+)
        return Math.max(3, b.trackCount) - Math.max(3, a.trackCount);
      }
      return b.diversityScore - a.diversityScore;
    })
    .slice(0, 8) // Increased from 5 to 8 alternatives for more variety
    .map(item => item.orchestra);
}

/** Ask the LLM to build one tanda from restricted candidates with retry logic */
async function planOneTandaWithRetry({
  style,
  size,
  remainingMinutes,
  usedIds,
  candidates,
  allStyleCandidates = null, // Broader candidate pool for broadening
  orchestra,
  prevKey,
  onLLMOutput = null,
  profiles = [], // Orchestra profiles for retry
  maxRetries = 3,
}) {
  const attempts = [];
  let lastResult = null;

  // First attempt with requested orchestra
  try {
    lastResult = await planOneTanda({
      style, size, remainingMinutes, usedIds, candidates, allStyleCandidates, orchestra, prevKey, onLLMOutput
    });
    attempts.push({ orchestra, result: lastResult });
    
    if (onLLMOutput) {
      onLLMOutput(`First attempt with ${orchestra || 'any orchestra'}: ${lastResult.trackIds.length} tracks\n`);
    }
  } catch (error) {
    if (onLLMOutput) {
      onLLMOutput(`First attempt failed: ${error.message}\n`);
    }
  }

  // If first attempt produced insufficient tracks, try alternatives
  const countReal = (r) => Array.isArray(r?.trackIds) ? r.trackIds.filter(id => id !== 'replace').length : 0;

  if (!lastResult || countReal(lastResult) < Math.max(1, size - 2)) {
    const alternativeOrchestras = getAlternativeOrchestras(profiles, [orchestra]);
    
    if (onLLMOutput) {
      onLLMOutput(`Insufficient tracks (${lastResult?.trackIds.length || 0}), trying alternative orchestras...\n`);
    }

    for (let i = 0; i < Math.min(maxRetries, alternativeOrchestras.length); i++) {
      const altOrchestra = alternativeOrchestras[i];
      
      try {
        const retryResult = await planOneTanda({
          style, size, remainingMinutes, usedIds, candidates, allStyleCandidates,
          orchestra: altOrchestra, prevKey, onLLMOutput
        });
        
        attempts.push({ orchestra: altOrchestra, result: retryResult });
        
        if (onLLMOutput) {
          onLLMOutput(`Retry ${i + 1} with ${altOrchestra}: ${retryResult.trackIds.length} tracks\n`);
        }

        // If this attempt is better, use it
        if (countReal(retryResult) > countReal(lastResult)) {
          lastResult = retryResult;
          if (onLLMOutput) {
            onLLMOutput(`✓ Better result found with ${altOrchestra}\n`);
          }
        }

        // If we have enough REAL tracks, stop retrying
        if (countReal(retryResult) >= size - 1) {
          break;
        }
      } catch (error) {
        if (onLLMOutput) {
          onLLMOutput(`Retry ${i + 1} with ${altOrchestra} failed: ${error.message}\n`);
        }
      }
    }
  }

  // Final fallback: try with no orchestra restriction
  if (!lastResult || countReal(lastResult) === 0) {
    if (onLLMOutput) {
      onLLMOutput(`Final fallback: trying with no orchestra restriction...\n`);
    }
    
    try {
      const fallbackResult = await planOneTanda({
        style, size, remainingMinutes, usedIds, candidates, allStyleCandidates,
        orchestra: null, prevKey, onLLMOutput
      });
      
      if (countReal(fallbackResult) > countReal(lastResult)) {
        lastResult = fallbackResult;
        if (onLLMOutput) {
          onLLMOutput(`✓ Fallback produced ${fallbackResult.trackIds.length} tracks\n`);
        }
      }
    } catch (error) {
      if (onLLMOutput) {
        onLLMOutput(`Fallback attempt failed: ${error.message}\n`);
      }
    }
  }

  return lastResult || { style, trackIds: [], notes: "No tracks found after retries", warnings: ["Empty tanda"] };
}

/** Ask the LLM to build one tanda from restricted candidates */
async function planOneTanda({
  style,
  size,
  remainingMinutes,
  usedIds,
  candidates,
  allStyleCandidates = null, // Broader candidate pool for broadening
  orchestra,
  prevKey,
  onLLMOutput = null, // Optional callback for streaming LLM output
}) {
  const wantStyle = String(style || "").trim();
  const wantSize = Number.isFinite(size) ? size : 4;
  const remainMin =
    Number.isFinite(remainingMinutes) ? Math.max(0, Math.floor(remainingMinutes)) : null;
  const orchText = (orchestra && String(orchestra).trim()) || "any orchestra";
  const usedSet = usedIds instanceof Set ? usedIds : new Set(usedIds || []);

  const lines = [
    `Plan ONE tanda of style=${wantStyle} with ${wantSize} tracks.`,
    `Use ONLY IDs from CANDIDATES.`,
    `Restrict to ORCHESTRA="${orchText}" if specified.`,
    `Do NOT use any ID from USED_IDS.`,
    `Prefer keys close to previous Camelot key ${prevKey}; avoid large changes.`,
    `Prefer typical key continuity within the tanda.`,
    `Try to keep total duration within the remaining time (~${remainMin} minutes).`,
    `If candidates are insufficient, return fewer tracks and add a warning.`,
    `JSON only.`,
  ].filter(Boolean);

  const prompt = lines.join("\n");
  const CAND_MAX = 80;
  
  // Filter candidates by orchestra if specified (create a copy to avoid mutating original)
  let filteredCandidates = Array.isArray(candidates) ? [...candidates] : [];
  
  console.log(`[PLAN ONE TANDA] Orchestra filtering: target="${orchestra}", total candidates=${filteredCandidates.length}`);
  if (onLLMOutput) {
    onLLMOutput(`🔍 Orchestra filtering: target="${orchestra}", total candidates=${filteredCandidates.length}\n`);
  }
  
  console.log(`[PLAN ONE TANDA] Orchestra check: orchestra="${orchestra}", condition=${orchestra && orchestra !== "any orchestra"}`);
  
  if (orchestra && orchestra !== "any orchestra") {
    console.log(`[PLAN ONE TANDA] ✅ Entering orchestra filtering for "${orchestra}"`);
    const normalizeOrchestra = (orch) => {
      if (!orch) return "";
      let normalized = String(orch).trim();
      
      // More gentle normalization - only remove common suffixes, preserve main name
      normalized = normalized
        .replace(/\s+O\.T\.\s+con\s+.*$/i, '') // Remove "O.T. con ..." part
        .replace(/\s+y\s+su\s+orquesta\s*.*$/i, '') // Remove "y su orquesta" part
        .replace(/\s+Y\s+Su\s*.*$/i, '') // Remove "Y Su" part
        .trim();
      
      // Ensure we don't return empty string unless input was empty
      return normalized || String(orch).trim();
    };
    
    const targetNorm = normalizeOrchestra(orchestra);
    
    console.log(`[PLAN ONE TANDA] Looking for normalized orchestra: "${targetNorm}"`);
    
    // Get unique orchestras from candidates - both original and normalized
    const orchestraInfo = [...new Set(filteredCandidates.map(t => {
      const candidateOrch = t?.tags?.artist ?? t?.artist ?? t?.orchestra ?? "";
      return candidateOrch;
    }).filter(Boolean))].slice(0, 10).map(orig => ({
      original: orig,
      normalized: normalizeOrchestra(orig)
    }));
    
    console.log(`[PLAN ONE TANDA] Available orchestras in candidates:`, orchestraInfo);
    
    if (onLLMOutput) {
      onLLMOutput(`🎯 Looking for normalized orchestra: "${targetNorm}"\n`);
      onLLMOutput(`Available orchestras: ${orchestraInfo.map(o => o.original).join(', ')}\n`);
      // Show sample candidate orchestras
      const sampleOrchs = filteredCandidates.slice(0, 5).map(t => {
        const candidateOrch = t.artist || t.orchestra || "";
        const candNorm = normalizeOrchestra(candidateOrch);
        return `"${candidateOrch}" -> "${candNorm}"`;
      });
      onLLMOutput(`Sample candidate orchestras: ${sampleOrchs.join(', ')}\n`);
    }
    
    console.log(`[PLAN ONE TANDA] Starting filter loop for ${filteredCandidates.length} candidates`);
    
    let checkCount = 0;
    let originalLength = filteredCandidates.length;
    
    filteredCandidates = filteredCandidates.filter(t => {
      const candidateOrch = t?.tags?.artist ?? t?.artist ?? t?.orchestra ?? "";
      const candNorm = normalizeOrchestra(candidateOrch);
      const isMatch = candNorm === targetNorm;
      
      // Debug first few matches/mismatches
      if (checkCount < 5) {
        console.log(`[PLAN ONE TANDA] Checking[${checkCount}]: "${candidateOrch}" -> "${candNorm}" vs "${targetNorm}" = ${isMatch}`);
      }
      checkCount++;
      
      return isMatch;
    });
    
    console.log(`[PLAN ONE TANDA] Filter completed: ${originalLength} -> ${filteredCandidates.length} candidates (checked ${checkCount} items)`);
    
    // For regular generation, if orchestra filtering results in too few candidates, broaden the filter
    // This is especially important when the candidate pool has been reduced by previous tandas
    if (filteredCandidates.length < Math.max(4, size || 4)) {
      const broaderCandidates = allStyleCandidates || candidates;
      console.log(`[PLAN ONE TANDA] ⚠️ Insufficient orchestra matches (${filteredCandidates.length}), broadening to use all ${broaderCandidates.length} style candidates for proper tanda generation`);
      filteredCandidates = broaderCandidates; // Use broader candidate pool for better AI generation
    }
    
    console.log(`[PLAN ONE TANDA] ✅ Filtered candidates for orchestra "${orchestra}": ${filteredCandidates.length} tracks found`);
    
    if (onLLMOutput) {
      onLLMOutput(`✅ Filtered candidates for orchestra "${orchestra}": ${filteredCandidates.length} tracks found\n`);
    }
    
    // If no tracks found for specific orchestra, fall back to all candidates
    if (filteredCandidates.length === 0) {
      if (onLLMOutput) {
        onLLMOutput(`⚠️ No tracks found for orchestra "${orchestra}", using all candidates\n`);
      }
      filteredCandidates = candidates;
    }
    console.log(`[PLAN ONE TANDA] ✅ Orchestra filtering completed for "${orchestra}"`);
  } else {
    console.log(`[PLAN ONE TANDA] ⚠️ Orchestra filtering skipped for "${orchestra}"`);
  }
  
  console.log(`[PLAN ONE TANDA] Final candidate count: ${filteredCandidates.length}`);
  const candSlim = filteredCandidates.slice(0, CAND_MAX);

  // Debug: log the first few candidates to see their structure
  if (onLLMOutput) {
    onLLMOutput(`\n--- DEBUG: Candidate structure (${candSlim.length} total) ---\n`);
    candSlim.slice(0, 3).forEach((cand, i) => {
      onLLMOutput(`Candidate ${i}: ID="${getId(cand)}", title="${cand.title}", artist="${cand.artist}"\n`);
    });
  }

  const items = [
    system("Follow the schema exactly. Never invent or repeat IDs. No prose."),
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        { type: "input_text", text: `USED_IDS:\n${JSON.stringify(Array.from(usedSet))}` },
        { type: "input_text", text: `ORCHESTRA:\n${orchText}` },
        { type: "input_text", text: `CANDIDATES:\n${JSON.stringify(candSlim)}` },
      ],
    },
  ];

  // Log the agent interaction if callback provided
  if (onLLMOutput) {
    onLLMOutput(`\n=== Planning ${wantStyle} Tanda (${wantSize} tracks) ===\n`);
    onLLMOutput(`Orchestra: ${orchText}\n`);
    onLLMOutput(`Remaining time: ~${remainMin} minutes\n`);
    onLLMOutput(`Previous key: ${prevKey || 'none'}\n`);
    onLLMOutput(`Candidates: ${candSlim.length} tracks\n`);
    onLLMOutput(`\n--- Agent Request ---\n${prompt}\n\n`);
  }

  const result = await run(nextTandaAgent, items, { maxTurns: 1 });
  const out = result.finalOutput; // zod-validated by NextTanda

  // Log the agent response if callback provided
  if (onLLMOutput) {
    onLLMOutput(`--- Agent Response ---\n`);
    onLLMOutput(`Style: ${out.style}\n`);
    onLLMOutput(`Selected tracks: ${out.tracks.length}\n`);
    if (out.notes) {
      onLLMOutput(`Notes: ${out.notes}\n`);
    }
    if (out.warnings && out.warnings.length > 0) {
      onLLMOutput(`Warnings: ${out.warnings.join(', ')}\n`);
    }
    onLLMOutput(`Track IDs: ${JSON.stringify(out.tracks, null, 2)}\n`);
    
    // Debug: check what orchestras the selected tracks actually belong to
    const selectedOrchestras = out.tracks.map(trackId => {
      const track = candSlim.find(t => getId(t) === trackId);
      return track ? (track.artist || track.orchestra || 'Unknown') : 'Not Found';
    });
    onLLMOutput(`Actual orchestras of selected tracks: ${JSON.stringify(selectedOrchestras)}\n\n`);
  }

  // Ensure we return the requested number of track IDs by padding with a
  // placeholder ID ("replace") when the agent couldn't provide enough.
  // Higher-level code will turn these placeholder IDs into placeholder
  // track objects so the tanda still has the correct length.
  const returnedTracks = Array.isArray(out.tracks) ? out.tracks.slice() : [];
  if (returnedTracks.length < wantSize) {
    const need = wantSize - returnedTracks.length;
    for (let i = 0; i < need; i++) returnedTracks.push("replace");
    out.warnings = out.warnings || [];
    out.warnings.push(`Padded ${need} placeholder track(s)`);
    if (onLLMOutput) onLLMOutput(`⚠️ Padded ${need} placeholder track(s) to reach ${wantSize} tracks\n`);
    console.log(`[PLAN ONE TANDA] ⚠️ Padded ${need} placeholder track(s) to reach ${wantSize} tracks`);
  }

  return {
    style: out.style,
    trackIds: returnedTracks,
    notes: out.notes ?? null,
    warnings: out.warnings ?? null,
  };
}
// -------- base64url helper (needed by trackToCompactPlayable) -------
const b64u = {
  enc: (s) => Buffer.from(String(s)).toString("base64url"),
  dec: (s) => Buffer.from(String(s), "base64url").toString(),
};

function makePlaceholderTrack(style) {
  return {
    // keep id null so it won’t try to stream
    id: null,
    title: "replace this",
    artist: null,
    album: null,
    BPM: null,
    Energy: null,
    Key: null,
    camelotKey: null,
    seconds: 0,
    placeholder: true,
    style,
  };
}
/** Use the LLM to rank orchestras for the next tanda */
async function suggestNextOrchestras({ style, prevKey, recentOrchestras, profiles, K = 7, role = null, onLLMOutput = null }) {
  const relevant = profiles
    .filter(p => p.styles.includes(style))
    .map(p => ({
      orchestra: p.orchestra,
      eras: p.eras,
      bpmMedian: p.bpmMedian,
      energyMedian: p.energyMedian,
      commonCamelot: p.commonCamelot,
      avgSeconds: p.avgSeconds,
    }))
    .slice(0, 200);

  const roleHint = role ? `\nRole focus: "${role}". Bias toward orchestras whose peak recordings match the target era for that role.` : "";

  const prompt = [
    `Style to follow: ${style}`,
    `Previous tanda ending key (Camelot): ${prevKey ?? "n/a"}`,
    `Diversity requirement: avoid repeating any orchestra that appeared in the last 2 tandas unless musically necessary.`,
    `Prefer variety across eras/energy/BPM while staying coherent for dancers.`,
    `Return top ${K} DISTINCT orchestras (no duplicates) with short reasons (≤160 chars).`,
    roleHint,
    `JSON only.`,
  ].join("\n");

  // Log the orchestra selection process if callback provided
  if (onLLMOutput) {
    onLLMOutput(`\n--- Orchestra Selection Agent ---\n`);
    onLLMOutput(`Style: ${style}\n`);
    onLLMOutput(`Previous key: ${prevKey || 'none'}\n`);
    onLLMOutput(`Recent orchestras to avoid: ${recentOrchestras.join(', ') || 'none'}\n`);
    onLLMOutput(`Role focus: ${role || 'none'}\n`);
    onLLMOutput(`Considering ${relevant.length} relevant orchestras\n\n`);
  }

  const items = [
    system("Return only schema-valid JSON. Be concise."),
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        { type: "input_text", text: `RECENT_ORCHESTRAS:\n${JSON.stringify(recentOrchestras)}` },
        { type: "input_text", text: `ORCHESTRA_PROFILES:\n${JSON.stringify(relevant)}` },
      ],
    },
  ];

  const result = await run(orchestraAgent, items, { maxTurns: 1 });
  
  // Log the orchestra selection result
  if (onLLMOutput && result.finalOutput?.suggestions) {
    onLLMOutput(`--- Orchestra Agent Response ---\n`);
    result.finalOutput.suggestions.forEach((suggestion, i) => {
      onLLMOutput(`${i + 1}. ${suggestion.orchestra} - ${suggestion.reason || 'No reason provided'}\n`);
    });
    onLLMOutput(`\n`);
  }
  
  return result.finalOutput;
}


function summarize(resolvedTandas, minutesRequested) {
  const minutesPlanned = Math.round(
    resolvedTandas.reduce((s, td) => s + td.seconds, 0) / 60
  );
  const byStyle = resolvedTandas.reduce((acc, td) => {
    acc[td.style] = (acc[td.style] || 0) + 1;
    return acc;
  }, {});
  const trackCount = resolvedTandas.reduce((s, td) => s + td.tracks.length, 0);
  const totalTrackSecs = resolvedTandas.reduce(
    (s, td) => s + td.tracks.reduce((ss, tr) => ss + durationSec(tr), 0),
    0
  );
  const avgTrackLenSec = Math.round(totalTrackSecs / Math.max(1, trackCount));

  return {
    minutesRequested,
    minutesPlanned,
    tandaCount: resolvedTandas.length,
    byStyle,
    trackCount,
    avgTrackLenSec,
  };
}

// ==================================================================
//                        MAIN ROUTES REGISTRATION
// ==================================================================


function shortlistForReplacement({ style, orchestra, workingSet, avoidIdsSet, maxN = 80 }) {
  const avoid = toSet(avoidIdsSet); // normalized set

  const pool = workingSet
    .filter(
      (t) =>
        getGenre(t) === style &&
        ((t?.artist ?? t?.metadata?.artist ?? "Unknown").trim() === orchestra) &&
        !avoid.has(matchKey(getId(t)))
    )
    .map((t) => ({
      id: getId(t),
      title: t.tags?.title ?? t.title ?? "Unknown",
      artist: (t?.artist ?? t?.metadata?.artist ?? "Unknown").trim(),
      seconds: durationSec(t) || null,
      bpm: bpmOf(t),
      energy: energyOf(t),
      camelotKey: keyToCamelot(t),
    }));

  // bias toward mid energy
  pool.sort((a, b) => {
    const da = Math.abs((a.energy ?? 7) - 7);
    const db = Math.abs((b.energy ?? 7) - 7);
    return da - db;
  });

  return pool.slice(0, maxN);
}
function countAvailableByOrchestra({ workingSet, style, isUsed }) {
  const map = new Map();
  for (const t of workingSet) {
    const g = Array.isArray(t?.tags?.genre) ? t.tags.genre[0] : t?.tags?.genre;
    if (g !== style) continue;
    const id = getId(t);
    if (!id || isUsed(id)) continue;
    const orch = (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim();
    map.set(orch, (map.get(orch) || 0) + 1);
  }
  return map; // Map<string, number>
}

/**
 * Roulette-wheel sample (without replacement) over suggestions,
 * weighting against recent repetitions and for availability.
 *
 * weight = avail * jitter * decay(recentCount)
 *   - avail: #unused tracks available for this style/orchestra
 *   - jitter: random factor in [0.85, 1.15] to avoid deterministic ties
 *   - decay:  1 / (1 + recentCountWithinWindow)
 */
function pickOrchestraWeighted({
  suggestions,          // [{orchestra, reason}, ...] from LLM
  availabilityMap,      // Map<string, number>
  recentOrchestras,     // array of strings (most recent at end)
  sizeTarget = 4,
  windowLen = 2,        // penalize repeats in last N tandas
}) {
  if (!Array.isArray(suggestions) || !suggestions.length) return null;

  // Compute recent counts within window
  const window = recentOrchestras.slice(-windowLen);
  const recentCount = (orch) => window.filter(o => o === orch).length;

  // Build weighted bag
  const bag = [];
  for (const s of suggestions) {
    const orch = String(s.orchestra || "").trim();
    const avail = availabilityMap.get(orch) || 0;
    if (avail < sizeTarget) continue; // must support the tanda size
    const rc = recentCount(orch);     // 0, 1, 2...
    const jitter = 0.85 + 0.30 * Math.random();
    
    // Apply diversity bonus: reduce dominance of orchestras with too many tracks
    let diversityMultiplier = 1.0;
    if (avail <= 15) {
      diversityMultiplier = 1.2; // 20% bonus for medium-sized orchestras
    } else if (avail > 30) {
      diversityMultiplier = 0.6; // 40% penalty for orchestras with many tracks
    }
    
    const weight = avail * jitter * (1 / (1 + rc)) * diversityMultiplier;
    if (weight > 0) bag.push({ orch, weight });
  }

  if (!bag.length) return null;

  // Roulette-wheel pick
  const total = bag.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of bag) {
    if ((r -= x.weight) <= 0) return x.orch;
  }
  return bag[bag.length - 1].orch; // fallback
}
// ==================================================================
//                            BULK GENERATE
// ==================================================================
export async function listCortinas(arg = undefined) {
  // Accept:
  //   - number  -> tandasCount
  //   - { tandasCount?: number, includeFinal?: boolean, shuffle?: boolean, genres?: string|string[] }
  //   - undefined -> return all matching items (using defaults)
  let tandasCount = null;
  let includeFinal = false;   // false -> return N-1 cortinas for N tandas (between blocks)
  let shuffle = true;
  let genresIn = null;

  if (typeof arg === "number") {
    tandasCount = arg;
  } else if (arg && typeof arg === "object") {
    tandasCount  = Number.isFinite(arg.tandasCount) ? arg.tandasCount : null;
    includeFinal = !!arg.includeFinal;
    shuffle      = arg.shuffle !== false; // default true
    genresIn     = arg.genres ?? arg.cortinaGenres ?? null; // support either key
  }

  // Normalize desired genres (case-insensitive tokens)
  const DEFAULT_GENRES = ["jazz", "swing", "country", "rock", "pop", "electro", "lounge", "blues"];
  const desiredGenres = normalizeGenreList(genresIn ?? DEFAULT_GENRES); // Set<string>

  // Build candidate pool from LIBRARY
  // A "cortina candidate" is any playable track whose genre tokens intersect desiredGenres,
  // and which is *not* a tango/vals/milonga dance track (to avoid collisions with tandas).
  const isNonDance = (tokens) => !tokens.has("tango") && !tokens.has("vals") && !tokens.has("milonga");

  const poolRaw = (Array.isArray(LIBRARY) ? LIBRARY : [])
    .filter(Boolean)
    .map((t) => ({ t, id: safeGetId(t) }))
    .filter(({ id }) => !!id);

  // Extract tokens once per track
  const poolTokenized = poolRaw.map(({ t, id }) => {
    const tokens = genreTokens(t); // Set<string>
    return { t, id, tokens };
  });

  let pool = poolTokenized
    .filter(({ tokens }) => intersects(tokens, desiredGenres) && isNonDance(tokens))
    .map(({ t, id }) => toCortinaRow(t, id));

  // Fallback: if nothing matches requested genres, relax to ANY non-dance track
  if (!pool.length) {
    pool = poolTokenized
      .filter(({ tokens }) => isNonDance(tokens))
      .map(({ t, id }) => toCortinaRow(t, id));
  }

  // If still nothing, return empty
  if (!pool.length) return [];

  // If no desired tandas count was provided, return the whole (optionally shuffled) set
  if (tandasCount == null) {
    return (shuffle ? shuffled(pool) : pool);
  }

  // “Right number of cortinas”: between tandas
  const target = includeFinal ? Math.max(0, tandasCount) : Math.max(0, tandasCount - 1);
  if (target === 0) return [];

  // De-duplicate by id/title (defensive)
  pool = dedupeBy(pool, (x) => `${x.id}::${x.title}`);

  const base = shuffle ? shuffled(pool) : pool;

  // If we have enough, slice; otherwise, cycle
  if (target <= base.length) return base.slice(0, target);

  const out = [];
  for (let i = 0; i < target; i++) out.push(base[i % base.length]);
  return out;

  // ---- helpers ----
  function normalizeGenreList(g) {
    const arr = Array.isArray(g) ? g : typeof g === "string" ? g.split(/[,\|]/) : [];
    return new Set(arr.map((s) => String(s || "").toLowerCase().trim()).filter(Boolean));
  }

  function genreTokens(t) {
    // Collect any plausible genre-ish fields and split to tokens
    const raw = []
      .concat(readMaybeArray(t?.tags?.genre))
      .concat(readMaybeArray(t?.metadata?.genre))
      .concat(readMaybeArray(t?.genre))
      .concat(readMaybeArray(t?.styles)); // sometimes styles carry useful hints

    const tokens = new Set();
    for (const v of raw) {
      const s = String(v || "").toLowerCase();
      if (!s) continue;
      // split on common separators
      s.split(/[\/,;|]+/).forEach((w) => {
        const z = w.trim();
        if (z) tokens.add(z);
      });
    }
    return tokens;
  }

  function readMaybeArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return [v];
  }

  function intersects(aSet, bSet) {
    for (const x of aSet) if (bSet.has(x)) return true;
    return false;
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function dedupeBy(arr, keyFn) {
    const seen = new Set();
    const out = [];
    for (const it of arr) {
      const k = keyFn(it);
      if (!seen.has(k)) { seen.add(k); out.push(it); }
    }
    return out;
  }

  function safeGetId(t) {
    // getId(t) should already return either a base64url or a path; both are fine
    try { return getId(t); } catch { /* no-op */ }
    // fallbacks, mirroring other code paths
    return (
      getAbsolutePath(t?.file) ||
      t?.id ||
      t?.file?.id ||
      t?.file?.wavPath ||
      null
    );
  }

  function toCortinaRow(t, id) {
    const seconds = durationSec(t) || 60;
    const mins = Math.max(1, Math.round(seconds / 60));
    return {
      id,
      title: (t?.title ?? t?.tags?.title ?? t?.metadata?.title ?? "Cortina").trim(),
      artist: t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? null,
      singer: t?.tags?.singer ?? t?.metadata?.singer ?? null,
      seconds,
      approxMinutes: mins,
    };
  }
}
  
export function registerAgentRoutes(app) {
  app.post("/api/agent/bulkGenerate", async (req, res) => {
    try {
      // ----------- Inputs and defaults -----------
      const minutes   = Number(req.body?.minutes ?? 180);
      const catalogIn = req.body?.catalog;
      const pattern   = Array.isArray(req.body?.pattern)
        ? req.body.pattern
        : ["Tango", "Tango", "Vals", "Tango", "Tango", "Milonga"];

      const sizesIn = req.body?.sizes || { Tango: 4, Vals: 3, Milonga: 3 };
      const sizes = {
        Tango:   sizesIn.Tango   ?? 4,
        Vals:    sizesIn.Vals    ?? 3,
        Milonga: sizesIn.Milonga ?? 3,
      };

      if (!catalogIn || !Array.isArray(catalogIn.tracks)) {
        throw new Error("Missing catalog.tracks");
      }

      // ----------- Restrict LIBRARY to catalog IDs & merge overrides -----------
      const { ids, overrides } = extractCatalogPathsAndStyles({ tracks: catalogIn.tracks });

      // Build BOTH exact and extensionless normalized key sets
      const idKeysExact = new Set([...ids].map(norm));             // "/a/b/foo.wav"
      const idKeysNoExt = new Set([...idKeysExact].map(stripExt)); // "/a/b/foo"

      const workingSet = LIBRARY
        .filter((t) => {
          const cands = [
            getAbsolutePath(t?.file),
            t?.id,
            t?.file?.id,
            t?.file?.wavPath,
          ].filter(Boolean);
          for (const raw of cands) {
            const n  = norm(raw);   // exact normalized (case-insensitive)
            const ne = stripExt(n); // extensionless
            if (idKeysExact.has(n) || idKeysNoExt.has(ne)) return true;
          }
          return false;
        })
        .map((t) => {
          const k1 = getAbsolutePath(t?.file);
          const k2 = getId(t);
          return mergeStylesIntoTrack(t, overrides.get(k1) || overrides.get(k2));
        });

      if (!workingSet.length) {
        // Helpful debug samples if nothing matches
        const sampleCatalog = [...idKeysExact].slice(0, 3);
        const sampleLib = LIBRARY.slice(0, 5)
          .map(x => getAbsolutePath(x?.file) || x?.id || x?.file?.id || x?.file?.wavPath)
          .filter(Boolean)
          .map(norm);
        console.warn("[/api/agent/bulkGenerate] 0 matches. sample catalog keys:", sampleCatalog);
        console.warn("[/api/agent/bulkGenerate] sample library keys:", sampleLib);
        throw new Error("None of the catalog tracks matched the library");
      }

      // ----------- Fast lookups + orchestra profiles -----------
      const libById        = new Map(workingSet.map((t) => [getId(t), t]));
      const libByNormKey   = new Map(workingSet.map((t) => [stripExt(norm(getId(t))), t]));
      const resolveByAnyId = (id) => libById.get(id) || libByNormKey.get(stripExt(norm(id))) || null;

      const profiles = buildOrchestraProfiles(workingSet);

      // ----------- Planning loop (orchestra-aware) -----------
      // Track used IDs with case/extension tolerance
      const used     = new Set();                               // normalized, extensionless
      const markUsed = (id) => used.add(stripExt(norm(id)));
      const isUsed   = (id) => used.has(stripExt(norm(id)));

      const tandasResolved = [];
      let remainingSeconds = minutes * 60;
      const recentOrchestras = [];
      let prevKey = null; // Camelot of the last played track

      for (const style of pattern) {
        if (remainingSeconds <= 60) break;

        const sizeTarget =
          style === "Tango"   ? sizes.Tango   :
          style === "Vals"    ? sizes.Vals    :
          style === "Milonga" ? sizes.Milonga : 3;

        let tandaMade = false;

        // ---- 1) Ask LLM to rank orchestras + weighted randomized pick
        let targetOrchestra = null;
        try {
          const rank = await suggestNextOrchestras({
            style,
            prevKey,
            recentOrchestras: recentOrchestras.slice(-2),
            profiles,
            K: 7, // slightly larger candidate set
          });

          // Build availability (unused tracks per orchestra for this style)
          const availabilityMap = countAvailableByOrchestra({
            workingSet,
            style,
            isUsed,
          });

          // Weighted random pick that penalizes repeats in the last 2 tandas
          targetOrchestra = pickOrchestraWeighted({
            suggestions: rank?.suggestions || [],
            availabilityMap,
            recentOrchestras,
            sizeTarget,
            windowLen: 2,
          });

          // Fallback: if weighted pick failed, choose any orchestra with enough availability,
          // preferring those NOT in the recent window, then randomize within that subset.
          if (!targetOrchestra) {
            const window = new Set(recentOrchestras.slice(-2));
            const eligible = [...availabilityMap.entries()]
              .filter(([orch, avail]) => avail >= sizeTarget);
            const nonRecent = eligible.filter(([orch]) => !window.has(orch));
            const pool = (nonRecent.length ? nonRecent : eligible);
            if (pool.length) {
              const i = Math.floor(Math.random() * pool.length);
              targetOrchestra = pool[i][0];
            }
          }
          

          // Try orchestra-constrained path first
          if (targetOrchestra) {
            const candidatesAll = workingSet.filter((t) =>
              (Array.isArray(t?.tags?.genre) ? t.tags.genre[0] : t?.tags?.genre) === style &&
              (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim() === targetOrchestra &&
              !isUsed(getId(t))
            );

            if (candidatesAll.length > 0) {
              const candidates = candidatesAll.slice(0, 200).map((t) => ({
                id: getId(t),
                title: t.title ?? t?.tags?.title ?? t?.metadata?.title ?? "Unknown",
                artist: (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim(),
                seconds: durationSec(t) || null,
                bpm: t?.BPM ?? t?.bpm ?? t?.audio?.bpm ?? t?.tags?.BPM ?? t?.tags?.tempoBPM ?? null,
                energy: t?.Energy ?? t?.energy ?? t?.audio?.energy ?? t?.tags?.Energy ?? null,
                camelotKey: keyToCamelot(t),
              }));

              // Also prepare broader candidate pool for broadening if needed
              const allStyleCandidates = workingSet.filter((t) =>
                (Array.isArray(t?.tags?.genre) ? t.tags.genre[0] : t?.tags?.genre) === style &&
                !isUsed(getId(t))
              ).map((t) => ({
                id: getId(t),
                title: t.title ?? t?.tags?.title ?? t?.metadata?.title ?? "Unknown",
                artist: (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim(),
                seconds: durationSec(t) || null,
                bpm: t?.BPM ?? t?.bpm ?? t?.audio?.bpm ?? t?.tags?.BPM ?? t?.tags?.tempoBPM ?? null,
                energy: t?.Energy ?? t?.energy ?? t?.audio?.energy ?? t?.tags?.Energy ?? null,
                camelotKey: keyToCamelot(t),
              }));

              const next = await planOneTandaWithRetry({
                style,
                size: sizeTarget,
                remainingMinutes: Math.floor(remainingSeconds / 60),
                usedIds: used, // Set is fine; we normalize checks via isUsed/markUsed
                candidates,
                allStyleCandidates, // Add broader candidate pool for broadening
                orchestra: targetOrchestra,
                prevKey,
                onLLMOutput,
                profiles, // Pass orchestra profiles for retry logic
              });

              const chosenTracks = [];
              for (const id of next.trackIds) {
                if (isUsed(id)) continue;
                const tr = resolveByAnyId(id);
                const trOrch = (tr?.artist ?? tr?.tags?.artist ?? tr?.metadata?.artist ?? "Unknown").trim();
                if (tr && trOrch === targetOrchestra) {
                  chosenTracks.push(tr);
                  markUsed(getId(tr));
                }
              }
              // Pad with placeholders if we didn’t reach sizeTarget
              if (chosenTracks.length < sizeTarget) {
                const need = sizeTarget - chosenTracks.length;
                for (let i = 0; i < need; i++) {
                  chosenTracks.push(makePlaceholderTrack(style));
                }
              }

              let tandaSeconds = chosenTracks.reduce((s, tr) => s + durationSec(tr), 0);
              if (tandaSeconds <= 0) tandaSeconds = 180 * chosenTracks.length; // fallback estimate

              // Validate tanda has sufficient real tracks
              const realTrackCount = chosenTracks.filter(t => t.id !== null && t.title !== "replace this").length;
              
              if (onLLMOutput) {
                send({ type: "debug", message: `Tanda validation: ${realTrackCount}/${chosenTracks.length} real tracks` });
              }

              if (chosenTracks.length > 0 && tandaSeconds > 0 && tandaSeconds <= remainingSeconds + 30 && realTrackCount >= 1) {
                tandasResolved.push({
                  style,
                  tracks: chosenTracks,
                  seconds: tandaSeconds,
                  notes: next.notes ?? `Orchestra: ${targetOrchestra} (${realTrackCount} real tracks)`,
                });

                remainingSeconds -= tandaSeconds;
                recentOrchestras.push(targetOrchestra);
                const lastTrack = chosenTracks[chosenTracks.length - 1];
                const lk = keyToCamelot(lastTrack);
                if (lk) prevKey = lk;
                tandaMade = true;
                
                if (onLLMOutput) {
                  send({ type: "success", message: `✓ Created ${style} tanda with ${realTrackCount} real tracks` });
                }
              } else if (realTrackCount === 0) {
                if (onLLMOutput) {
                  send({ type: "warning", message: `⚠ Tanda has no real tracks, will retry with different orchestra` });
                }
              }
            }
          }
        } catch {
          // ranking agent failed; fall through to style-only path
        }

        // ---- 2) Style-only Agent fallback if no tanda yet
        if (!tandaMade) {
          const { slim: styleOnlyCandidates } = shortlistCandidates(style, workingSet, used, 80);
          styleOnlyCandidates.sort((a, b) =>
            scoreTrackByRole(resolveByAnyId(b.id), role, []) -
            scoreTrackByRole(resolveByAnyId(a.id), role, [])
          );

          
          if (styleOnlyCandidates.length > 0) {
            const next = await planOneTandaWithRetry({
              style,
              size: sizeTarget,
              remainingMinutes: Math.floor(remainingSeconds / 60),
              usedIds: used,
              candidates: styleOnlyCandidates,
              allStyleCandidates: styleOnlyCandidates, // Same as candidates for fallback
              orchestra: null,
              prevKey,
              onLLMOutput,
              profiles, // Pass orchestra profiles for retry logic
            });

            const chosenTracks = [];
            for (const id of next.trackIds) {
              if (isUsed(id)) continue;
              const tr = resolveByAnyId(id);
              if (tr) {
                chosenTracks.push(tr);
                markUsed(getId(tr));
              }
            }
            // Pad with placeholders if we didn’t reach sizeTarget
            if (chosenTracks.length < sizeTarget) {
              const need = sizeTarget - chosenTracks.length;
              for (let i = 0; i < need; i++) {
                chosenTracks.push(makePlaceholderTrack(style));
              }
            }
            const tandaSeconds = chosenTracks.reduce((s, tr) => s + durationSec(tr), 0);
            const realTrackCount = chosenTracks.filter(t => t.id !== null && t.title !== "replace this").length;
            
            if (onLLMOutput) {
              send({ type: "debug", message: `Style fallback validation: ${realTrackCount}/${chosenTracks.length} real tracks` });
            }
            
            if (chosenTracks.length > 0 && tandaSeconds > 0 && tandaSeconds <= remainingSeconds + 30 && realTrackCount >= 1) {
              tandasResolved.push({
                style,
                tracks: chosenTracks,
                seconds: tandaSeconds,
                notes: next.notes ?? `(Style-only fallback: ${realTrackCount} real tracks)`,
              });

              remainingSeconds -= tandaSeconds;
              const lastTrack = chosenTracks[chosenTracks.length - 1];
              const lk = keyToCamelot(lastTrack);
              if (lk) prevKey = lk;
            }
          }
        }

        if (remainingSeconds <= 0) break;
      } // end for(pattern)

      // ----------- Build client-friendly plan blocks (same shape UI expects) -----------
      const tandaBlocks = tandasResolved.map(td => {
        const approxMinutes = Math.max(1, Math.round((td.seconds || 0) / 60));
        return {
          type: "tanda",
          style: td.style,
          size: td.tracks.length,
          approxMinutes,
          // IMPORTANT: compact rows for UI (id/title/artist/BPM/Energy/key/seconds)
          tracks: td.tracks.map(tr => ({
            id: getId(tr),
            title: tr.title ?? tr?.tags?.title ?? tr?.metadata?.title ?? "Unknown",
            artist: (tr.artist ?? tr?.tags?.artist ?? tr?.metadata?.artist ?? "Unknown").trim(),
            BPM: bpmOf(tr),                    // <- ensures BPM shows up
            Energy: energyOf(tr),
            Key: tr?.Key ?? tr?.tags?.Key ?? null,
            camelotKey: keyToCamelot(tr),
            seconds: durationSec(tr),
          })),
        };
      });

      // (Optional) add simple 1-min cortinas between tandas to mirror deterministic planner
      // e.g., 10 tandas, want 9 cortinas, favor jazz/swing:
      const cortinas = await listCortinas({ tandasCount: 10, includeFinal: false, genres: ["jazz", "swing"] });

      const planBlocks = [];
      for (let i = 0; i < tandaBlocks.length; i++) {
        planBlocks.push(tandaBlocks[i]);
        const c = cortinas.length ? cortinas[i % cortinas.length] : null;
        if (i < tandaBlocks.length - 1) {
          planBlocks.push({
            type: "cortina",                  // keep type for UI controls
            style: "Cortina",                 // optional, harmonizes with tanda header
            size: 1,
            approxMinutes: c?.approxMinutes ?? 1,
            tracks: [{
              id: c?.id || null,
              title: c?.title || "Cortina",
              artist: c?.artist ?? c?.singer ?? null,
              BPM: null,
              Energy: null,
              Key: null,
              camelotKey: null,
              seconds: Number.isFinite(c?.seconds)
                ? c.seconds
                : Math.round((c?.approxMinutes ?? 1) * 60),
              artUrl : artUrl,
              year: year
            }],
            // keep these for legacy buttons/handlers if you want
            streamId: c?.id || null,
            artist: c?.artist ?? null,
            singer: c?.singer ?? null,
          });
        }
      }

      // ----------- Display helpers (timeline/summary) -----------
      const timeline = buildDisplayTimeline(tandasResolved);
      const summary  = summarize(tandasResolved, minutes);

      // ----------- Final response (match what index.html expects) -----------
      return res.json({
        model: {
          tandas: tandasResolved.map(t => ({ style: t.style, tracks: t.tracks.map(getId) })),
          cortinas: null,
          warnings: [],
        },
        plan: { tandas: planBlocks, cortinas, warnings: [] }, // compact blocks for the UI
        display: { timeline, summary },
        used: {
          minutesRequested: minutes,
          minutesPlanned: Math.round(tandasResolved.reduce((s, td) => s + td.seconds, 0) / 60),
          tracksProvided: (req.body?.catalog?.tracks || []).length,
          tracksMatched:  tandasResolved.reduce((s, td) => s + td.tracks.length, 0),
        },
        source: "gpt-4o/agents (bulk, orchestra-aware)",
      });
    } catch (e) {
      const msg = e?.message || String(e);
      return res.status(422).json({
        error: "agent_planning_failed",
        message: msg,
      });
    }
  });

  // ==================================================================
  //                           REPLACEMENT ROUTE
  // ==================================================================

  app.post("/api/agent/replace", async (req, res) => {
    try {
      // 1) Inputs
      const {
        catalog,
        style,
        orchestra,           // same-orchestra preference (click)
        position,
        neighbors,
        avoidIds = [],
        previouslySelected = [], // Track previously selected tracks to avoid repetition
        topK = 6,
        homogenize = false,  // ← NEW: Shift-click signal
      } = req.body || {};
      if (!catalog?.tracks?.length) return res.status(422).json({ error: "Missing catalog.tracks" });
      if (!style) return res.status(400).json({ error: "Missing style" });

      const avoid = toSet(avoidIds);
      const previouslySelectedSet = toSet(previouslySelected || []);
      const wantStyle = String(style).trim().toLowerCase();
      
      // Debug logging for unknown tracks
      console.log(`\n=== REPLACEMENT REQUEST DEBUG ===`);
      console.log(`Style: ${style} (want: ${wantStyle})`);
      console.log(`Orchestra: ${orchestra || 'none'}`);
      console.log(`Position: ${JSON.stringify(position)}`);
      console.log(`Raw avoidIds:`, avoidIds);
      console.log(`Normalized avoid set:`, Array.from(avoid));
      console.log(`Raw previouslySelected:`, previouslySelected);
      console.log(`Catalog tracks received:`, catalog?.tracks?.length || 0);
      
      // Detect if we need to broaden search (same track selected repeatedly)
      const needsBroadening = previouslySelected && previouslySelected.length > 0;

      // 2) Restrict LIBRARY to catalog and merge overrides (normalized)
      //==============================================
      const { ids, idsNoExt, overrides } = extractCatalogPathsAndStyles(catalog);

      // quick membership tests
      const keysExact  = new Set(ids);        // normalized exact
      const keysNoExt  = new Set(idsNoExt);   // normalized extensionless

      const workingSet = LIBRARY
        .filter((t) => {
          const cands = [
            getAbsolutePath(t?.file),
            t?.id,
            t?.file?.id,
            t?.file?.wavPath,
            t?.path,
            t?.uri,
          ].filter(Boolean);

          for (const raw of cands) {
            const n  = norm(raw);
            const ne = stripExt(n);
            if (keysExact.has(n) || keysNoExt.has(ne)) return true;
          }
          return false;
        })
        .map((t) => {
          // attach any catalog-provided styles/tags, tolerant to exact or extensionless
          const kExact  = norm(getAbsolutePath(t?.file) || t?.id || t?.file?.id || t?.file?.wavPath || "");
          const kNoExt  = stripExt(kExact);
          const ov      = overrides.get(kExact) || overrides.get(kNoExt) || null;
          return mergeSlotsAndTagsIntoTrack(t, ov);  // see §3
        });

      if (!workingSet.length) {
        // Enhanced debugging for catalog/library mismatch
        console.warn("\n=== CATALOG/LIBRARY MISMATCH DEBUG ===");
        console.warn("Catalog tracks received:", catalog?.tracks?.length || 0);
        console.warn("Library tracks loaded:", LIBRARY.length);
        
        const sampleCatalog = Array.from(keysExact).slice(0, 5);
        const sampleLib = LIBRARY.slice(0, 5)
          .map(x => getAbsolutePath(x?.file) || x?.id || x?.file?.id || x?.file?.wavPath)
          .filter(Boolean)
          .map(norm);
        
        console.warn("Sample catalog keys (normalized):", sampleCatalog);
        console.warn("Sample library keys (normalized):", sampleLib);
        
        // Show first few catalog tracks in detail
        console.warn("First few catalog tracks:");
        for (let i = 0; i < Math.min(3, catalog?.tracks?.length || 0); i++) {
          const t = catalog.tracks[i];
          console.warn(`  ${i}: id="${t.id}" file="${JSON.stringify(t.file)}" title="${t.title}"`);
        }
        
        // Show raw format differences
        if (catalog?.tracks?.length > 0) {
          const firstCatalogTrack = catalog.tracks[0];
          console.warn("First catalog track structure:", {
            id: firstCatalogTrack.id,
            file: firstCatalogTrack.file,
            title: firstCatalogTrack.title,
            artist: firstCatalogTrack.artist
          });
        }
        
        if (LIBRARY.length > 0) {
          const firstLibTrack = LIBRARY[0];
          console.warn("First library track structure:", {
            id: getId(firstLibTrack),
            file: firstLibTrack.file,
            title: firstLibTrack.title || firstLibTrack.tags?.title,
            artist: firstLibTrack.artist || firstLibTrack.tags?.artist
          });
        }
        
        return res.status(422).json({ 
          error: "None of the catalog tracks matched the library",
          debug: {
            catalogCount: catalog?.tracks?.length || 0,
            libraryCount: LIBRARY.length,
            sampleCatalogKeys: sampleCatalog,
            sampleLibraryKeys: sampleLib
          }
        });
      }

      // Fast resolvers (we'll need these both for dominant-orchestra and later resolution)
      const byIdRaw  = new Map(workingSet.map((t) => [getId(t), t]));
      const byIdNorm = new Map(workingSet.map((t) => [matchKey(getId(t)), t]));
      const resolveId = (id) => byIdRaw.get(id) || byIdNorm.get(matchKey(id)) || null;

      // 3) Build base pool: same style, not in avoid, not previously selected
      const hasStyle = (t) => {
        const g = t?.styles?.length ? t.styles
                : Array.isArray(t?.tags?.genre) ? t.tags.genre
                : [t?.tags?.genre];
        return (g || []).some((s) => String(s || "").trim().toLowerCase() === wantStyle);
      };
      const idKeyOf = (t) => matchKey(getId(t));
      let base = workingSet.filter((t) => 
        hasStyle(t) && 
        !avoid.has(idKeyOf(t)) && 
        !previouslySelectedSet.has(idKeyOf(t))
      );

      console.log(`Working set size: ${workingSet.length}`);
      console.log(`After style filter (${wantStyle}): ${base.length}`);
      
      // If no tracks match the style, let's see what styles we do have
      if (base.length === 0) {
        const availableStyles = new Set();
        workingSet.forEach(t => {
          const g = t?.styles?.length ? t.styles
                  : Array.isArray(t?.tags?.genre) ? t.tags.genre
                  : [t?.tags?.genre];
          (g || []).forEach(s => {
            if (s) availableStyles.add(String(s).trim().toLowerCase());
          });
        });
        console.warn(`No tracks found for style "${wantStyle}". Available styles:`, Array.from(availableStyles).slice(0, 10));
      }

      // 4) Orchestra narrowing:
      //    - shift-click (homogenize): use dominant orchestra found in current tanda (avoidIds)
      //    - else: keep existing same-orchestra behavior
      let targetOrchestra = null;

      if (homogenize) {
        // Count orchestra frequencies within the current tanda (avoidIds)
        const freq = new Map();
        for (const id of avoidIds) {
          const tr = resolveId(id);
          if (!tr) continue;
          const orch = (tr?.artist ?? tr?.tags?.artist ?? tr?.metadata?.artist ?? "Unknown").trim();
          if (!orch) continue;
          freq.set(orch, (freq.get(orch) || 0) + 1);
        }
        // Pick most frequent
        targetOrchestra = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      } else if (orchestra) {
        targetOrchestra = String(orchestra).trim() || null;
      }

      if (targetOrchestra && !needsBroadening) {
        const strict = base.filter(
          (t) => ((t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "").trim() === targetOrchestra)
        );
        // Only narrow if we still have enough choices
        if (strict.length >= Math.min(3, topK)) base = strict;
      }
      
      // If we have no tracks or need broadening, expand search criteria
      if ((base.length === 0) || (base.length < topK && needsBroadening)) {
        console.log(`[BROADENING] Initial pool has ${base.length} tracks, expanding search...`);
        
        // Step 1: Include different orchestras (remove orchestra restriction)
        if (targetOrchestra) {
          console.log(`[BROADENING] Removing orchestra restriction (was: ${targetOrchestra})`);
          base = workingSet.filter((t) => 
            hasStyle(t) && 
            !avoid.has(idKeyOf(t)) && 
            !previouslySelectedSet.has(idKeyOf(t))
          );
        }
        
        // Step 2: If still not enough, expand to compatible styles
        if (base.length < Math.max(1, topK)) {
          console.log(`[BROADENING] Still only ${base.length} tracks, expanding to compatible styles...`);
          const compatibleStyles = getCompatibleStyles(wantStyle);
          
          const hasCompatibleStyle = (t) => {
            const g = t?.styles?.length ? t.styles
                    : Array.isArray(t?.tags?.genre) ? t.tags.genre
                    : [t?.tags?.genre];
            return (g || []).some((s) => {
              const trackStyle = String(s || "").trim().toLowerCase();
              return compatibleStyles.includes(trackStyle);
            });
          };
          
          const expandedBase = workingSet.filter((t) => 
            hasCompatibleStyle(t) && 
            !avoid.has(idKeyOf(t)) && 
            !previouslySelectedSet.has(idKeyOf(t))
          );
          
          if (expandedBase.length > base.length) {
            base = expandedBase;
            console.log(`[BROADENING] Expanded to ${base.length} tracks with compatible styles: ${compatibleStyles.join(', ')}`);
          }
        }
        
        // Step 3: If still nothing, try any genre but still avoid duplicates
        if (base.length === 0) {
          console.log(`[EMERGENCY BROADENING] No compatible styles found, trying any genre...`);
          base = workingSet.filter((t) => 
            !avoid.has(idKeyOf(t)) && 
            !previouslySelectedSet.has(idKeyOf(t))
          );
          console.log(`[EMERGENCY BROADENING] Found ${base.length} tracks of any genre`);
        }
      }

      // 5) Score by continuity
      const prevKey = neighbors?.prev?.key ?? null;
      const nextKey = neighbors?.next?.key ?? null;
      const prevBpm = neighbors?.prev?.bpm ?? neighbors?.prev?.BPM ?? null;
      const nextBpm = neighbors?.next?.bpm ?? neighbors?.next?.BPM ?? null;
      const prevEn  = neighbors?.prev?.energy ?? neighbors?.prev?.Energy ?? null;
      const nextEn  = neighbors?.next?.energy ?? neighbors?.next?.Energy ?? null;

      const score = (t) => {
        const bpm = bpmOf(t);
        const en  = energyOf(t);
        const cam = keyToCamelot(t);

        const kPrev = prevKey ? camelotDistance(prevKey, cam) : 0;
        const kNext = nextKey ? camelotDistance(nextKey, cam) : 0;
        const kCost = Math.min(4, kPrev) + Math.min(4, kNext);

        const bPrev = (prevBpm && bpm) ? Math.abs(prevBpm - bpm) : 0;
        const bNext = (nextBpm && bpm) ? Math.abs(nextBpm - bpm) : 0;
        const bCost = 0.05 * (bPrev + bNext);

        const ePrev = (prevEn && en) ? Math.abs(prevEn - en) : 0;
        const eNext = (nextEn && en) ? Math.abs(nextEn - en) : 0;
        const eCost = 0.2 * (ePrev + eNext);

        return kCost + bCost + eCost;
      };

      base = base.map((t) => ({ t, s: score(t) }))
                .sort((a, b) => a.s - b.s)
                .map((x) => x.t);

      console.log(`Final base pool after scoring: ${base.length} tracks`);
      if (base.length > 0) {
        console.log("First few candidates:", base.slice(0, 3).map(t => ({
          id: getId(t).substring(0, 50) + "...",
          title: t.title ?? t?.metadata?.title ?? t?.tags?.title ?? "Unknown",
          artist: (t?.artist ?? t?.metadata?.artist ?? t?.tags?.artist ?? "Unknown").trim(),
        })));
      }

      // 6) Slim candidates
      const slim = base.slice(0, Math.max(80, topK)).map((t) => ({
        id: getId(t),
        title: t.title ?? t?.metadata?.title ?? t?.tags?.title ?? "Unknown",
        artist: (t?.artist ?? t?.metadata?.artist ?? t?.tags?.artist ?? "Unknown").trim(),
        seconds: durationSec(t) || null,
        bpm: bpmOf(t),
        energy: energyOf(t),
        camelotKey: keyToCamelot(t),
      }));

      console.log(`Created ${slim.length} slim candidates`);
      
      // Double-check that slim candidates are actually filtered correctly
      const invalidCandidates = slim.filter(s => {
        const normalized = matchKey(s.id);
        return avoid.has(normalized) || previouslySelectedSet.has(normalized);
      });
      
      if (invalidCandidates.length > 0) {
        console.error(`ERROR: ${invalidCandidates.length} candidates are in avoid/previously selected lists:`, 
          invalidCandidates.map(c => ({ id: c.id.substring(0, 50) + "...", title: c.title })));
      }
      
      // Show ID format comparison for debugging
      if (slim.length > 0 && avoid.size > 0) {
        console.log("ID format comparison:");
        console.log("  Candidate ID:", slim[0].id.substring(0, 100) + "...");
        console.log("  Candidate normalized:", matchKey(slim[0].id).substring(0, 100) + "...");
        console.log("  First avoid ID:", Array.from(avoid)[0].substring(0, 100) + "...");
      }

      if (!slim.length) {
        console.log("=== REPLACEMENT DEBUG ===");
        console.log("Request style:", style, "-> wantStyle:", wantStyle);
        console.log("Target orchestra:", targetOrchestra);
        console.log("Avoid IDs count:", avoid.size);
        console.log("Previously selected count:", previouslySelectedSet.size);
        console.log("Working set size:", workingSet.length);
        console.log("Needs broadening:", needsBroadening);
        
        const styleMatches = workingSet.filter(hasStyle);
        console.log("Style matches:", styleMatches.length);
        
        const afterAvoid = workingSet.filter((t) => hasStyle(t) && !avoid.has(idKeyOf(t)) && !previouslySelectedSet.has(idKeyOf(t)));
        console.log("After avoiding IDs and previously selected:", afterAvoid.length);
        
        if (styleMatches.length > 0 && afterAvoid.length === 0) {
          console.log("All tracks of this style are either avoided or previously selected!");
          console.log("First few avoid IDs:", Array.from(avoid).slice(0, 5));
          console.log("Previously selected IDs:", Array.from(previouslySelectedSet).slice(0, 5));
          console.log("First few style match IDs:", styleMatches.slice(0, 3).map(t => idKeyOf(t)));
        }
        
        if (targetOrchestra && afterAvoid.length > 0) {
          const orchMatches = afterAvoid.filter(
            (t) => ((t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "").trim() === targetOrchestra)
          );
          console.log("Orchestra matches for", targetOrchestra + ":", orchMatches.length);
        }
        
        return res.status(404).json({
          error: "No candidates available for replacement",
          detail: {
            workingSet: workingSet.length,
            baseStyleMatches: styleMatches.length,
            baseAfterAvoid: afterAvoid.length,
            previouslySelectedCount: previouslySelectedSet.size,
            needsBroadening: needsBroadening,
            narrowedByOrchestra: targetOrchestra ? base.length : "(not narrowed)",
          },
        });
      }

      // 7) Agent prompt: reflect mode
      const modeText = homogenize
        ? `Mode: HOMOGENIZE (use dominant orchestra across current tanda if possible).`
        : `Mode: SAME-ORCHESTRA preference = ${orchestra || "n/a"}.`;

      const items = [
        system("Return ONLY schema-valid JSON. No prose."),
        {
          role: "user",
          content: [
            { type: "input_text", text: `Replace one ${style} track. ${modeText} Keep continuity with neighbors.` },
            { type: "input_text", text: `POSITION: ${JSON.stringify(position ?? {})}` },
            { type: "input_text", text: `NEIGHBORS: ${JSON.stringify(neighbors ?? {})}` },
            { type: "input_text", text: `AVOID_IDS (current tanda): ${JSON.stringify(Array.from(avoid))}` },
            { type: "input_text", text: `PREVIOUSLY_SELECTED (for this position): ${JSON.stringify(Array.from(previouslySelectedSet))}` },
            { type: "input_text", text: `CANDIDATES: ${JSON.stringify(slim)}` },
            { type: "input_text", text: `IMPORTANT: Never select tracks from AVOID_IDS or PREVIOUSLY_SELECTED lists. Choose different tracks for variety.` },
          ]
        }
      ];

      let chosenId = null, suggestions = null;
      try {
        const result = await run(replaceAgent, items, { maxTurns: 1 });
        const out = ReplacementResult.parse(result.finalOutput);
        
        // Validate that chosen track is not in avoid list
        const chosenNormalized = matchKey(out.chosenId || "");
        if (avoid.has(chosenNormalized) || previouslySelectedSet.has(chosenNormalized)) {
          console.warn(`[REPLACEMENT] Agent selected avoided/previously selected track: ${out.chosenId}, using fallback`);
          throw new Error("Agent selected invalid track");
        }
        
        chosenId = out.chosenId;
        suggestions = out.suggestions;
      } catch (err) {
        console.warn("[REPLACEMENT] Agent failed or selected invalid track, using fallback selection");
        console.warn("Agent error:", err.message);
        
        // Improved fallback: randomize selection to avoid always picking the same track
        let validCandidates = slim.filter(track => {
          const trackNormalized = matchKey(track.id);
          return !avoid.has(trackNormalized) && !previouslySelectedSet.has(trackNormalized);
        });
        
        if (validCandidates.length === 0) {
          console.warn("[REPLACEMENT] No valid candidates found, using all candidates");
          validCandidates = slim;
        }
        
        // Pick a random valid candidate instead of always the first
        const randomIndex = Math.floor(Math.random() * validCandidates.length);
        const fallbackTrack = validCandidates[randomIndex] || slim[0];
        
        console.log(`[REPLACEMENT] Selected fallback track ${randomIndex + 1}/${validCandidates.length}: ${fallbackTrack?.title}`);
        chosenId = fallbackTrack?.id;
        
        // Generate diverse suggestions, avoiding the chosen track
        suggestions = slim.slice(0, Math.min(topK, 6))
          .filter(s => s.id !== chosenId)
          .map((s) => ({ id: s.id, reason: null }));
      }

      // 8) Resolve chosen & suggestions (re-use resolveId from above)
      const chosen = resolveId(chosenId) || resolveId(slim[0].id);
      if (!chosen) return res.status(500).json({ error: "Chosen ID not in working set" });

      const replacementId = getId(chosen);
      
      // Final validation: ensure we're not returning a track from the tanda
      const finalValidation = matchKey(replacementId);
      if (avoid.has(finalValidation)) {
        console.error(`[REPLACEMENT] CRITICAL ERROR: About to return track that should be avoided!`);
        console.error(`[REPLACEMENT] Chosen track: ${replacementId}`);
        console.error(`[REPLACEMENT] Normalized: ${finalValidation}`);
        console.error(`[REPLACEMENT] This should never happen - indicates filtering bug`);
        
        return res.status(500).json({ 
          error: "Internal error: selected track is already in tanda",
          debug: {
            chosenId: replacementId,
            normalized: finalValidation,
            inAvoidList: true
          }
        });
      }

      const replacement = {
        id: replacementId,
        title: chosen.title ?? chosen?.metadata?.title ?? chosen?.tags?.title ?? "Unknown",
        artist: chosen.artist ?? chosen?.metadata?.artist ?? chosen?.tags?.artist ?? null,
        album: chosen.album ?? chosen?.tags?.album ?? null,
        BPM: bpmOf(chosen),
        Energy: energyOf(chosen),
        Key: chosen?.Key ?? chosen?.key ?? chosen?.tags?.Key ?? null,
        camelotKey: keyToCamelot(chosen),
        seconds: durationSec(chosen),
      };

      // Filter suggestions to avoid tracks in tanda or previously selected
      const suggestionsOut = (suggestions || [])
        .filter(s => {
          const suggestionNormalized = matchKey(s.id || "");
          return !avoid.has(suggestionNormalized) && 
                 !previouslySelectedSet.has(suggestionNormalized) &&
                 matchKey(s.id) !== matchKey(replacementId); // Don't suggest the same track we just chose
        })
        .map((s) => {
          const t = resolveId(s.id);
          return t ? {
            id: getId(t),
            title: t.title ?? t?.metadata?.title ?? t?.tags?.title ?? "Unknown",
            artist: t.artist ?? t?.metadata?.artist ?? t?.tags?.artist ?? null,
            seconds: durationSec(t),
            BPM: bpmOf(t),
            Energy: energyOf(t),
            camelotKey: keyToCamelot(t),
            reason: s.reason ?? null,
          } : s;
        }).slice(0, topK);
        
      // If we don't have enough valid suggestions, add some from the slim list
      if (suggestionsOut.length < topK) {
        const additionalSuggestions = slim
          .filter(s => {
            const suggestionNormalized = matchKey(s.id || "");
            return !avoid.has(suggestionNormalized) && 
                   !previouslySelectedSet.has(suggestionNormalized) &&
                   matchKey(s.id) !== matchKey(replacementId) &&
                   !suggestionsOut.some(existing => matchKey(existing.id) === suggestionNormalized);
          })
          .slice(0, topK - suggestionsOut.length)
          .map(s => ({
            id: s.id,
            title: s.title,
            artist: s.artist,
            seconds: null,
            BPM: s.bpm,
            Energy: s.energy,
            camelotKey: s.camelotKey,
            reason: "Alternative suggestion"
          }));
          
        suggestionsOut.push(...additionalSuggestions);
      }

      // Include metadata about the selection process
      const responseMetadata = {
        broadeningApplied: needsBroadening,
        originalPool: workingSet.length,
        finalPool: base.length,
        previouslySelectedCount: previouslySelectedSet.size,
        orchestraRestricted: targetOrchestra && !needsBroadening
      };

      return res.json({ 
        replacement, 
        suggestions: suggestionsOut,
        metadata: responseMetadata 
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  });

/** Return a list of cortina identifiers (strings). Map them to files in your player. */
// ---------- Cortinas (count-aware) ----------
// Select cortinas from LIBRARY by genre (no CORTINAS_DIR needed)


  // ---- Role constraints ----
  // You can tune these ranges over time:
  const ROLE_RULES = {
    classic: { minYear: 1930, maxYear: 1945, preferAlt: false, allowNuevo: false },
    rich:    { minYear: 1946, maxYear: 1958, preferAlt: false, allowNuevo: true  },
    modern:  { minYear: 1990, maxYear: 2100, preferAlt: false, allowNuevo: true  },
    alt:     { minYear: 1995, maxYear: 2100, preferAlt: true,  allowNuevo: true  },
  };


  function trackYear(t) {
    return clampYear(t?.tags?.year ?? t?.year ?? t?.metadata?.year ?? null);
  }

  // ERA resolution from the individual track (fallback to orchestra profile)
  function trackFitsRole(t, role) {
    if (!role || !ROLE_RULES[role]) return true;
    const { minYear, maxYear, preferAlt } = ROLE_RULES[role];

    const y = trackYear(t);
    const inYear = (y == null) ? true : (y >= minYear && y <= maxYear);

    if (!preferAlt) return inYear;

    // "alt" bias: include explicitly alt/neo/nuevo tags or non-(tango|vals|milonga) genres
    const g = []
      .concat(Array.isArray(t?.tags?.genre) ? t.tags.genre : t?.tags?.genre ? [t.tags.genre] : [])
      .concat(Array.isArray(t?.styles) ? t.styles : []);
    const hay = g.join(" ").toLowerCase();
    const looksAlt = /alt|alternative|nuevo|neo|electro|pop|rock|jazz|swing|blues|folk/.test(hay);
    return inYear && looksAlt;
  }

  // Soft scoring boost for role (used to sort candidates)
    function roleScoreBoost(t, role) {
      if (!role || !ROLE_RULES[role]) return 0;
      const { minYear, maxYear, preferAlt } = ROLE_RULES[role];

      const y = effectiveYear(t);                 // ← use robust year
      let s = 0;

      if (y == null) {
        // Unknown year gets small grace so it’s not penalized out
        s += 0.25;
      } else {
        const mid = (minYear + maxYear) / 2;
        const d = Math.abs((y - mid) / (maxYear - minYear || 1));
        s += Math.max(0, 1.2 - d * 2.0); // [~1.2 .. 0]
      }

      if (preferAlt) {
        const hay = [...readGenres(t), ...(Array.isArray(t?.styles) ? t.styles : [])]
          .map(String).join(" ").toLowerCase();
        if (/alt|alternative|nuevo|neo|electro|pop|rock|jazz|swing|blues|folk/.test(hay)) s += 0.7;
      }

      // If the raw year is modern but we suspected remaster (effectiveYear returned null),
      // give a tiny penalty for classic/rich so real Golden Age with correct years wins.
      if ((role === "classic" || role === "rich")) {
        const rawY = clampYear(t?.tags?.year ?? t?.year ?? t?.metadata?.year ?? null);
        if (rawY != null && rawY >= TRUST_YEAR_CUTOFF && y == null) s -= 0.2;
      }

      return s;
    }

  async function loadTandaSchedule(req) {
    // Priority: explicit object in body → named file → null
    if (req.body?.tandaSchedule && Array.isArray(req.body.tandaSchedule?.tandas)) {
      return req.body.tandaSchedule;
    }
    const name = String(req.body?.tandaScheduleName || "").trim(); // e.g., "tandaSchedule01.json"
    if (!name) return null;

    const schedulesDir = path.resolve(process.cwd(), "schedules"); // choose your folder
    const fp = path.join(schedulesDir, name);
    try {
      const raw = await fs.readFile(fp, "utf8");
      const json = JSON.parse(raw);
      if (Array.isArray(json?.tandas)) return json;
    } catch {
      // ignore and fall back
    }
    return null;
  }

  function roleForIndex(schedule, tandaIndex) {
    if (!schedule?.tandas?.length) return null;
    // Last occurrence wins if duplicates exist
    const hit = schedule.tandas.find(t => Number(t?.tandaIndex) === Number(tandaIndex));
    return hit?.role || null;
  }

  // ---- Retry Tanda endpoint ----
  app.post("/api/agent/retryTanda", async (req, res) => {
    // ------------------------ NDJSON setup ------------------------
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Transfer-Encoding", "chunked");
    const send = (obj) => res.write(JSON.stringify(obj) + "\n");
    
    // Helper to stream LLM output to the client
    const streamLLMOutput = (text) => {
      send({ type: "llm_message", text });
    };

    try {
      const { tandaIndex, currentTanda, avoidOrchestras = [], catalog } = req.body;

      if (!currentTanda || typeof tandaIndex !== 'number') {
        send({ type: "error", error: "Missing required fields: tandaIndex and currentTanda" });
        return res.end();
      }

      if (!catalog || !Array.isArray(catalog.tracks)) {
        send({ type: "error", error: "Missing catalog.tracks for retry" });
        return res.end();
      }

      streamLLMOutput(`[RETRY TANDA] Starting retry for tanda ${tandaIndex} (${currentTanda.orchestra})`);
      console.log(`[RETRY TANDA] Starting retry for tanda ${tandaIndex} (${currentTanda.orchestra})`);

      // Use the same catalog setup as bulkGenerate
      const { ids, overrides } = extractCatalogPathsAndStyles({ tracks: catalog.tracks });

      const idKeysExact = new Set([...ids].map(norm));
      const idKeysNoExt = new Set([...idKeysExact].map(stripExt));

      const workingSet = LIBRARY
        .filter((t) => {
          const cands = [
            getAbsolutePath(t?.file),
            t?.id,
            t?.file?.id,
            t?.file?.wavPath,
          ].filter(Boolean);
          for (const raw of cands) {
            const n = norm(raw);
            const ne = stripExt(n);
            if (idKeysExact.has(n) || idKeysNoExt.has(ne)) return true;
          }
          return false;
        })
        .map((t) => {
          const k1 = getAbsolutePath(t?.file);
          const k2 = getId(t);
          return mergeSlotsAndTagsIntoTrack(t, overrides.get(k1) || overrides.get(k2));
        });

      if (!workingSet.length) {
        send({ type: "error", error: "No matching tracks found in library" });
        return res.end();
      }

      // Normalize orchestra names to handle variations like "Alfredo de Angelis" vs "Alfredo de Angelis O.T."
      const normalizeOrchestra = (orch) => {
        if (!orch) return "";
        return String(orch)
          .replace(/\s+O\.T\.\s*(con\s+)?.*$/i, '') // Remove "O.T. con..." part
          .replace(/\s+(y\s+su\s+orquesta.*|Y\s+Su.*)/i, '') // Remove "y su orquesta" variations
          .trim();
      };

      // Get orchestras that are actually available in the workingSet
      // Note: LIBRARY tracks have artist in tags.artist field based on catalog-Art.json structure
      let availableOrchestras = [...new Set(workingSet.map(track => {
        return track?.tags?.artist ?? track?.artist ?? track?.metadata?.artist ?? null;
      }))].filter(Boolean);
      
      streamLLMOutput(`[RETRY TANDA] WorkingSet size: ${workingSet.length}, Available orchestras: ${availableOrchestras.length}`);
      console.log(`[RETRY TANDA] WorkingSet orchestras:`, availableOrchestras.slice(0, 5));
      
      // If workingSet is too small (like from a loaded playlist), use full library for orchestra diversity
      if (availableOrchestras.length < 5) {
        const fullLibraryOrchestras = [...new Set(LIBRARY.map(track => {
          return track?.tags?.artist ?? track?.artist ?? track?.metadata?.artist ?? null;
        }))].filter(Boolean);
        streamLLMOutput(`[RETRY TANDA] WorkingSet too small, using full library with ${fullLibraryOrchestras.length} orchestras`);
        console.log(`[RETRY TANDA] Full library orchestras:`, fullLibraryOrchestras.slice(0, 5));
        
        availableOrchestras = fullLibraryOrchestras;
      }
      
      // Normalize avoidance list to catch orchestra name variations
      const normalizedAvoid = [currentTanda.orchestra, ...avoidOrchestras]
        .map(normalizeOrchestra)
        .filter(Boolean);
      
      streamLLMOutput(`[RETRY TANDA] Normalized avoid list: ${normalizedAvoid.join(', ')}`);
      
      // Filter available orchestras to exclude those we want to avoid
      const alternativeOrchestras = availableOrchestras.filter(orch => {
        const normalized = normalizeOrchestra(orch);
        return !normalizedAvoid.includes(normalized);
      });

      streamLLMOutput(`[RETRY TANDA] Available alternatives: ${alternativeOrchestras.slice(0, 3).join(', ')}`);
      streamLLMOutput(`[RETRY TANDA] Avoiding orchestras: ${[currentTanda.orchestra, ...avoidOrchestras].join(', ')}`);
      console.log(`[RETRY TANDA] Available alternatives:`, alternativeOrchestras);
      console.log(`[RETRY TANDA] Avoiding orchestras:`, [currentTanda.orchestra, ...avoidOrchestras]);

      if (alternativeOrchestras.length === 0) {
        send({ type: "error", error: "No alternative orchestras available for retry" });
        return res.end();
      }

      // Filter candidates for the requested style
      // Use full library if workingSet is too small (like from loaded playlist)
      const candidateSource = workingSet.length < 50 ? LIBRARY : workingSet;
      const candidates = candidateSource.filter(t => {
        const hasStyle = (t) => {
          const g = t?.styles?.length ? t.styles
                  : Array.isArray(t?.tags?.genre) ? t.tags.genre
                  : [t?.tags?.genre];
          return (g || []).some((s) => {
            const trackStyle = String(s || "").trim().toLowerCase();
            const wantStyle = currentTanda.style.toLowerCase();
            return trackStyle === wantStyle;
          });
        };
        return hasStyle(t);
      });
      
      streamLLMOutput(`[RETRY TANDA] Using ${candidateSource === LIBRARY ? 'full library' : 'workingSet'} as candidate source`);
      streamLLMOutput(`[RETRY TANDA] Candidates available: ${candidates.length}`);

      // Build orchestra profiles for planOneTandaWithRetry
      const profiles = buildOrchestraProfiles(candidateSource);

      // Extract all track IDs currently used in the playlist to avoid duplicates
      const currentTrackIds = new Set();
      if (req.body.currentPlaylist && Array.isArray(req.body.currentPlaylist)) {
        req.body.currentPlaylist.forEach(tanda => {
          if (tanda.tracks && Array.isArray(tanda.tracks)) {
            tanda.tracks.forEach(track => {
              if (track.id) currentTrackIds.add(track.id);
              if (track.path) currentTrackIds.add(track.path);
              if (track.uri) currentTrackIds.add(track.uri);
            });
          }
        });
      }

      streamLLMOutput(`[RETRY TANDA] Avoiding ${currentTrackIds.size} tracks from current playlist`);

      // Try multiple orchestras from alternatives if needed
      let result = null;
      let usedAlternative = null;

      for (let i = 0; i < Math.min(alternativeOrchestras.length, 3); i++) {
        const targetOrchestra = alternativeOrchestras[i];
        streamLLMOutput(`[RETRY TANDA] Attempt ${i + 1}: Trying orchestra ${targetOrchestra}`);
        console.log(`[RETRY TANDA] Attempt ${i + 1}: Trying orchestra ${targetOrchestra}`);

        try {
          result = await planOneTandaWithRetry({
            style: currentTanda.style,
            size: currentTanda.trackCount || 4,
            remainingMinutes: 20, // 20 minutes for a single tanda retry
            usedIds: currentTrackIds, // Use track IDs from current playlist to avoid duplicates
            candidates,
            allStyleCandidates: candidates, // Same as candidates for retry (full library)
            orchestra: targetOrchestra,
            prevKey: null,
            profiles,
            maxRetries: 2, // Reduced retries per orchestra since we try multiple
            onLLMOutput: streamLLMOutput // Pass LLM output streaming to tanda generation
          });

          const realCount = Array.isArray(result?.trackIds) ? result.trackIds.filter(id => id !== 'replace').length : 0;
          if (result && result.trackIds && realCount > 0) {
            usedAlternative = targetOrchestra;
            streamLLMOutput(`[RETRY TANDA] ✅ Success with orchestra ${targetOrchestra}`);
            console.log(`[RETRY TANDA] ✅ Success with orchestra ${targetOrchestra}`);
            break;
          }
        } catch (error) {
          streamLLMOutput(`[RETRY TANDA] ❌ Failed with orchestra ${targetOrchestra}: ${error.message}`);
          console.log(`[RETRY TANDA] ❌ Failed with orchestra ${targetOrchestra}:`, error.message);
          // Continue to next orchestra
        }
      }

      const realCountFinal = Array.isArray(result?.trackIds) ? result.trackIds.filter(id => id !== 'replace').length : 0;
      if (result && result.trackIds && realCountFinal > 0) {
        streamLLMOutput(`[RETRY TANDA] ✅ Successfully generated new tanda with ${result.trackIds.length} tracks (including ${result.trackIds.length - realCountFinal} placeholders) using ${usedAlternative}`);
        console.log(`[RETRY TANDA] ✅ Successfully generated new tanda with ${result.trackIds.length} tracks (including ${result.trackIds.length - realCountFinal} placeholders) using ${usedAlternative}`);
        
        // Convert trackIds back to track objects
        console.log(`[RETRY TANDA] Converting ${result.trackIds.length} trackIds:`, result.trackIds);
        console.log(`[RETRY TANDA] Candidates available:`, candidates.length);
        
        // Debug: show sample candidate IDs
        const sampleCandidateIds = candidates.slice(0, 5).map(t => getId(t));
        console.log(`[RETRY TANDA] Sample candidate IDs:`, sampleCandidateIds);
        
        const tracks = result.trackIds.map(id => {
          // First try exact match
          let track = candidates.find(t => getId(t) === id);
          
          // If not found, try matching by filename (handle path vs filename mismatch)
          if (!track) {
            track = candidates.find(t => {
              const candId = getId(t);
              if (!candId) return false;
              
              // Extract filename from full path
              const candFilename = candId.split('/').pop() || candId;
              const searchFilename = id.split('/').pop() || id;
              
              return candFilename === searchFilename || candId.endsWith('/' + id) || candId.endsWith(id);
            });
          }
          
          if (!track) {
            console.log(`[RETRY TANDA] ❌ Track not found for ID: ${id}`);
            return null;
          }
          
          const compactTrack = trackToCompactPlayable(track);
          console.log(`[RETRY TANDA] ✅ Converted track: ${compactTrack?.title} by ${compactTrack?.artist}`);
          return compactTrack;
        }).filter(Boolean);
        
        console.log(`[RETRY TANDA] Final tracks array:`, tracks);

        // Determine the orchestra from the tracks
        const orchestras = tracks.map(t => t.artist).filter(Boolean);
        const newOrchestra = orchestras.length > 0 ? orchestras[0] : usedAlternative;
        
        send({
          type: "success",
          success: true,
          tanda: {
            orchestra: newOrchestra,
            style: result.style,
            tracks: tracks
          },
          metadata: {
            originalOrchestra: currentTanda.orchestra,
            newOrchestra: newOrchestra,
            alternativesAvailable: alternativeOrchestras.length,
            retryReason: "User requested tanda retry",
            trackCount: tracks.length
          }
        });
        return res.end();
      } else {
        streamLLMOutput(`[RETRY TANDA] ❌ Failed to generate replacement tanda: No tracks found`);
        console.log(`[RETRY TANDA] ❌ Failed to generate replacement tanda: No tracks found`);
        
        send({
          type: "error",
          success: false,
          error: "No tracks found for replacement tanda",
          details: {
            style: currentTanda.style,
            orchestra: alternativeOrchestras[0],
            candidateCount: candidates.length,
            alternativeOrchestras: alternativeOrchestras.slice(0, 5),
            notes: result?.notes,
            warnings: result?.warnings
          }
        });
        return res.end();
      }

    } catch (error) {
      streamLLMOutput(`[RETRY TANDA] Error: ${error.message}`);
      console.error("[RETRY TANDA] Error:", error);
      send({
        type: "error",
        success: false,
        error: error.message || "Internal server error during tanda retry"
      });
      return res.end();
    }
  });

  // Helper function to format structured review into readable text
  function formatReviewResult(parsedContent) {
    console.log(`🔍 [AI REVIEW] Formatting review result...`);
    console.log(`🔍 [AI REVIEW] parsedContent keys:`, Object.keys(parsedContent || {}));
    
    // The parsedContent should now be the direct finalOutput from the agent

    const sections = [
      `**Orchestra Selection & Variety**\n${parsedContent.orchestraAnalysis || 'Analysis not available'}`,
      `**Musical Flow & Energy**\n${parsedContent.musicalFlow || 'Analysis not available'}`,
      `**Style Balance**\n${parsedContent.styleBalance || 'Analysis not available'}`,
      `**Danceability**\n${parsedContent.danceability || 'Analysis not available'}`,
      `**DJ Craft**\n${parsedContent.djCraft || 'Analysis not available'}`,
      `**Audience Engagement**\n${parsedContent.audienceEngagement || 'Analysis not available'}`,
      `**Overall Assessment**\n${parsedContent.overallAssessment || 'Assessment not available'}`
    ];

    let formattedReview = sections.join('\n\n');

    if (parsedContent.recommendations && Array.isArray(parsedContent.recommendations) && parsedContent.recommendations.length > 0) {
      formattedReview += '\n\n**Recommendations**\n';
      parsedContent.recommendations.forEach(rec => {
        formattedReview += `• ${rec}\n`;
      });
    }

    console.log(`📝 [AI REVIEW] Formatted review length: ${formattedReview.length} characters`);
    return formattedReview;
  }

  // ---- AI-Powered Playlist Review endpoint ----
  app.post("/api/agent/review", async (req, res) => {
    try {
      const { playlist, programmaticAnalysis } = req.body;

      if (!playlist || !Array.isArray(playlist.tandas)) {
        return res.status(400).json({ 
          success: false, 
          error: "Missing required field: playlist with tandas array" 
        });
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`🤖 [AI REVIEW] Starting GPT-4o playlist review`);
      console.log(`📋 Playlist: ${playlist.tandas.length} tandas, ${Math.round(playlist.duration / 60)} minutes`);
      console.log(`${'='.repeat(60)}\n`);

      // Prepare the playlist data for the LLM
      const playlistSummary = playlist.tandas.map((tanda, index) => ({
        tandaNumber: index + 1,
        orchestra: tanda.orchestra,
        style: tanda.style,
        trackCount: tanda.tracks?.length || 0,
        tracks: tanda.tracks?.map(track => ({
          title: track.title,
          artist: track.artist,
          year: track.year,
          bpm: track.bpm,
          energy: track.energy,
          camelotKey: track.camelotKey
        })) || []
      }));

      // Create a comprehensive prompt for the LLM
      const reviewPrompt = `You are a professional Argentine tango DJ with decades of experience in milonga programming. 

Please provide a detailed review of this tango playlist, analyzing it from the perspective of a seasoned milonguero and DJ.

PLAYLIST OVERVIEW:
- Total tandas: ${playlist.tandas.length}
- Duration: ${Math.round(playlist.duration / 60)} minutes
- Selected schedule: ${playlist.selectedSchedule || 'Standard'}

TANDA BREAKDOWN:
${playlistSummary.map(tanda => 
  `Tanda ${tanda.tandaNumber}: ${tanda.orchestra} - ${tanda.style} (${tanda.trackCount} tracks)
  Tracks: ${tanda.tracks.map(t => `"${t.title}" ${t.year ? `(${t.year})` : ''} ${t.bpm ? `${t.bpm}bpm` : ''} ${t.camelotKey ? `Key:${t.camelotKey}` : ''}`).join(', ')}`
).join('\n\n')}

${programmaticAnalysis ? `\nPROGRAMMATIC ANALYSIS RESULTS:
${programmaticAnalysis}` : ''}

Please provide a professional DJ review covering:

1. **Orchestra Selection & Variety**: Analyze the choice and sequencing of orchestras throughout the milonga
2. **Musical Flow & Energy**: Evaluate how the energy builds and flows across tandas
3. **Style Balance**: Comment on the distribution and timing of Tango/Vals/Milonga tandas
4. **Danceability**: Assess how well this playlist would work for social dancing
5. **DJ Craft**: Note any particularly clever programming choices or missed opportunities
6. **Audience Engagement**: Predict how dancers might respond to this selection

Write in a conversational, expert tone as if advising a fellow DJ. Be specific about track and orchestra choices where relevant.`;

      // Call AI review agent using the existing agent setup
      console.log(`🚀 [AI REVIEW] Calling GPT-4o playlist review agent...`);
      console.log(`📝 [AI REVIEW] Prompt preview: ${reviewPrompt.substring(0, 300)}...\n`);
      
      const reviewResult = await run(playlistReviewAgent, reviewPrompt, { 
        maxTurns: 1,
        onUpdate: (update) => {
          console.log(`📡 [AI REVIEW] Agent update:`, update);
        }
      });
      
      if (!reviewResult) {
        throw new Error('No review result received from AI agent');
      }

      console.log(`\n✅ [AI REVIEW] GPT-4o Agent Response:`);
      console.log(`${'─'.repeat(60)}`);
      console.log(`finalOutput:`, JSON.stringify(reviewResult.finalOutput, null, 2));
      console.log(`${'─'.repeat(60)}\n`);

      // Use finalOutput like other agents do
      const parsedContent = reviewResult.finalOutput;
      if (!parsedContent) {
        throw new Error('No finalOutput received from AI agent');
      }

      // Format the structured review into readable text
      const aiReview = formatReviewResult(parsedContent);

      console.log(`🎯 [AI REVIEW] ✅ Successfully generated AI review (${aiReview.length} characters)`);
      console.log(`📝 [AI REVIEW] Formatted review preview: ${aiReview.substring(0, 200)}...`);
      console.log(`${'='.repeat(60)}\n`);
      
      return res.json({
        success: true,
        review: aiReview,
        agentInteraction: {
          prompt: reviewPrompt,
          rawResponse: parsedContent,
          formattedResponse: aiReview
        },
        metadata: {
          model: 'gpt-4o',
          tandaCount: playlist.tandas.length,
          duration: playlist.duration,
          reviewLength: aiReview.length
        }
      });

    } catch (error) {
      console.error("[AI REVIEW] Error:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "Internal server error during AI review"
      });
    }
  });
}
  // ==================================================================
  //                          NDJSON STREAM ROUTE
  // ==================================================================
  // Streaming, schedule-aware tanda generation

export function registerAgentStreamRoutes(app){
  app.post("/api/agent/generate/ndjson", async (req, res) => {
    // ------------------------ NDJSON setup ------------------------
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Transfer-Encoding", "chunked");
    const send = (obj) => res.write(JSON.stringify(obj) + "\n");
    
    // Helper to stream LLM output to the client
    const streamLLMOutput = (text) => {
      send({ type: "llm_message", text });
    };

    // ------------------------ Role rules (server-side) ------------------------
    // Role constraints
    const ROLE_RULES = {
      classic: { minYear: 1930, maxYear: 1945, preferAlt: false, allowNuevo: false },
      rich:    { minYear: 1946, maxYear: 1958, preferAlt: false, allowNuevo: true  },
      modern:  { minYear: 1990, maxYear: 2100, preferAlt: false, allowNuevo: true  },
      alt:     { minYear: 1995, maxYear: 2100, preferAlt: true,  allowNuevo: true  },
    };

    function trackFitsRole(t, role) {
      if (!role || !ROLE_RULES[role]) return true;
      const { minYear, maxYear, preferAlt } = ROLE_RULES[role];

      const y = effectiveYear(t);                 // ← use robust year
      const inYear = (y == null) ? true : (y >= minYear && y <= maxYear);

      if (!preferAlt) return inYear;

      // For "alt": still require alt-ish hints
      const hay = [...readGenres(t), ...(Array.isArray(t?.styles) ? t.styles : [])]
        .map(String).join(" ").toLowerCase();
      const looksAlt = /alt|alternative|nuevo|neo|electro|pop|rock|jazz|swing|blues|folk/.test(hay);
      return inYear && looksAlt;
    }


    // --- Year normalization (tolerant to remasters) ---
    const TRUST_YEAR_CUTOFF = 1990; // years >= this are treated as “suspect” for classic/rich

    function clampYear(y) {
      const n = Number(y);
      return Number.isFinite(n) ? Math.max(1900, Math.min(2100, Math.round(n))) : null;
    }

    function readGenres(t) {
      const g = Array.isArray(t?.tags?.genre) ? t.tags.genre : (t?.tags?.genre ? [t.tags.genre] : []);
      return g.map((s) => String(s || "").toLowerCase());
    }

    function looksRemasterish(t) {
      const album = String(t?.tags?.album ?? t?.album ?? "").toLowerCase();
      const title = String(t?.tags?.title ?? t?.title ?? "").toLowerCase();
      const hay = album + " " + title;
      // common flags on reissues/anthologies
      return /(remaster|remastered|reissue|anthology|collection|best of|archive|deluxe|box set)/i.test(hay);
    }

    /**
     * Prefer recording/original years; downweight suspicious post-1990 values
     * that are likely compilation/remaster dates for Golden Age material.
     */
    function effectiveYear(t) {
      // Prefer explicit recording/original fields if present in your catalog
      const candidates = [
        t?.tags?.recordingYear,
        t?.tags?.originalYear,
        t?.metadata?.recordingYear,
        t?.metadata?.originalYear,
        t?.tags?.year,
        t?.year,
        t?.metadata?.year,
      ];
      const first = candidates.find((v) => v != null);
      const y = clampYear(first);

      if (y == null) return null;

      const genres = readGenres(t);
      const isDanceCore = genres.some((g) => g === "tango" || g === "vals" || g === "milonga");

      // If it looks like a remaster/anthology and the tag-year is modern,
      // we treat it as “unknown” for era filtering/scoring.
      if (y >= TRUST_YEAR_CUTOFF && isDanceCore && looksRemasterish(t)) return null;

      return y;
    }
  

    // A simple role fallback by position if no schedule/role given
    function inferRoleByPosition(idx) {
      // Example: early = classic, mid = rich, late = modern with an alt spice before close
      if (idx <= 1) return "classic";
      if (idx <= 3) return "rich";
      if (idx === 5) return "alt";
      return "modern";
    }

    // ------------------------ Schedule loading ------------------------
    async function loadTandaSchedule(req) {
      if (req.body?.tandaSchedule && Array.isArray(req.body.tandaSchedule?.tandas)) {
        return req.body.tandaSchedule;
      }
      const name = String(req.body?.tandaScheduleName || "").trim();
      if (!name) return null;

      const { default: fs } = await import("node:fs/promises");
      const { default: path } = await import("node:path");
      const schedulesDir = path.resolve(process.cwd(), "schedules");
      const fp = path.join(schedulesDir, name);
      try {
        const raw = await fs.readFile(fp, "utf8");
        const json = JSON.parse(raw);
        if (Array.isArray(json?.tandas)) return json;
      } catch {
        // ignore; return null
      }
      return null;
    }

    function roleForIndex(schedule, tandaIndex) {
      if (!schedule?.tandas?.length) return null;
      const hit = schedule.tandas.find(t => Number(t?.tandaIndex) === Number(tandaIndex));
      return hit?.role || null;
    }

    // ------------------------ Case/extension tolerant used-IDs ------------------------
    const usedIds = new Set(); // stores matchKey(id)
    const markUsed = (id) => usedIds.add(matchKey(id));
    const isUsed = (id) => usedIds.has(matchKey(id));

    try {
      // ------------------------ Inputs ------------------------
      const minutes   = Number(req.body?.minutes ?? 180);
      const catalogIn = req.body?.catalog;
      const sizesIn   = req.body?.sizes || { Tango: 4, Vals: 3, Milonga: 3 };

      // Legacy pattern (kept for compatibility)
      const legacyPattern =
        Array.isArray(req.body?.pattern)
          ? req.body.pattern
          : ["Tango", "Tango", "Vals", "Tango", "Tango", "Milonga"];

      const sizes = {
        Tango:   sizesIn.Tango   ?? 4,
        Vals:    sizesIn.Vals    ?? 3,
        Milonga: sizesIn.Milonga ?? 3,
      };

      if (!catalogIn || !Array.isArray(catalogIn.tracks)) {
        throw new Error("Missing catalog.tracks");
      }

      // ------------------------ Working set from catalog ------------------------
     // --- tolerant normalizers (put near top-level helpers if not already present)
     
      // --- helpers (put near other helpers) ---
      // make override lookup tolerant to decoded forms too
      function resolveOverrideForTrack(libTrack) {
        const cand = [
          getAbsolutePathAny(libTrack?.file),
          libTrack?.id,
          libTrack?.file?.id,
          libTrack?.file?.wavPath,
        ].filter(Boolean);

        for (const raw of cand) {
          const kExact = norm(raw);
          const kNoExt = stripExt(kExact);
          if (overrides.has(kExact)) return overrides.get(kExact);
          if (overrides.has(kNoExt)) return overrides.get(kNoExt);
        }
        return null;
      }

      const norm = (s) => {
        if (!s) return "";
        let x = String(s).trim().replace(/^file:\/\//i, "");
        try { x = decodeURIComponent(x); } catch {}
        return x.replace(/\\/g, "/").toLowerCase();
      };
      const stripExt = (p) => p.replace(/\.[a-z0-9]+$/i, "");
      const matchKey = (s) => stripExt(norm(s));

      function isBase64UrlChars(s) {
        return typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s);
      }
      function tryDecodeBase64Url(s) {
        try {
          const dec = Buffer.from(s, "base64url").toString();
          // treat as path only if it *looks* like one
          if (dec.includes("/") || dec.includes("\\")) return dec;
        } catch {}
        return null;
      }
      function tryDecodePossiblyPrefixedBase64Url(s) {
        if (!s) return null;
        // Some bad generator produced IDs like "/<base64url>"
        const x = s.startsWith("/") ? s.slice(1) : s;
        if (!isBase64UrlChars(x)) return null;
        return tryDecodeBase64Url(x);
      }

      function getAbsolutePathAny(file) {
        if (!file) return null;
        return (
          file.absPath ||
          file.absolutePath ||
          file.fullPath ||
          file.path ||
          file.wavPath ||
          null
        );
      }

      // Build BOTH exact and extensionless key sets from the catalog:
      // --- build catalog key sets (EXACT + extensionless), decoding b64url when present ---
      const { ids, overrides } = extractCatalogPathsAndStyles({ tracks: catalogIn.tracks });

      // Collect raw candidates from the catalog: IDs, decoded IDs (if any), and file.* paths.
      const catalogRaw = new Set();

      // 1) From `ids`
      for (const id of ids || []) {
        if (!id) continue;
        const s = String(id);
        catalogRaw.add(s);
        // Try to decode *both* plain base64url and the “/base64url” corrupted shape
        const d1 = tryDecodeBase64Url(s);
        if (d1) catalogRaw.add(d1);
        const d2 = tryDecodePossiblyPrefixedBase64Url(s);
        if (d2) catalogRaw.add(d2);
      }

      // 2) From each track's file.*
      for (const t of catalogIn.tracks || []) {
        const f = t?.file || {};
        [
          f.absPath, f.absolutePath, f.fullPath, f.path, f.wavPath,
          // also accept a top-level `absolutePath`/`absPath` if present:
          t?.absolutePath, t?.absPath
        ].filter(Boolean).forEach(v => catalogRaw.add(String(v)));
      }

      // Normalize into exact/no-ext key sets
      const idKeysExact = new Set([...catalogRaw].map(norm));
      const idKeysNoExt = new Set([...idKeysExact].map(stripExt));



      
      // --- build working set with tolerant membership test
      const workingSet = LIBRARY
        .filter((t) => {
          const cands = [
            getAbsolutePathAny(t?.file),
            t?.id,
            t?.file?.id,
            t?.file?.wavPath,
          ].filter(Boolean);

          for (const raw of cands) {
            const exact = norm(raw);
            const noext = stripExt(exact);
            if (idKeysExact.has(exact) || idKeysNoExt.has(noext)) return true;
          }
          return false;
        })
        .map((t) => mergeSlotsAndTagsIntoTrack(t, resolveOverrideForTrack(t)));

      // Diagnostics if still zero
      if (workingSet.length === 0) {
        // Show *path-like* samples to verify decoding captured real paths
        const sampleCatalogPaths = [...catalogRaw]
          .filter(s => (s.includes("/") || s.includes("\\")))
          .slice(0, 5)
          .map(norm);

        const sampleLib = LIBRARY.slice(0, 5)
          .map(x => getAbsolutePathAny(x?.file) || x?.id || x?.file?.id || x?.file?.wavPath)
          .filter(Boolean)
          .map(norm);

        console.warn("[ndjson] 0 matches.");
        console.warn("[ndjson] catalog path-like candidates (normalized):", sampleCatalogPaths);
        console.warn("[ndjson] library keys (normalized):", sampleLib);
      }

      // Fast resolvers
      const libById      = new Map(workingSet.map((t) => [getId(t), t]));
      const libByNormKey = new Map(workingSet.map((t) => [matchKey(getId(t)), t]));
      const resolveByAnyId = (id) => libById.get(id) || libByNormKey.get(matchKey(id)) || null;

      // Orchestra profiles for the ranker
      const profiles = buildOrchestraProfiles(workingSet);

      // ------------------------ Build slots ------------------------
      // Preferred: req.body.slots = [{style, role?, size?}, ...]
      let slots = Array.isArray(req.body?.slots) ? req.body.slots.slice() : null;

      if (!slots || !slots.length) {
        // Use legacy pattern + optional schedule (inline or named)
        const schedule = await loadTandaSchedule(req);
        slots = legacyPattern.map((style, i) => {
          const role = roleForIndex(schedule, i) || inferRoleByPosition(i);
          const size = sizes[style] ?? (style === "Tango" ? 4 : 3);
          return { style, role, size };
        });
      } else {
        // normalize slots
        slots = slots.map((s, i) => {
          const style = s.style || legacyPattern[i] || "Tango";
          const role  = s.role || inferRoleByPosition(i);
          const size  = Number.isFinite(s.size) ? s.size : (sizes[style] ?? (style === "Tango" ? 4 : 3));
          return { style, role, size };
        });
      }

      // ------------------------ Stream start ------------------------
      send({ type: "start", minutes, slots, sizes });

      // ------------------------ Planning loop ------------------------
      const tandasResolved = [];
      let remainingSeconds = minutes * 60;
      const recentOrchestras = [];
      let prevKey = null;

      for (let i = 0; i < slots.length; i++) {
        if (remainingSeconds <= 60) break;

        const { style, role, size } = slots[i];
        const sizeTarget = Number.isFinite(size) ? size : (sizes[style] ?? (style === "Tango" ? 4 : 3));
        let tandaMade = false;

        // ---------- 1) Role filter base set ----------
        const baseRolePool = workingSet.filter(
          (t) => {
            const g = Array.isArray(t?.tags?.genre) ? t.tags.genre : t?.tags?.genre ? [t.tags.genre] : [];
            const hasStyle = g.map((x) => String(x || "").toLowerCase()).includes(String(style).toLowerCase());
            return hasStyle && trackFitsRole(t, role) && !isUsed(getId(t));
          }
        );

        // ---------- 2) Agent: rank orchestras, pick a feasible one ----------
        try {
          const rank = await suggestNextOrchestras({
            style,
            prevKey,
            recentOrchestras: recentOrchestras.slice(-2),
            profiles,
            K: 7,
            onLLMOutput: streamLLMOutput,
          });

          // Count available (unused) by orchestra within role-filtered pool
          const availability = new Map();
          for (const t of baseRolePool) {
            const orch = (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim();
            availability.set(orch, (availability.get(orch) || 0) + 1);
          }

          // Pick an orchestra with enough availability
          let targetOrchestra = null;
          for (const s of (rank?.suggestions || [])) {
            const orch = String(s.orchestra || "").trim();
            if ((availability.get(orch) || 0) >= sizeTarget) { targetOrchestra = orch; break; }
          }
          // Fallback: any orchestra in baseRolePool with >= sizeTarget
          if (!targetOrchestra) {
            const byOrch = new Map();
            for (const t of baseRolePool) {
              const o = (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim();
              byOrch.set(o, (byOrch.get(o) || 0) + 1);
            }
            const eligible = [...byOrch.entries()].filter(([, n]) => n >= sizeTarget);
            if (eligible.length) targetOrchestra = eligible[0][0];
          }

          if (targetOrchestra) {
            const candidatesAll = baseRolePool.filter((t) =>
              (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim() === targetOrchestra
            );

            if (candidatesAll.length > 0) {
              const candidates = candidatesAll.slice(0, 80).map((t) => ({
                id: getId(t),
                title: t.title ?? t?.tags?.title ?? t?.metadata?.title ?? "Unknown",
                artist: (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim(),
                seconds: durationSec(t) || null,
                BPM: t?.BPM ?? t?.bpm ?? t?.audio?.bpm ?? t?.tags?.BPM ?? t?.tags?.tempoBPM ?? null,
                energy: t?.Energy ?? t?.energy ?? t?.audio?.energy ?? t?.tags?.Energy ?? null,
                camelotKey: keyToCamelot(t),
              }));

              // Create broader candidate pool from all available tracks for broadening
              const allStyleCandidates = baseRolePool.map((t) => ({
                id: getId(t),
                title: t.title ?? t?.tags?.title ?? t?.metadata?.title ?? "Unknown",
                artist: (t?.artist ?? t?.tags?.artist ?? t?.metadata?.artist ?? "Unknown").trim(),
                seconds: durationSec(t) || null,
                BPM: t?.BPM ?? t?.bpm ?? t?.audio?.bpm ?? t?.tags?.BPM ?? t?.tags?.tempoBPM ?? null,
                energy: t?.Energy ?? t?.energy ?? t?.audio?.energy ?? t?.tags?.Energy ?? null,
                camelotKey: keyToCamelot(t),
              }));

              const next = await planOneTandaWithRetry({
                style,
                size: sizeTarget,
                remainingMinutes: Math.floor(remainingSeconds / 60),
                usedIds: usedIds,
                candidates,
                allStyleCandidates, // Add broader candidate pool
                orchestra: targetOrchestra,
                prevKey,
                onLLMOutput: streamLLMOutput,
                profiles, // Pass orchestra profiles for retry logic
              });

              const chosenTracks = [];
              for (const id of next.trackIds) {
                if (isUsed(id)) continue;
                const tr = resolveByAnyId(id);
                const trOrch = (tr?.artist ?? tr?.tags?.artist ?? tr?.metadata?.artist ?? "Unknown").trim();
                if (tr && trOrch === targetOrchestra) {
                  chosenTracks.push(tr);
                  markUsed(getId(tr));
                }
              }
              while (chosenTracks.length < sizeTarget) {
                chosenTracks.push({ placeholder: true, style, title: "replace this" });
              }

              let tandaSeconds = chosenTracks.reduce((s, tr) => s + durationSec(tr), 0);
              if (tandaSeconds <= 0) tandaSeconds = 180 * chosenTracks.length;

              if (chosenTracks.length > 0 && tandaSeconds > 0 && tandaSeconds <= remainingSeconds + 30) {
                const tanda = {
                  style,
                  role,
                  tracks: chosenTracks,
                  seconds: tandaSeconds,
                  notes: next.notes ?? `Orchestra: ${targetOrchestra}`,
                };
                tandasResolved.push(tanda);
                remainingSeconds -= tandaSeconds;
                recentOrchestras.push(targetOrchestra);

                send({
                  type: "tanda",
                  index: tandasResolved.length,
                  remainingSeconds,
                  tanda: {
                    style: tanda.style,
                    role: tanda.role,
                    seconds: tanda.seconds,
                    notes: tanda.notes,
                    tracks: tanda.tracks.map(pickTrackFieldsForClient),
                  },
                });

                const lastTrack = chosenTracks[chosenTracks.length - 1];
                const lk = keyToCamelot(lastTrack);
                if (lk) prevKey = lk;
                tandaMade = true;
              }
            }
          }
        } catch {
          // fall through to style-only fallback
        }

        // ---------- 3) Fallback: style-only shortlist, role-aware scoring ----------
        if (!tandaMade) {
          const { slim: styleOnly } = shortlistCandidates(style, workingSet, usedIds, 100);

          // Role-aware total continuity scoring
          const scoreByContinuity = (t) => {
            if (!t) return 1e9;
            const bpm = t?.BPM ?? t?.bpm ?? t?.audio?.bpm ?? t?.tags?.BPM ?? t?.tags?.tempoBPM ?? null;
            const en  = t?.Energy ?? t?.energy ?? t?.audio?.energy ?? t?.tags?.Energy ?? null;
            const cam = keyToCamelot(t);
            // soft continuity costs against prevKey
            const kPrev = prevKey && cam ? Math.min(4, (() => {
              const order = [
                "1A","2A","3A","4A","5A","6A","7A","8A","9A","10A","11A","12A",
                "1B","2B","3B","4B","5B","6B","7B","8B","9B","10B","11B","12B",
              ];
              const i = order.indexOf(prevKey), j = order.indexOf(cam);
              if (i < 0 || j < 0) return 99;
              const d = Math.abs(i - j);
              return Math.min(d, 24 - d);
            })()) : 0;

            const contCost = 0.7 * kPrev; // keep modest
            const boost    = roleScoreBoost(t, role);
            // Lower is better (cost minus boost)
            return contCost - boost;
          };

          // Sort by score (lower is better) - use the imported scoreTrackByRole function
          styleOnly.sort((a, b) =>
            (scoreTrackByRole(resolveByAnyId(b.id), role, []) + roleScoreBoost(resolveByAnyId(b.id), role)) -
            (scoreTrackByRole(resolveByAnyId(a.id), role, []) + roleScoreBoost(resolveByAnyId(a.id), role))
          );

          const next = await planOneTandaWithRetry({
            style,
            size: sizeTarget,
            remainingMinutes: Math.floor(remainingSeconds / 60),
            usedIds: usedIds,
            candidates: styleOnly.slice(0, 60),
            allStyleCandidates: styleOnly, // Use full styleOnly as broader pool
            orchestra: null,
            prevKey,
            onLLMOutput: streamLLMOutput,
            profiles, // Pass orchestra profiles for retry logic
          });

          const chosenTracks = [];
          for (const id of next.trackIds) {
            if (isUsed(id)) continue;
            const tr = resolveByAnyId(id);
            if (tr) {
              chosenTracks.push(tr);
              markUsed(getId(tr));
            }
          }
          while (chosenTracks.length < sizeTarget) {
            chosenTracks.push({ placeholder: true, style, title: "replace this" });
          }

          const tandaSeconds = chosenTracks.reduce((s, tr) => s + durationSec(tr), 0) || 180 * chosenTracks.length;
          const realTrackCount = chosenTracks.filter(t => t.id && !t.placeholder && t.title !== "replace this").length;
          
          if (chosenTracks.length > 0 && tandaSeconds > 0 && tandaSeconds <= remainingSeconds + 30 && realTrackCount >= 1) {
            const tanda = {
              style,
              role,
              tracks: chosenTracks,
              seconds: tandaSeconds,
              notes: next.notes ?? `(Style-only fallback: ${realTrackCount} real tracks)`,
            };
            tandasResolved.push(tanda);
            remainingSeconds -= tandaSeconds;

            send({
              type: "tanda",
              index: tandasResolved.length,
              remainingSeconds,
              tanda: {
                style: tanda.style,
                role: tanda.role,
                seconds: tanda.seconds,
                notes: tanda.notes,
                tracks: tanda.tracks.map(pickTrackFieldsForClient),
              },
            });

            const lastTrack = chosenTracks[chosenTracks.length - 1];
            const lk = keyToCamelot(lastTrack);
            if (lk) prevKey = lk;
          }
        }
      } // end for(slots)

      // ------------------------ Cortinas, plan blocks, summary ------------------------
      const nTandas = tandasResolved.length;
      const cortinaGenresIn =
        req.body?.cortinaGenres ?? req.body?.cortina_genres ?? req.body?.genres ?? undefined;

      const cortinas = await listCortinas({
        tandasCount: nTandas,
        includeFinal: false,
        genres: cortinaGenresIn,
        shuffle: true,
      });

      const planBlocks = [];
      for (let i = 0; i < nTandas; i++) {
        const td = tandasResolved[i];
        const approxMinutes = Math.max(1, Math.round((td.seconds || 0) / 60));

        planBlocks.push({
          type: "tanda",
          style: td.style,
          role: td.role,
          size: td.tracks.length,
          approxMinutes,
          tracks: td.tracks.map(pickTrackFieldsForClient),
        });

        if (i < nTandas - 1) {
          const hasPool = Array.isArray(cortinas) && cortinas.length > 0;
          const c = hasPool ? cortinas[i % cortinas.length] : null;

          planBlocks.push({
            type: "cortina",
            style: "Cortina",
            size: 1,
            approxMinutes: c?.approxMinutes ?? 1,
            tracks: [{
              id: c?.id || null,
              title: c?.title || "Cortina",
              artist: c?.artist ?? c?.singer ?? null,
              BPM: null,
              Energy: null,
              Key: null,
              camelotKey: null,
              seconds: Number.isFinite(c?.seconds)
                ? c.seconds
                : Math.round((c?.approxMinutes ?? 1) * 60),
            }],
            streamId: c?.id || null,
            artist: c?.artist ?? null,
            singer: c?.singer ?? null,
          });
        }
      }

      const timeline = (function buildDisplayTimeline(resolvedTandas) {
        const fmtClock = (totalSec) => {
          const s = Math.max(0, Math.round(totalSec));
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sec = s % 60;
          return h > 0
            ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
            : `${m}:${String(sec).padStart(2, "0")}`;
        };

        const toSeconds = (t) => durationSec(t) || 0;

        const timeline = [];
        let cursor = 0;
        for (let i = 0; i < resolvedTandas.length; i++) {
          const td = resolvedTandas[i];
          const tandaStart = cursor;
          let trackCursor = tandaStart;

          const tracks = td.tracks.map((tr, j) => {
            const title  = tr?.title ?? tr?.tags?.title ?? tr?.metadata?.title ?? "Unknown";
            const artist = (tr?.artist ?? tr?.tags?.artist ?? tr?.metadata?.artist ?? "Unknown").trim();
            const seconds = toSeconds(tr) || Math.round((td.seconds || 0) / Math.max(1, td.tracks.length));
            const startSec = trackCursor;
            const endSec = trackCursor + seconds;
            trackCursor = endSec;

            return {
              index: j + 1,
              id: getId(tr),
              title, artist,
              seconds,
              startSec, endSec,
              startClock: fmtClock(startSec),
              endClock: fmtClock(endSec),
            };
          });

          const tandaEnd = trackCursor;
          timeline.push({
            index: i + 1,
            style: td.style,
            role: td.role ?? null,
            durationSec: td.seconds,
            startSec: tandaStart,
            endSec: tandaEnd,
            startClock: fmtClock(tandaStart),
            endClock: fmtClock(tandaEnd),
            tracks,
          });
          cursor = tandaEnd;
        }
        return timeline;
      })(tandasResolved);

      const summary = (function summarize(resolved, minutesRequested) {
        const minutesPlanned = Math.round(resolved.reduce((s, td) => s + td.seconds, 0) / 60);
        const byStyle = resolved.reduce((acc, td) => {
          acc[td.style] = (acc[td.style] || 0) + 1;
          return acc;
        }, {});
        const byRole = resolved.reduce((acc, td) => {
          const r = td.role || "n/a";
          acc[r] = (acc[r] || 0) + 1;
          return acc;
        }, {});
        const trackCount = resolved.reduce((s, td) => s + td.tracks.length, 0);
        const totalTrackSecs = resolved.reduce(
          (s, td) => s + td.tracks.reduce((ss, tr) => ss + durationSec(tr), 0),
          0
        );
        const avgTrackLenSec = trackCount ? Math.round(totalTrackSecs / trackCount) : 0;

        return {
          minutesRequested,
          minutesPlanned,
          tandaCount: resolved.length,
          byStyle,
          byRole,
          trackCount,
          avgTrackLenSec,
        };
      })(tandasResolved, minutes);

      // Final validation: check for tandas with insufficient real tracks
      const emptyTandas = tandasResolved.filter(td => {
        const realTracks = td.tracks.filter(t => t.id && !t.placeholder && t.title !== "replace this");
        return realTracks.length === 0;
      });

      if (emptyTandas.length > 0) {
        send({ 
          type: "warning", 
          message: `⚠ ${emptyTandas.length} tanda(s) generated with no real tracks. Consider expanding your music library or adjusting filters.`,
          emptyTandas: emptyTandas.map((td, i) => ({ index: i, style: td.style, role: td.role }))
        });
      }

      // Report overall generation quality
      const totalTandas = tandasResolved.length;
      const goodTandas = tandasResolved.filter(td => {
        const realTracks = td.tracks.filter(t => t.id && !t.placeholder && t.title !== "replace this");
        return realTracks.length >= Math.max(1, td.tracks.length * 0.5); // At least 50% real tracks
      }).length;

      send({ 
        type: "quality", 
        message: `Generation quality: ${goodTandas}/${totalTandas} tandas have sufficient tracks`,
        qualityScore: totalTandas > 0 ? Math.round((goodTandas / totalTandas) * 100) : 0
      });

      send({ type: "summary", summary });
      send({
        type: "done",
        plan: { tandas: planBlocks, cortinas, warnings: [] },
        display: { timeline, summary },
      });
      return res.end();
    } catch (e) {
      console.error("=== NDJSON ROUTE ERROR ===");
      console.error("Error type:", typeof e);
      console.error("Error constructor:", e?.constructor?.name);
      console.error("Error message:", e?.message);
      console.error("Error stack:", e?.stack);
      console.error("Full error object:", e);
      
      try {
        const errorMsg = e?.message || String(e) || "Unknown error";
        send({ type: "error", error: errorMsg, details: { 
          type: typeof e, 
          constructor: e?.constructor?.name,
          stack: e?.stack?.split('\n')?.slice(0, 5)?.join('\n') // first 5 lines of stack
        }});
      } finally {
        return res.end();
      }
    }
}
  )}