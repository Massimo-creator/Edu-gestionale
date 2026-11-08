-- Registro attività di Approdo: accessi e modifiche ai dati.
-- Le modifiche sono registrate da trigger nel database (qualunque sia la provenienza:
-- interfaccia, script di sincronizzazione, funzioni). Gli accessi dalla funzione registra_accesso().
-- Il registro è in sola lettura e lo legge solo il Coordinatore. Nessuno può modificarlo o cancellarlo.

create table if not exists public.registro_attivita (
  id            bigint generated always as identity primary key,
  creato_il     timestamptz not null default now(),
  tipo          text not null check (tipo in ('accesso','creazione','modifica','eliminazione')),
  origine       text not null check (origine in ('utente','sistema','non_identificato')),
  utente_email  text,
  utente_nome   text,
  tabella       text,
  record_id     uuid,
  ospite_id     uuid,
  etichetta     text,
  modifiche     jsonb,   -- solo per 'modifica': { campo: { "prima": ..., "dopo": ... } }
  dati          jsonb,   -- per 'creazione' ed 'eliminazione': il record completo
  dettagli      jsonb    -- per 'accesso': informazioni sul dispositivo
);

create index if not exists registro_attivita_creato_il_idx on public.registro_attivita (creato_il desc);
create index if not exists registro_attivita_utente_idx    on public.registro_attivita (utente_email, creato_il desc);
create index if not exists registro_attivita_ospite_idx    on public.registro_attivita (ospite_id, creato_il desc);
create index if not exists registro_attivita_tabella_idx   on public.registro_attivita (tabella, record_id);

alter table public.registro_attivita enable row level security;

drop policy if exists solo_coordinatore_legge on public.registro_attivita;
create policy solo_coordinatore_legge on public.registro_attivita
  for select to authenticated
  using (exists (select 1 from public.utenti u
                 where lower(u.email) = lower(auth.jwt() ->> 'email')
                   and u.ruolo = 'Coordinatore' and u.comunita_id is null));

-- Nessuna policy di scrittura: si scrive solo tramite le funzioni qui sotto.
revoke insert, update, delete, truncate on public.registro_attivita from anon, authenticated;

-- Nome leggibile di chi agisce, a partire dall'email.
create or replace function public.registro_nome_utente(p_email text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(trim(coalesce(u.nome,'') || ' ' || coalesce(u.cognome,'')), '')
       from public.utenti u where lower(u.email) = lower(p_email) limit 1),
    p_email)
$$;

create or replace function public.registro_nome_struttura(p_id text)
returns text language sql stable security definer set search_path = public as $$
  select s.nome from public.strutture_cas s where s.id::text = p_id limit 1
$$;

-- Trigger generico per le modifiche.
create or replace function public.registra_modifica()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_email    text := auth.jwt() ->> 'email';
  v_ruolo    text := coalesce(auth.jwt() ->> 'role', '');
  v_origine  text;
  v_old      jsonb;
  v_new      jsonb;
  v_r        jsonb;
  v_diff     jsonb := '{}'::jsonb;
  v_k        text;
  v_tipo     text;
  v_etich    text;
  v_ospite   uuid;
  v_esclusi  text[] := array['password_hash','updated_at'];
begin
  begin
    if v_email is not null then
      v_origine := 'utente';
    elsif v_ruolo = 'service_role' or current_user in ('postgres','supabase_admin','service_role') then
      v_origine := 'sistema';
    else
      v_origine := 'non_identificato';
    end if;

    if tg_op = 'INSERT' then
      v_tipo := 'creazione';
      v_new  := to_jsonb(new) - 'password_hash';
      v_r    := v_new;
    elsif tg_op = 'DELETE' then
      v_tipo := 'eliminazione';
      v_old  := to_jsonb(old) - 'password_hash';
      v_r    := v_old;
    else
      v_tipo := 'modifica';
      v_old  := to_jsonb(old);
      v_new  := to_jsonb(new);
      v_r    := v_new;
      for v_k in select jsonb_object_keys(v_new) loop
        if not (v_k = any(v_esclusi)) and (v_old -> v_k) is distinct from (v_new -> v_k) then
          v_diff := v_diff || jsonb_build_object(v_k, jsonb_build_object('prima', v_old -> v_k, 'dopo', v_new -> v_k));
        end if;
      end loop;
      -- un aggiornamento che non cambia nulla (es. sincronizzazione) non si registra
      if v_diff = '{}'::jsonb then
        return null;
      end if;
    end if;

    -- ospite collegato, per filtrare il registro per ospite
    if tg_table_name = 'ospiti_cas' then
      v_ospite := (v_r ->> 'id')::uuid;
    elsif v_r ? 'ospite_id' and (v_r ->> 'ospite_id') is not null then
      v_ospite := (v_r ->> 'ospite_id')::uuid;
    end if;

    -- etichetta leggibile
    v_etich := case tg_table_name
      when 'ospiti_cas' then trim(coalesce(v_r->>'nome','') || ' ' || coalesce(v_r->>'cognome',''))
      when 'appuntamenti_cas' then concat_ws(' · ', v_r->>'tipo', coalesce(v_r->>'ospite_nome', v_r->>'titolo'),
             to_char((v_r->>'data_ora')::timestamptz at time zone 'Europe/Rome', 'DD/MM/YYYY HH24:MI'))
      when 'strutture_cas' then v_r->>'nome'
      when 'operatori_strutture' then concat_ws(' → ', v_r->>'operatore_email', registro_nome_struttura(v_r->>'struttura_id'))
      when 'turni_cas' then concat_ws(' · ', v_r->>'operatore_nome', to_char((v_r->>'data')::date, 'DD/MM/YYYY'), v_r->>'tipo')
      when 'manutenzioni_cas' then concat_ws(' · ', registro_nome_struttura(v_r->>'struttura_id'), v_r->>'titolo')
      when 'pocket_money_cas' then concat_ws(' · ', registro_nome_struttura(v_r->>'struttura_id'), (v_r->>'mese') || '/' || (v_r->>'anno'))
      when 'cassette_ps_cas' then concat_ws(' · ', registro_nome_struttura(v_r->>'struttura_id'), (v_r->>'mese') || '/' || (v_r->>'anno'))
      when 'trasferimenti_cas' then concat_ws(' · ', v_r->>'ospite_nome', v_r->>'stato')
      when 'calendario_personale_cas' then concat_ws(' · ', v_r->>'operatore_nome', v_r->>'titolo',
             to_char((v_r->>'data_ora')::timestamptz at time zone 'Europe/Rome', 'DD/MM/YYYY HH24:MI'))
      when 'calendario_coordinatore_cas' then concat_ws(' · ', v_r->>'titolo',
             to_char((v_r->>'data_ora')::timestamptz at time zone 'Europe/Rome', 'DD/MM/YYYY HH24:MI'))
      when 'riunioni_cas' then concat_ws(' · ', v_r->>'titolo',
             to_char((v_r->>'data_ora')::timestamptz at time zone 'Europe/Rome', 'DD/MM/YYYY'))
      when 'odg_riunioni_cas' then left(v_r->>'punto', 100)
      when 'richieste_ferie_cas' then concat_ws(' · ', v_r->>'operatore_nome', v_r->>'tipo',
             to_char((v_r->>'data_inizio')::date, 'DD/MM') || ' - ' || to_char((v_r->>'data_fine')::date, 'DD/MM/YYYY'))
      when 'richieste_cambio_accompagnatore_cas' then concat_ws(' → ', v_r->>'operatore_attuale', v_r->>'operatore_proposto')
      when 'clio_prenotazioni' then concat_ws(' · ', v_r->>'operatore_nome',
             to_char((v_r->>'inizio')::timestamptz at time zone 'Europe/Rome', 'DD/MM/YYYY HH24:MI'))
      when 'pec_atti' then concat_ws(' · ', v_r->>'tipo_atto', left(v_r->>'oggetto_pec', 80))
      when 'utenti' then concat_ws(' · ', trim(coalesce(v_r->>'nome','') || ' ' || coalesce(v_r->>'cognome','')), v_r->>'email')
      else null end;

    insert into public.registro_attivita
      (tipo, origine, utente_email, utente_nome, tabella, record_id, ospite_id, etichetta, modifiche, dati)
    values
      (v_tipo, v_origine, v_email,
       case when v_email is not null then registro_nome_utente(v_email) end,
       tg_table_name, (v_r ->> 'id')::uuid, v_ospite, nullif(v_etich, ''),
       case when v_tipo = 'modifica' then v_diff end,
       case when v_tipo <> 'modifica' then v_r end);
  exception when others then
    -- il registro non deve mai bloccare il lavoro: se qualcosa va storto, la modifica passa comunque
    raise warning 'registro_attivita: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke execute on function public.registra_modifica() from public, anon, authenticated;

-- Accessi: chiamata dall'interfaccia subito dopo il login.
create or replace function public.registra_accesso(p_email text default null, p_dettagli jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_email text := auth.jwt() ->> 'email';
  v_verificato boolean := v_email is not null;
begin
  if v_email is null then v_email := left(lower(trim(p_email)), 200); end if;
  if v_email is null or v_email = '' then return; end if;
  insert into public.registro_attivita (tipo, origine, utente_email, utente_nome, dettagli)
  values ('accesso', case when v_verificato then 'utente' else 'non_identificato' end,
          v_email, registro_nome_utente(v_email),
          jsonb_build_object('sessione_verificata', v_verificato) || coalesce(p_dettagli, '{}'::jsonb));
end;
$$;

grant execute on function public.registra_accesso(text, jsonb) to anon, authenticated;

-- Trigger sulle tabelle di Approdo CAS
do $$
declare t text;
begin
  foreach t in array array[
    'ospiti_cas','appuntamenti_cas','strutture_cas','operatori_strutture','turni_cas',
    'manutenzioni_cas','pocket_money_cas','cassette_ps_cas','trasferimenti_cas',
    'calendario_personale_cas','calendario_coordinatore_cas','riunioni_cas','odg_riunioni_cas',
    'richieste_ferie_cas','richieste_cambio_accompagnatore_cas','clio_prenotazioni','pec_atti','utenti']
  loop
    execute format('drop trigger if exists registro_attivita_trg on public.%I', t);
    execute format('create trigger registro_attivita_trg after insert or update or delete on public.%I
                    for each row execute function public.registra_modifica()', t);
  end loop;
end $$;
