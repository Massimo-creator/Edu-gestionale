import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// La chiave condivisa con il job pianificato (pg_cron) sta solo nella cassaforte (Vault) del database:
// la controlla la funzione SQL verifica_chiave_cron, che solo il service role può chiamare.
const NOME_CHIAVE = "accompagnamenti_domani";

// Gli indirizzi si leggono dagli utenti di Approdo (stessa fonte delle altre automazioni).
// Questo elenco serve solo per chi non è tra gli utenti (es. Paola, Mediazione Linguistica).
const EXTRA: Record<string, string> = {
  "Paola": "paola@coopmetis.com",
  "Mediazione Linguistica": "mediazione@coopmetis.com",
};
const EMAIL_MASSIMO = "m.andreoni@coopmetis.com";

// Decisioni di Massimo (09/11/2026):
// - la mail parte alle 15 (prima era alle 18);
// - il venerdì avvisa per sabato, domenica e lunedì; sabato e domenica non parte nulla;
// - per la Questura si allegano i certificati di ospitalità (generati qui, con la data dell'appuntamento);
// - senza operatore assegnato non parte nessuna mail all'operatore: a Massimo arriva l'elenco
//   delle Questure senza accompagnatore (o "In autonomia"), con i relativi certificati.
const ORA_INVIO = 15; // ora di Roma alla quale parte la mail

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const fmtGiorno = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
const dataItaliaISO = (d: Date) => fmtGiorno.format(d);
function oraItalia(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}
function oraRomaAdesso(): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
}
// Somma giorni a una data AAAA-MM-GG (calcolo sul calendario, senza fusi orari).
function piuGiorni(iso: string, n: number): string {
  const [a, m, g] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, g + n)).toISOString().slice(0, 10);
}
function giornoSettimana(iso: string): number { // 1 = lunedì ... 7 = domenica
  const [a, m, g] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, g)).getUTCDay() || 7;
}
function etichettaGiorno(iso: string): string {
  const [a, m, g] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, g, 12)).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
// Giorni da avvisare oggi: domani; il venerdì sabato, domenica e lunedì; sabato e domenica nessuno.
function giorniDaAvvisare(oggi: string): string[] {
  const gs = giornoSettimana(oggi);
  if (gs === 6 || gs === 7) return [];
  if (gs === 5) return [piuGiorni(oggi, 1), piuGiorni(oggi, 2), piuGiorni(oggi, 3)];
  return [piuGiorni(oggi, 1)];
}

// Toglie dalle note il codice tecnico della sincronizzazione con l'Excel (es. [sync:questura-sheet:...]).
function notaPulita(n: unknown): string {
  return String(n ?? "").replace(/\[sync:[^\]]*\]/g, "").replace(/\s+\n/g, "\n").trim();
}
// deno-lint-ignore no-explicit-any
function etichettaOra(a: any): string {
  return a.ora_da_definire ? "Ora da definire" : `Ore ${oraItalia(new Date(a.data_ora))}`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Battito per il controllo delle automazioni (non blocca mai l'invio).
async function registra(esito: "ok" | "errore", messaggio: string): Promise<void> {
  await supabase.rpc("registra_automazione", { p_nome: "accompagnamenti-domani", p_esito: esito, p_messaggio: messaggio });
}

type Allegato = { filename: string; content: string };
async function inviaMail(to: string, subject: string, html: string, attachments: Allegato[] = []): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ to, subject, html, attachments }),
  });
  return res.ok;
}

// Esito del certificato per un appuntamento in Questura
type Cert =
  | { esito: "ok"; nominativo: string; ospite_id: string; allegato: Allegato; inclusi: string[] }
  | { esito: "incluso"; nominativo: string; in: string }
  | { esito: "escluso"; nominativo: string; motivo: string };

async function certificato(appuntamentoId: string): Promise<Cert> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/certificati-ospitalita`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ azione: "genera_appuntamento", appuntamento_id: appuntamentoId }),
    });
    const r = await res.json();
    if (r.esito === "ok") return { esito: "ok", nominativo: r.nominativo, ospite_id: r.ospite_id, allegato: { filename: r.nomeFile, content: r.pdfBase64 }, inclusi: r.inclusi ?? [] };
    if (r.esito === "incluso") return { esito: "incluso", nominativo: r.nominativo, in: r.in };
    return { esito: "escluso", nominativo: r.nominativo ?? "", motivo: r.motivo ?? r.errore ?? "errore nella generazione" };
  } catch (e) {
    return { esito: "escluso", nominativo: "", motivo: `errore nella generazione (${String((e as Error)?.message ?? e)})` };
  }
}
function notaCertificato(c: Cert | undefined): string {
  if (!c) return "";
  if (c.esito === "ok") return c.inclusi.length ? ` <i>(certificato allegato, comprende ${esc(c.inclusi.join(", "))})</i>` : " <i>(certificato allegato)</i>";
  if (c.esito === "incluso") return ` <i>(nel certificato di ${esc(c.in)})</i>`;
  return ` <i>(certificato NON generato: ${esc(c.motivo)})</i>`;
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: valida, error: errChiave } = await supabase.rpc("verifica_chiave_cron", { p_nome: NOME_CHIAVE, p_valore: token });
  if (errChiave) {
    return new Response(JSON.stringify({ status: "errore", messaggio: `controllo chiave non riuscito: ${errChiave.message}` }), { status: 500 });
  }
  if (valida !== true) return new Response("Unauthorized", { status: 401 });

  // prova=1: non invia nulla e non genera certificati, mostra cosa farebbe (con data=AAAA-MM-GG si sceglie il giorno);
  // forza=1 ignora il controllo dell'ora (e, con data=, avvisa per quel giorno).
  const url = new URL(req.url);
  const prova = url.searchParams.get("prova") === "1";
  const forza = url.searchParams.get("forza") === "1";
  const dataScelta = url.searchParams.get("data") || "";

  // Il job gira alle 13 e alle 14 UTC: parte solo quando a Roma sono le 15, con ora legale e solare.
  if (!prova && !forza && oraRomaAdesso() !== ORA_INVIO) {
    return new Response(JSON.stringify({ status: "ok", inviate: 0, motivo: `a Roma non sono le ${ORA_INVIO}` }), { status: 200 });
  }

  const oggi = dataItaliaISO(new Date());
  const giorni = /^\d{4}-\d{2}-\d{2}$/.test(dataScelta) && (prova || forza) ? [dataScelta] : giorniDaAvvisare(oggi);
  if (giorni.length === 0) {
    if (!prova) await registra("ok", "fine settimana: nessun avviso");
    return new Response(JSON.stringify({ status: "ok", inviate: 0, motivo: "fine settimana" }), { status: 200 });
  }

  const [{ data: appuntamenti, error }, { data: utenti, error: errUtenti }] = await Promise.all([
    supabase.from("appuntamenti_cas")
      .select("id, tipo, data_ora, ora_da_definire, ospite_id, ospite_nome, operatore_accompagnatore, note, stato, strutture_cas(nome)")
      .gte("data_ora", new Date(Date.parse(`${giorni[0]}T00:00:00Z`) - 3 * 3600e3).toISOString())
      .lte("data_ora", new Date(Date.parse(`${giorni[giorni.length - 1]}T23:59:59Z`) + 3 * 3600e3).toISOString()),
    supabase.from("utenti").select("nome, email").is("comunita_id", null),
  ]);
  if (error || errUtenti) {
    if (!prova) await registra("errore", `lettura dal database non riuscita: ${(error ?? errUtenti)!.message}`);
    return new Response(JSON.stringify({ status: "errore", messaggio: (error ?? errUtenti)!.message }), { status: 500 });
  }

  // nome (minuscolo) -> email: prima gli utenti di Approdo, poi l'elenco EXTRA
  const indirizzi = new Map<string, string>();
  for (const [nome, email] of Object.entries(EXTRA)) indirizzi.set(nome.toLowerCase(), email);
  for (const u of utenti ?? []) {
    const nome = String(u.nome ?? "").trim().toLowerCase();
    const email = String(u.email ?? "").trim();
    if (nome && email.includes("@")) indirizzi.set(nome, email);
  }

  // deno-lint-ignore no-explicit-any
  const delGiorno = (appuntamenti || []).filter((a: any) => giorni.includes(dataItaliaISO(new Date(a.data_ora))) && a.stato !== "Annullato");
  // deno-lint-ignore no-explicit-any
  const operatoreDi = (a: any) => String(a.operatore_accompagnatore ?? "").trim();
  // deno-lint-ignore no-explicit-any
  const conOperatore = delGiorno.filter((a: any) => operatoreDi(a) && operatoreDi(a) !== "In autonomia");
  // deno-lint-ignore no-explicit-any
  const questura = delGiorno.filter((a: any) => a.tipo === "Questura");
  // deno-lint-ignore no-explicit-any
  const questuraSenzaOperatore = questura.filter((a: any) => !operatoreDi(a) || operatoreDi(a) === "In autonomia");

  // Certificati di ospitalità per tutte le Questure dei giorni da avvisare (anche senza accompagnatore)
  const certificati = new Map<string, Cert>();
  if (!prova) {
    for (const a of questura) certificati.set(a.id, await certificato(a.id));
  }

  const etichette = giorni.map(etichettaGiorno);
  const titoloGiorni = etichette.length === 1 ? etichette[0] : `${etichette.slice(0, -1).join(", ")} e ${etichette[etichette.length - 1]}`;

  // deno-lint-ignore no-explicit-any
  const righe = (lista: any[]) => {
    const perGiorno = new Map<string, string[]>();
    for (const a of [...lista].sort((x, y) => Date.parse(x.data_ora) - Date.parse(y.data_ora))) {
      const g = dataItaliaISO(new Date(a.data_ora));
      const riga = `• ${etichettaOra(a)} — ${esc(a.tipo)} — ${esc(a.ospite_nome || "(nome non indicato)")}` +
        (notaPulita(a.note) ? ` (${esc(notaPulita(a.note))})` : "") + (a.tipo === "Questura" ? notaCertificato(certificati.get(a.id)) : "");
      if (!perGiorno.has(g)) perGiorno.set(g, []);
      perGiorno.get(g)!.push(riga);
    }
    return [...perGiorno.entries()].map(([g, r]) => (giorni.length > 1 ? `<p><b>${etichettaGiorno(g)}</b><br>` : "<p>") + r.join("<br>") + "</p>").join("");
  };
  // deno-lint-ignore no-explicit-any
  const allegatiDi = (lista: any[]) => {
    const visti = new Set<string>();
    const out: Allegato[] = [];
    for (const a of lista) {
      const c = certificati.get(a.id);
      if (c?.esito === "ok" && !visti.has(c.ospite_id)) { visti.add(c.ospite_id); out.push(c.allegato); }
    }
    return out;
  };

  // deno-lint-ignore no-explicit-any
  const perOperatore: Record<string, any[]> = {};
  for (const a of conOperatore) (perOperatore[operatoreDi(a)] ??= []).push(a);

  let inviate = 0;
  const nonMappati: string[] = [];
  const fallite: string[] = [];
  const anteprima: { operatore: string; email: string; appuntamenti: number; questura: number }[] = [];

  for (const [nome, lista] of Object.entries(perOperatore)) {
    const email = indirizzi.get(nome.toLowerCase());
    if (!email) { nonMappati.push(nome); continue; }
    // deno-lint-ignore no-explicit-any
    const nQuestura = lista.filter((a: any) => a.tipo === "Questura").length;
    if (prova) { anteprima.push({ operatore: nome, email, appuntamenti: lista.length, questura: nQuestura }); continue; }
    const allegati = allegatiDi(lista);
    const html = `<p>Ciao ${esc(nome)},</p><p>${giorni.length > 1 ? "Ecco" : "Domani"} i tuoi accompagnamenti${giorni.length > 1 ? ` di <b>${titoloGiorni}</b>` : ` (<b>${titoloGiorni}</b>)`}:</p>` +
      righe(lista) +
      (allegati.length ? `<p>In allegato trovi i certificati di ospitalità per la Questura (${allegati.length}), già firmati e con la data dell'appuntamento.</p>` : "") +
      "<p>Buon lavoro,<br>Approdo</p>";
    if (await inviaMail(email, `Approdo — Accompagnamenti di ${titoloGiorni}`, html, allegati)) inviate++;
    else fallite.push(`${nome} (${email})`);
  }

  // Avviso a Massimo: Questure senza accompagnatore, certificati non generati, operatori senza indirizzo o mail non partite.
  const certProblemi = [...certificati.entries()].filter(([, c]) => c.esito === "escluso");
  const servAvviso = questuraSenzaOperatore.length || certProblemi.length || nonMappati.length || fallite.length;
  if (servAvviso && !prova) {
    const parti: string[] = [];
    if (questuraSenzaOperatore.length) {
      parti.push(`<p><b>Questura senza accompagnatore assegnato</b> (a questi non è partita nessuna mail):</p>` + righe(questuraSenzaOperatore));
    }
    if (certProblemi.length) {
      parti.push("<p><b>Certificati di ospitalità NON generati</b> (da fare a mano):</p><p>" +
        certProblemi.map(([id, c]) => {
          // deno-lint-ignore no-explicit-any
          const a = questura.find((x: any) => x.id === id);
          return `• ${esc(a?.ospite_nome || (c as { nominativo: string }).nominativo)}: ${esc((c as { motivo: string }).motivo)}`;
        }).join("<br>") + "</p>");
    }
    if (nonMappati.length) parti.push(`<p>Per questi accompagnatori non ho un indirizzo email: <b>${esc(nonMappati.join(", "))}</b>. Vanno aggiunti tra gli utenti di Approdo.</p>`);
    if (fallite.length) parti.push(`<p>Per questi accompagnatori l'invio non è riuscito: <b>${esc(fallite.join(", "))}</b>.</p>`);
    const allegati = allegatiDi(questuraSenzaOperatore);
    if (allegati.length) parti.push(`<p>In allegato i certificati di ospitalità degli appuntamenti senza accompagnatore (${allegati.length}).</p>`);
    await inviaMail(EMAIL_MASSIMO, `Approdo — Accompagnamenti di ${titoloGiorni}: da verificare`, parti.join(""), allegati);
  }

  if (prova) {
    return new Response(JSON.stringify({
      status: "ok", prova: true, giorni, anteprima, nonMappati,
      // deno-lint-ignore no-explicit-any
      questura: questura.map((a: any) => ({ ospite: a.ospite_nome, operatore: operatoreDi(a) || null, ora: etichettaOra(a) })),
      questura_senza_operatore: questuraSenzaOperatore.length,
    }), { status: 200 });
  }
  const certOk = [...certificati.values()].filter((c) => c.esito === "ok").length;
  if (nonMappati.length || fallite.length || certProblemi.length) {
    await registra("errore", [
      nonMappati.length ? `senza indirizzo: ${nonMappati.join(", ")}` : "",
      fallite.length ? `invio non riuscito: ${fallite.join(", ")}` : "",
      certProblemi.length ? `certificati non generati: ${certProblemi.length}` : "",
    ].filter(Boolean).join("; "));
  } else {
    await registra("ok", `${inviate} mail inviate, ${certOk} certificati`);
  }
  return new Response(JSON.stringify({ status: "ok", giorni, inviate, certificati: certOk, nonMappati, fallite }), { status: 200 });
});
