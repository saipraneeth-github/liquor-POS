-- Phase 4 (DOWN) — put every archived row back, then remove the (now empty) archive tables.
-- Archive tables are only dropped when they are empty after the move-back, so a partial failure can never lose rows.
WITH moved AS (DELETE FROM email_outbox_archive    RETURNING *) INSERT INTO email_outbox    SELECT * FROM moved;
WITH moved AS (DELETE FROM print_jobs_archive      RETURNING *) INSERT INTO print_jobs      SELECT * FROM moved;
WITH moved AS (DELETE FROM password_resets_archive RETURNING *) INSERT INTO password_resets SELECT * FROM moved;
DO $$ BEGIN
  IF (SELECT count(*) FROM email_outbox_archive) = 0 AND (SELECT count(*) FROM print_jobs_archive) = 0 AND (SELECT count(*) FROM password_resets_archive) = 0 THEN
    DROP TABLE email_outbox_archive; DROP TABLE print_jobs_archive; DROP TABLE password_resets_archive;
  END IF;
END $$;
