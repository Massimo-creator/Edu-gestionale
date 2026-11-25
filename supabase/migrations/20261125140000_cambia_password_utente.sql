-- Permette a ogni utente di cambiare la propria password da Approdo.
-- Verifica la password attuale (hash SHA-256 in public.utenti) e aggiorna sia public.utenti sia auth.users.
create or replace function public.cambia_password_utente(p_email text, p_password_attuale text, p_password_nuova text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := lower(trim(p_email));
  v_hash text;
begin
  if p_password_nuova is null or length(p_password_nuova) < 8 then
    return 'troppo_corta';
  end if;
  select password_hash into v_hash from public.utenti where lower(email) = v_email limit 1;
  if v_hash is null then
    return 'utente_non_trovato';
  end if;
  if v_hash <> encode(extensions.digest(p_password_attuale, 'sha256'), 'hex') then
    return 'password_errata';
  end if;
  update public.utenti
     set password_hash = encode(extensions.digest(p_password_nuova, 'sha256'), 'hex')
   where lower(email) = v_email;
  update auth.users
     set encrypted_password = extensions.crypt(p_password_nuova, extensions.gen_salt('bf')),
         updated_at = now()
   where lower(email) = v_email;
  return 'ok';
end;
$$;
revoke all on function public.cambia_password_utente(text, text, text) from public;
grant execute on function public.cambia_password_utente(text, text, text) to anon, authenticated;
