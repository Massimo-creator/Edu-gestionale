-- Bucket privato per i PDF del report decadale; li legge solo il Coordinatore.
-- La funzione Edge report-pdf carica i file con il service role, controllando la chiave cron_report_pdf (Vault).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-amministrazione', 'report-amministrazione', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "report_amm_coordinatore_legge" on storage.objects;
create policy "report_amm_coordinatore_legge" on storage.objects for select to authenticated
  using (bucket_id = 'report-amministrazione' and exists (select 1 from public.utenti u
         where lower(u.email) = lower(auth.jwt() ->> 'email') and u.ruolo = 'Coordinatore' and u.comunita_id is null));

select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'cron_report_pdf',
  'Chiave per caricare i PDF del report decadale (attività programmate -> funzione Edge report-pdf)')
where not exists (select 1 from vault.secrets where name = 'cron_report_pdf');
