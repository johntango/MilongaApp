export function scoreTrackByRole(track, role, tandaSoFar = []) {
  const year = track.tags?.year ?? 0;
  const artist = (track.tags?.artist || "").toLowerCase();

  const pool = orchestraByRole[role] || [];
  let score = 0;

  for (const entry of pool) {
    const match = artist.includes(entry.name.toLowerCase());
    const yearMatch = year >= entry.era[0] && year <= entry.era[1];
    if (match && yearMatch) score += 60;
    else if (match) score += 30;
    else if (yearMatch) score += 20;
  }

  if (tandaSoFar.some(t => (t.tags?.artist || "").toLowerCase() === artist)) {
    score -= 40; // avoid repetition
  }

  return score;
}

const orchestraByRole = {
  classic: [
    { name: "Juan D'Arienzo", era: [1935, 1945] },
    { name: "Rodolfo Biagi", era: [1938, 1944] },
    { name: "Alfredo De Angelis", era: [1940, 1952] },
  ],
  rich: [
    { name: "Anibal Troilo", era: [1940, 1955] },
    { name: "Ricardo Tanturi", era: [1940, 1950] },
    { name: "Carlos Di Sarli", era: [1940, 1958] },
  ],
  modern: [
    { name: "Osvaldo Pugliese", era: [1950, 1970] },
    { name: "Color Tango", era: [1990, 2010] },
    { name: "Sexteto Milonguero", era: [2005, 2020] },
  ],
  alt: [
    { name: "Otros Aires", era: [2005, 2020] },
    { name: "Tanghetto", era: [2005, 2020] },
    { name: "Bajofondo", era: [2002, 2015] },
  ],
};
// /agent/planner.js
const b64u = {
  enc: (s) => Buffer.from(String(s)).toString("base64url"),
  dec: (s) => Buffer.from(String(s), "base64url").toString("utf8"),
};

export function inferRoleByPosition(pos) {
  if (pos <= 2) return "classic";
  if (pos <= 5) return "rich";
  if (pos === 6) return "alt";
  return "modern";
}
