// Esito della domanda letto dal testo della decisione di un decreto della Commissione.
// Serve a compilare il campo "Esito audizione" della scheda ospite (decisione di Massimo, 03/11/2026).
// Se il testo non è chiaro restituisce null: in quel caso la scheda resta com'è e la mail lo dice.
// Il testo può essere in italiano o, quando l'italiano non si legge, in una delle traduzioni.

export type EsitoDecreto = "Diniego" | "Protezione sussidiaria" | "Protezione speciale" | "Status di rifugiato";

export function esitoDaDecisione(decisione: string | null | undefined): EsitoDecreto | null {
  const intero = String(decisione ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // Solo il dispositivo: le note sul ricorso che seguono ("Nota: contro la presente decisione ...")
  // contengono negazioni che non riguardano l'esito.
  const t = intero.split(/\bnota\b|\bnote\b|\bavverso\b|\bcontro la presente\b|\bcontra la presente\b|\bagainst this\b/)[0];
  if (!t.trim()) return null;
  // Prima le protezioni "minori": un decreto può negare lo status e riconoscere la sussidiaria.
  if (/sussidiari|subsidiar/.test(t)) return "Protezione sussidiaria";
  if (/protezione speciale|special protection|proteccion especial|protection speciale/.test(t)) return "Protezione speciale";
  const rifugiato = /rifugiat|refugee|refugiad|refugie/.test(t);
  const negazione = /\bnon\b|\bnot\b|\bno\b|\bne pas\b|\bn'/.test(t) || /rigett|infondat|unfounded|reject/.test(t);
  if (rifugiato && !negazione) return "Status di rifugiato";
  if (negazione && /accogli|riconosc|protezione|protection|proteccion|grant|reconoc|reconna|domanda|application|solicitud|demande/.test(t)) {
    return "Diniego";
  }
  return null;
}

// Valori della scheda che si possono sovrascrivere: vuoto o "audizione fatta, in attesa di decisione".
export function esitoSovrascrivibile(attuale: string | null | undefined): boolean {
  const s = String(attuale ?? "").trim().toLowerCase();
  return s === "" || s === "commissione sostenuta";
}
