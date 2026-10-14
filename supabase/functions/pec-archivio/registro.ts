// Registro degli atti PEC (tabella pec_atti). Una scrittura che non riesce viene solo
// annotata nel log: non deve mai fermare la mail né l'appuntamento.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const TIPI_REGISTRO = ["decreto_commissione", "convocazione", "revoca", "cessazione"] as const;
export const MOTIVI = ["non_trovato", "ambiguo", "cartella_mancante", "senza_pdf"] as const;

export type RigaAtto = {
  ospite_id: string | null;
  struttura_id: string | null;
  tipo_atto: string;
  rn: string | null;
  data_pec: string | null;
  oggetto_pec: string | null;
  link_documento: string | null;
  decisione: string | null;
  procedura: string | null;
  data_audizione: string | null;
  ora_audizione: string | null;
  appuntamento_id: string | null;
  stato: "archiviata" | "da_verificare";
  motivo: string | null;
  origine: "automatica";
};

const fmtRoma = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });

function dataValida(a: number, m: number, g: number): string | null {
  const t = new Date(Date.UTC(a, m - 1, g));
  if (t.getUTCFullYear() !== a || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== g) return null;
  return `${a}-${String(m).padStart(2, "0")}-${String(g).padStart(2, "0")}`;
}

// Data della PEC (giorno a Roma) da quello che manda lo script: "14/10/2026", "14/10/2026 10:30",
// "2026-10-14" oppure una data completa con l'ora ("2026-10-14T08:30:00.000Z"). Se non si capisce: null.
export function dataPecIso(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const it = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?!\d)/.exec(s);
  if (it) return dataValida(Number(it[3]), Number(it[2]), Number(it[1]));
  const solo = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (solo) return dataValida(Number(solo[1]), Number(solo[2]), Number(solo[3]));
  const t = new Date(s);
  return isNaN(t.getTime()) ? null : fmtRoma.format(t);
}

function vuotoNull(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

export function rigaAtto(p: {
  tipo: string;
  ospite: { id?: string; struttura_id?: string | null } | null;
  rn: string;
  oggetto: string;
  dataPec: string;
  link?: string;
  decisione?: string | null;
  procedura?: string | null;
  dataAudizione?: string | null;
  oraAudizione?: string | null;
  appuntamentoId?: string | null;
  motivo?: string | null;
}): RigaAtto {
  const rn = vuotoNull(p.rn) ?? /\bRN\d{5,}\b/.exec(p.oggetto)?.[0] ?? null;
  return {
    ospite_id: vuotoNull(p.ospite?.id),
    struttura_id: vuotoNull(p.ospite?.struttura_id ?? null),
    tipo_atto: p.tipo,
    rn,
    data_pec: dataPecIso(p.dataPec),
    oggetto_pec: vuotoNull(p.oggetto),
    link_documento: vuotoNull(p.link),
    decisione: vuotoNull(p.decisione),
    procedura: vuotoNull(p.procedura),
    data_audizione: vuotoNull(p.dataAudizione),
    ora_audizione: vuotoNull(p.oraAudizione),
    appuntamento_id: vuotoNull(p.appuntamentoId),
    stato: p.motivo ? "da_verificare" : "archiviata",
    motivo: p.motivo && (MOTIVI as readonly string[]).includes(p.motivo) ? p.motivo : null,
    origine: "automatica",
  };
}

export type EsitoRegistro = { registrato: boolean; id?: string; nota: string };

// Inserisce la riga. Se l'atto c'è già (stessi RN, tipo e data, oppure stesso documento) non lo duplica;
// se c'era come "da verificare" e ora arriva archiviato, completa quella riga.
export async function registraAtto(db: SupabaseClient, riga: RigaAtto): Promise<EsitoRegistro> {
  try {
    if (!(TIPI_REGISTRO as readonly string[]).includes(riga.tipo_atto)) {
      console.error(`[pec-archivio] pec_atti: tipo "${riga.tipo_atto}" non previsto, riga non scritta`);
      return { registrato: false, nota: `tipo ${riga.tipo_atto} non previsto` };
    }
    const { data, error } = await db.from("pec_atti").insert(riga).select("id").single();
    if (!error) return { registrato: true, id: data.id as string, nota: "inserito" };
    if (error.code !== "23505") {
      console.error(`[pec-archivio] pec_atti: scrittura non riuscita (${error.message})`);
      return { registrato: false, nota: error.message };
    }
    if (riga.stato === "archiviata" && riga.rn && riga.data_pec) {
      const { data: agg, error: e2 } = await db.from("pec_atti").update(riga)
        .eq("rn", riga.rn).eq("tipo_atto", riga.tipo_atto).eq("data_pec", riga.data_pec).eq("stato", "da_verificare")
        .select("id");
      if (e2) {
        console.error(`[pec-archivio] pec_atti: aggiornamento non riuscito (${e2.message})`);
        return { registrato: false, nota: e2.message };
      }
      if (agg && agg.length) return { registrato: true, id: agg[0].id as string, nota: "completata la riga da verificare" };
    }
    console.log(`[pec-archivio] pec_atti: atto già registrato (${riga.rn ?? riga.link_documento ?? "senza RN"})`);
    return { registrato: false, nota: "già registrato" };
  } catch (e) {
    console.error(`[pec-archivio] pec_atti: errore (${String((e as Error)?.message ?? e)})`);
    return { registrato: false, nota: "errore" };
  }
}
