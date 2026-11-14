-- Phase 4 (UP, OPTIONAL) — retention by ARCHIVING, never discarding.
-- Each statement is one atomic "DELETE ... RETURNING" feeding an INSERT: a row is either in the live table or in the archive,
-- never both, never neither. Rollback = 004_retention_archive_down.sql moves everything back.
-- Run off-peak. Take the pre-flight backup first (08-deployment-runbook.md). Cut-offs are parameters you may change.

CREATE TABLE IF NOT EXISTS email_outbox_archive     (LIKE email_outbox     INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
CREATE TABLE IF NOT EXISTS print_jobs_archive       (LIKE print_jobs       INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
CREATE TABLE IF NOT EXISTS password_resets_archive  (LIKE password_resets  INCLUDING DEFAULTS INCLUDING CONSTRAINTS);

WITH moved AS (DELETE FROM email_outbox WHERE created_at < now() - interval '90 days' RETURNING *)
INSERT INTO email_outbox_archive SELECT * FROM moved;

-- only finished jobs; PENDING/FAILED stay live so the queue and retries are untouched
WITH moved AS (DELETE FROM print_jobs WHERE status = 'SENT' AND created_at < now() - interval '30 days' RETURNING *)
INSERT INTO print_jobs_archive SELECT * FROM moved;

-- only tokens that are used or expired
WITH moved AS (DELETE FROM password_resets WHERE (used_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '30 days' RETURNING *)
INSERT INTO password_resets_archive SELECT * FROM moved;
