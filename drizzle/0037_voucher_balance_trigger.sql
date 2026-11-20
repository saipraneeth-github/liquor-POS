-- A voucher must balance in the database itself, not only in application code: any bug, manual journal or
-- partly swallowed handler error used to be able to commit debit <> credit and silently skew the trial balance.
-- DEFERRABLE INITIALLY DEFERRED: all lines of a voucher are inserted first, the check runs once at COMMIT.
CREATE OR REPLACE FUNCTION assert_voucher_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  vid uuid;
  d numeric;
  c numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN vid := OLD.voucher_id; ELSE vid := NEW.voucher_id; END IF;
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0) INTO d, c FROM journal_lines WHERE voucher_id = vid;
  IF d <> c THEN
    RAISE EXCEPTION 'Voucher % is unbalanced: debit % <> credit %', vid, d, c USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_journal_voucher_balanced ON journal_lines;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_journal_voucher_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_voucher_balanced();
