const replacementAgent = new Agent({
  name: "ReplacementAgent",
  instructions: [
    "You propose replacements for a single track inside a tanda.",
    "Hard rules:",
    "- Use ONLY track IDs from the provided CANDIDATES list.",
    "- Do NOT include any ID from USED_IDS.",
    "- Keep orchestra and style as requested.",
    "- Prefer coherence with the tanda context (BPM, energy, key proximity, era).",
    "Return ONLY ranked IDs as JSON; no prose.",
  ].join(" "),
  outputType: ReplacementOptions,
  model: "gpt-4o",
});
