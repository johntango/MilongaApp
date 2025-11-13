// schemas/nextOrchestras.js
import { z } from "zod";

export const NextOrchestras = z.object({
  style: z.enum(["Tango", "Vals", "Milonga"]),
  suggestions: z.array(z.object({
    orchestra: z.string(),          // exact name as in profiles input
    reason: z.string(),             // short rationale (≤ 200 chars ideal)
  })).min(1),
  warnings: z.array(z.string()).nullable(),  // required-but-nullable per Structured Outputs rules
});