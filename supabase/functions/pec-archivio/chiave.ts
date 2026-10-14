// Chiave condivisa con lo script Apps Script, letta solo dai segreti di Supabase.
// Durante il cambio di chiave valgono sia PEC_SECRET (nuova) sia PEC_SECRET_OLD (vecchia, temporanea):
// quando lo script usa la nuova, si toglie PEC_SECRET_OLD e resta valida solo PEC_SECRET.

const CHIAVI = [
  { nome: "nuova", valore: (Deno.env.get("PEC_SECRET") ?? "").trim() },
  { nome: "vecchia", valore: (Deno.env.get("PEC_SECRET_OLD") ?? "").trim() },
].filter((c) => c.valore.length >= 32);

// "nuova" | "vecchia" se la richiesta porta una chiave valida, altrimenti null.
export function chiaveUsata(req: Request): "nuova" | "vecchia" | null {
  const h = req.headers.get("Authorization") || "";
  const c = CHIAVI.find((x) => h === `Bearer ${x.valore}`);
  if (c?.nome === "vecchia") console.log("[pec-archivio] accesso con la chiave vecchia (PEC_SECRET_OLD)");
  return (c?.nome as "nuova" | "vecchia" | undefined) ?? null;
}

export const chiaviConfigurate = CHIAVI.length > 0;
