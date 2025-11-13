// agent/orchestraAgent.js
import { Agent } from "@openai/agents";
import { OpenAIResponsesModel, setDefaultOpenAIKey } from "@openai/agents-openai";
import { NextOrchestras } from "../schemas/nextOrchestras.js";

setDefaultOpenAIKey(process.env.OPENAI_API_KEY);

export const orchestraAgent = new Agent({
  name: "NextOrchestraRanker",
  instructions: [
    "You propose orchestras to follow the current tanda.",
    "Constraints:",
    "- Respect the requested style.",
    "- Prefer continuity: small Camelot key changes from prevKey when possible.",
    "- Prefer one-orchestra-per-tanda convention; avoid repeating the last 1–2 orchestras unless musically justified.",
    "- Prefer era/time-period coherence when available (e.g., Golden age before Golden-ish; modern → modern).",
    "- Prefer energy continuity; avoid large jumps unless explicitly beneficial.",
    "Return a ranked list with short reasons. JSON only.",
  ].join(" "),
  outputType: NextOrchestras,
  model: "gpt-4o",
});
