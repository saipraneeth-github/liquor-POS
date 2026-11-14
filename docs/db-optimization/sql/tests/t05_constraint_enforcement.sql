-- T05 CONSTRAINT ENFORCEMENT — after Phase 2 the database must REJECT bad data and still ACCEPT good data.
-- Every probe runs in its own BEGIN/EXCEPTION block that is rolled back, so no row is left behind.
-- Needs at least one branch, user, product, bill, voucher, ledger, stock row and bank statement (the harness seeds them;
-- on a real database run this on a restored staging copy, never on production).
CREATE TEMP TABLE IF NOT EXISTS _ce (probe text, expected text, actual text, ok boolean);
TRUNCATE _ce;
DO $$
DECLARE
  p  uuid := (SELECT id FROM products LIMIT 1);
  bl uuid := (SELECT id FROM bills LIMIT 1);
  v  uuid := (SELECT id FROM journal_vouchers LIMIT 1);
  l  uuid := (SELECT id FROM account_ledgers LIMIT 1);
  st uuid := (SELECT id FROM bank_statements LIMIT 1);
  r  text;
BEGIN
  r := NULL; BEGIN UPDATE bills SET payment_mode = 'BITCOIN' WHERE id = bl; r := 'ACCEPTED'; RAISE EXCEPTION 'probe-rollback';
  EXCEPTION WHEN check_violation THEN r := 'REJECTED'; WHEN OTHERS THEN r := COALESCE(r, 'ERR:' || SQLERRM); END;
  INSERT INTO _ce VALUES ('unknown payment mode', 'REJECTED', r, r = 'REJECTED');

  r := NULL; BEGIN INSERT INTO journal_lines (voucher_id, ledger_id, debit, credit) VALUES (v, l, 10, 10); r := 'ACCEPTED'; RAISE EXCEPTION 'probe-rollback';
  EXCEPTION WHEN check_violation THEN r := 'REJECTED'; WHEN OTHERS THEN r := COALESCE(r, 'ERR:' || SQLERRM); END;
  INSERT INTO _ce VALUES ('journal line with debit AND credit', 'REJECTED', r, r = 'REJECTED');

  r := NULL; BEGIN INSERT INTO journal_lines (voucher_id, ledger_id, debit, credit) VALUES (v, l, -5, 0); r := 'ACCEPTED'; RAISE EXCEPTION 'probe-rollback';
  EXCEPTION WHEN check_violation THEN r := 'REJECTED'; WHEN OTHERS THEN r := COALESCE(r, 'ERR:' || SQLERRM); END;
  INSERT INTO _ce VALUES ('negative journal amount', 'REJECTED', r, r = 'REJECTED');

  r := NULL; BEGIN INSERT INTO bill_items (bill_id, product_id, quantity, unit_price, tax_rate, tax_amount, line_total) VALUES (bl, p, 0, 1, 0, 0, 0); r := 'ACCEPTED'; RAISE EXCEPTION 'probe-rollback';
  EXCEPTION WHEN check_violation THEN r := 'REJECTED'; WHEN OTHERS THEN r := COALESCE(r, 'ERR:' || SQLERRM); END;
  INSERT INTO _ce VALUES ('zero-quantity bill line', 'REJECTED', r, r = 'REJECTED');

  r := NULL; BEGIN INSERT INTO bank_statement_lines (statement_id, account_id, line_no, txn_date, hash) VALUES (st, gen_random_uuid(), 1, current_date, 'probe'); r := 'ACCEPTED'; RAISE EXCEPTION 'probe-rollback';
  EXCEPTION WHEN foreign_key_violation THEN r := 'REJECTED'; WHEN OTHERS THEN r := COALESCE(r, 'ERR:' || SQLERRM); END;
  INSERT INTO _ce VALUES ('bank line whose account differs from its statement''s', 'REJECTED', r, r = 'REJECTED');

  r := NULL; BEGIN UPDATE products SET last_invoice_id = gen_random_uuid() WHERE id = p; r := 'ACCEPTED'; RAISE EXCEPTION 'probe-rollback';
  EXCEPTION WHEN foreign_key_violation THEN r := 'REJECTED'; WHEN OTHERS THEN r := COALESCE(r, 'ERR:' || SQLERRM); END;
  INSERT INTO _ce VALUES ('product pointing at a non-existent invoice', 'REJECTED', r, r = 'REJECTED');

  -- good data must still go through
  r := NULL; BEGIN UPDATE bills SET payment_mode = 'UPI' WHERE id = bl; r := 'ACCEPTED'; RAISE EXCEPTION 'probe-rollback';
  EXCEPTION WHEN OTHERS THEN r := COALESCE(r, 'ERR:' || SQLERRM); END;
  INSERT INTO _ce VALUES ('valid payment mode UPI', 'ACCEPTED', r, r = 'ACCEPTED');

  r := NULL; BEGIN INSERT INTO journal_lines (voucher_id, ledger_id, debit, credit) VALUES (v, l, 10, 0); r := 'ACCEPTED'; RAISE EXCEPTION 'probe-rollback';
  EXCEPTION WHEN OTHERS THEN r := COALESCE(r, 'ERR:' || SQLERRM); END;
  INSERT INTO _ce VALUES ('valid one-sided journal line', 'ACCEPTED', r, r = 'ACCEPTED');
END $$;
SELECT * FROM _ce;
