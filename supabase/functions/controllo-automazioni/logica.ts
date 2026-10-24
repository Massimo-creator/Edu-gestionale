// Controllo delle automazioni: dalla fotografia del database (controllo_automazioni_dati) ricava i problemi.
// Logica pura, si prova da sola.

export type Stato = { nome: string; ultimo_ok: string | null; ultimo_errore: string | null; errore: string | null };
export type Dati = {
  adesso: string;
  stato: Stato[];
  errori: { nome: string; quando: string; messaggio: string | null }[];
  job_falliti: { job: string; quando: string; messaggio: string | null }[];
  job_attivi: { job: string; attivo: boolean }[];
};

// Ogni quante ore al massimo ci si aspetta un passaggio riuscito.
export const ATTESE: { nome: string; etichetta: string; ore: number; cosaFare: string }[] = [
  {
    nome: "pec-lettura",
    etichetta: "Lettura delle PEC (script Google \"Archivio PEC\", ogni 15 minuti)",
    ore: 2,
    cosaFare: "aprire lo script \"Archivio PEC\" in Google Apps Script e controllare in \"Esecuzioni\" se ci sono errori o se l'attivatore è ancora attivo.",
  },
  {
    nome: "questura-promemoria",
    etichetta: "Promemoria Questura (ogni mattina alle 8)",
    ore: 26,
    cosaFare: "avvisare chi segue Approdo: il promemoria di ieri non è partito.",
  },
  {
    nome: "accompagnamenti-domani",
    etichetta: "Accompagnamenti di domani (ogni sera alle 18)",
    ore: 26,
    cosaFare: "avvisare chi segue Approdo: ieri sera gli operatori non hanno ricevuto la mail.",
  },
  {
    nome: "appuntamenti-da-aggiornare",
    etichetta: "Appuntamenti da aggiornare (dal lunedì al venerdì alle 12:15)",
    ore: 76, // copre il fine settimana: il lunedì mattina l'ultimo passaggio è del venerdì
    cosaFare: "avvisare chi segue Approdo: il promemoria agli operatori non è partito.",
  },
];

export const NOMI: Record<string, string> = {
  ...Object.fromEntries(ATTESE.map((a) => [a.nome, a.etichetta])),
  "pec-archivio": "Mail sugli atti arrivati via PEC",
  "controllo-automazioni": "Controllo delle automazioni",
};

const fmt = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome", weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});
export function quando(iso: string | null): string {
  return iso ? fmt.format(new Date(iso)).replace(",", "") : "mai";
}

export type Esito = {
  problemi: string[]; // righe per la mail di allarme
  inAttesa: string[]; // automazioni che non hanno ancora registrato nessun passaggio
  ultimi: string[]; // ultimo passaggio di ogni automazione, per la mail del lunedì
};

export function valuta(d: Dati): Esito {
  const adesso = new Date(d.adesso).getTime();
  const perNome = new Map(d.stato.map((s) => [s.nome, s]));
  const problemi: string[] = [];
  const inAttesa: string[] = [];
  const ultimi: string[] = [];

  for (const a of ATTESE) {
    const s = perNome.get(a.nome);
    if (!s || !s.ultimo_ok) {
      if (s?.ultimo_errore) {
        problemi.push(`${a.etichetta}: non è mai andata a buon fine. Ultimo errore ${quando(s.ultimo_errore)}: ${s.errore ?? "non indicato"}. Cosa fare: ${a.cosaFare}`);
      } else {
        inAttesa.push(a.etichetta);
      }
      ultimi.push(`${a.etichetta}: nessun passaggio registrato finora`);
      continue;
    }
    const ore = (adesso - new Date(s.ultimo_ok).getTime()) / 3600000;
    ultimi.push(`${a.etichetta}: ultimo passaggio ${quando(s.ultimo_ok)}`);
    if (ore > a.ore) {
      problemi.push(`${a.etichetta}: ferma. Ultimo passaggio riuscito ${quando(s.ultimo_ok)}. Cosa fare: ${a.cosaFare}`);
    }
  }

  // Errori delle ultime 24 ore, raggruppati: lo stesso errore ripetuto (es. ogni 15 minuti) diventa una riga sola.
  const gruppi = new Map<string, { nome: string; messaggio: string; volte: number; primo: string; ultimo: string }>();
  for (const e of d.errori) {
    const messaggio = e.messaggio ?? "errore non descritto";
    const k = `${e.nome}|${messaggio}`;
    const g = gruppi.get(k);
    if (g) { g.volte++; g.ultimo = e.quando; } else gruppi.set(k, { nome: e.nome, messaggio, volte: 1, primo: e.quando, ultimo: e.quando });
  }
  for (const g of gruppi.values()) {
    const tempi = g.volte === 1 ? quando(g.primo) : `${g.volte} volte, da ${quando(g.primo)} a ${quando(g.ultimo)}`;
    problemi.push(`${NOMI[g.nome] ?? g.nome}, ${tempi}: ${g.messaggio}`);
  }
  for (const j of d.job_falliti) {
    problemi.push(`Invio programmato "${j.job}" fallito ${quando(j.quando)}${j.messaggio ? `: ${j.messaggio}` : ""}`);
  }
  for (const j of d.job_attivi.filter((x) => !x.attivo)) {
    problemi.push(`L'invio programmato "${j.job}" risulta disattivato.`);
  }
  return { problemi, inAttesa, ultimi };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const FONT = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5";

export function mailAllarme(e: Esito): { oggetto: string; html: string } {
  const n = e.problemi.length;
  return {
    oggetto: `⚠️ Approdo: ${n === 1 ? "un problema" : `${n} problemi`} nelle automazioni`,
    html: `<div style="${FONT}"><p>Il controllo di stamattina ha trovato ${n === 1 ? "questo problema" : "questi problemi"}:</p>` +
      `<p>${e.problemi.map((p) => `– ${esc(p)}`).join("<br><br>")}</p>` +
      (e.inAttesa.length ? `<p style="color:#64748b">Non ancora controllate (non hanno ancora registrato nessun passaggio): ${e.inAttesa.map(esc).join("; ")}.</p>` : "") +
      `<p style="color:#64748b;font-size:12px">Questa mail arriva solo quando qualcosa non va. Il lunedì arriva comunque un riepilogo.</p></div>`,
  };
}

export function mailSettimanale(e: Esito): { oggetto: string; html: string } {
  return {
    oggetto: "✅ Approdo: automazioni a posto",
    html: `<div style="${FONT}"><p>${e.inAttesa.length
      ? "Controllo del lunedì: nessun problema trovato, ma alcune automazioni non hanno ancora registrato nessun passaggio (vedi sotto)."
      : "Controllo del lunedì: le automazioni di Approdo funzionano."}</p>` +
      `<p>${e.ultimi.map((u) => `– ${esc(u)}`).join("<br>")}</p>` +
      `<p style="color:#64748b;font-size:12px">Se un lunedì questa mail non arriva, vuol dire che si è fermato anche il controllo.</p></div>`,
  };
}
