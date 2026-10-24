-- Appuntamenti: ogni operatore di Approdo (utente CAS) può inserire, modificare e cancellare gli appuntamenti
-- di tutti gli ospiti, di qualunque struttura. Gli appuntamenti in Questura restano solo a Parfait e al
-- coordinatore (che passa dalla regola coordinatore_tutto). Decisione di Massimo del 24/10/2026.
-- Prima la regola valeva solo per gli ospiti delle strutture assegnate all'operatore (operatori_strutture),
-- e la Questura era riservata solo nella pagina, non nel database.

alter policy educatore_sue_strutture on public.appuntamenti_cas
  using (
    exists (select 1 from public.utenti u
             where lower(u.email) = lower(auth.jwt() ->> 'email') and u.comunita_id is null)
    and (tipo is distinct from 'Questura' or lower(auth.jwt() ->> 'email') = 'p.ndri@coopmetis.com')
  )
  with check (
    exists (select 1 from public.utenti u
             where lower(u.email) = lower(auth.jwt() ->> 'email') and u.comunita_id is null)
    and (tipo is distinct from 'Questura' or lower(auth.jwt() ->> 'email') = 'p.ndri@coopmetis.com')
  );

alter policy educatore_sue_strutture on public.appuntamenti_cas rename to operatori_tutti_tranne_questura;
