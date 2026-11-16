-- Mail "accompagnamenti di domani" (con i certificati di ospitalità) anticipata alle 13 di Roma (decisione di Massimo, 16/11/2026).
-- Il job gira alle 11 e alle 12 UTC; la funzione parte solo quando a Roma sono le 13 (ora legale e solare).
select cron.alter_job(2, schedule := '0 11,12 * * *');
