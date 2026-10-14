// Chiave condivisa con lo script Apps Script, letta solo dal segreto PEC_SECRET di Supabase.
// (Il periodo di transizione con PEC_SECRET_OLD è finito il 14/10/2026.)

const CHIAVE = (Deno.env.get("PEC_SECRET") ?? "").trim();

export function chiaveUsata(req: Request): "nuova" | null {
  return (req.headers.get("Authorization") || "") === `Bearer ${CHIAVE}` ? "nuova" : null;
}

export const chiaviConfigurate = CHIAVE.length >= 32;
