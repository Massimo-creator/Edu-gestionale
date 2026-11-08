import { createClient } from "npm:@supabase/supabase-js@2";

// Archivia il PDF del report decadale nel bucket privato "report-amministrazione" e lo collega alla riga
// di report_decadi. Chiamata dalle attività programmate che preparano la bozza e la versione inviata.
// POST ?numero=N&tipo=bozza|inviato  (corpo: il PDF)  Authorization: Bearer <chiave vault cron_report_pdf>

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOME_CHIAVE = "report_pdf";
const BUCKET = "report-amministrazione";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function risposta(corpo: unknown, stato = 200): Response {
  return new Response(JSON.stringify(corpo), { status: stato, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: valida, error: errChiave } = await supabase.rpc("verifica_chiave_cron", { p_nome: NOME_CHIAVE, p_valore: token });
  if (errChiave) return risposta({ status: "errore", errore: `controllo chiave non riuscito: ${errChiave.message}` }, 500);
  if (valida !== true) return new Response("Unauthorized", { status: 401 });
  if (req.method !== "POST") return risposta({ status: "errore", errore: "usa POST" }, 405);

  const url = new URL(req.url);
  const numero = Number(url.searchParams.get("numero"));
  const tipo = url.searchParams.get("tipo") === "inviato" ? "inviato" : "bozza";
  if (!Number.isInteger(numero) || numero < 1) return risposta({ status: "errore", errore: "numero mancante" }, 400);

  const pdf = new Uint8Array(await req.arrayBuffer());
  if (pdf.length < 1000 || new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-") {
    return risposta({ status: "errore", errore: "il corpo non è un PDF" }, 400);
  }

  const { data: rep, error: errRep } = await supabase.from("report_decadi")
    .select("id, periodo_inizio, periodo_fine").eq("numero", numero).maybeSingle();
  if (errRep || !rep) return risposta({ status: "errore", errore: "report non trovato" }, 404);

  const percorso = `n${numero}/Report_CAS_n${numero}_${rep.periodo_inizio}_${rep.periodo_fine}${tipo === "bozza" ? "_BOZZA" : ""}.pdf`;
  const { error: errUp } = await supabase.storage.from(BUCKET)
    .upload(percorso, pdf, { contentType: "application/pdf", upsert: true });
  if (errUp) return risposta({ status: "errore", errore: errUp.message }, 500);

  const { error: errUpd } = await supabase.from("report_decadi")
    .update({ pdf_url: percorso, updated_at: new Date().toISOString() }).eq("id", rep.id);
  if (errUpd) return risposta({ status: "errore", errore: errUpd.message }, 500);

  return risposta({ status: "ok", percorso, byte: pdf.length });
});
