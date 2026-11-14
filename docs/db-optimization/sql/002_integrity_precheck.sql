-- ============================================================================
-- Phase 2 PRE-CHECK — run on the real database BEFORE 002_integrity_up.sql. READ-ONLY.
-- Every query must return ZERO rows. A non-zero result means existing data violates the rule:
-- fix the data (or drop that one constraint from 002) — never force it.
-- ============================================================================

-- stock can never be negative (writes are guarded; this proves history agrees)
SELECT 'stock.quantity < 0' AS violation, id FROM stock WHERE quantity < 0
UNION ALL SELECT 'stock_by_type.quantity < 0', id FROM stock_by_type WHERE quantity < 0
UNION ALL SELECT 'stock_by_type exceeds stock total', s.id FROM stock s
  JOIN (SELECT branch_id, product_id, SUM(quantity) q FROM stock_by_type GROUP BY 1,2) t USING (branch_id, product_id) WHERE t.q > s.quantity
-- enumerated text columns: values outside the set the code writes
UNION ALL SELECT 'bills.payment_mode', id FROM bills WHERE payment_mode IS NOT NULL AND payment_mode NOT IN ('CASH','CARD','UPI','CREDIT')
UNION ALL SELECT 'credit_transactions.payment_mode', id FROM credit_transactions WHERE payment_mode IS NOT NULL AND payment_mode NOT IN ('CASH','CARD','UPI')
UNION ALL SELECT 'expenses.payment_mode', id FROM expenses WHERE payment_mode NOT IN ('CASH','CARD','UPI','BANK')
UNION ALL SELECT 'bank_statement_lines.status', id FROM bank_statement_lines WHERE status NOT IN ('UNMATCHED','SUGGESTED','MATCHED','IGNORED')
UNION ALL SELECT 'bank_accounts.scope', id FROM bank_accounts WHERE scope NOT IN ('BRANCH','SYNDICATE')
UNION ALL SELECT 'ledger_transactions.direction', id FROM ledger_transactions WHERE direction NOT IN ('DEBIT','CREDIT')
UNION ALL SELECT 'subscription_invoices.status', id FROM subscription_invoices WHERE status NOT IN ('PENDING','PAID','VOID')
UNION ALL SELECT 'print_jobs.status/target', id FROM print_jobs WHERE status NOT IN ('PENDING','SENT','FAILED') OR target NOT IN ('NETWORK','AGENT')
-- accounting: one side per line, never negative
UNION ALL SELECT 'journal_lines sign/side', id FROM journal_lines WHERE debit < 0 OR credit < 0 OR (debit > 0 AND credit > 0)
-- every voucher balances (this is data, not a constraint: a CHECK can not span rows)
UNION ALL SELECT 'UNBALANCED voucher', voucher_id FROM journal_lines GROUP BY voucher_id HAVING SUM(debit) <> SUM(credit)
-- bill lines
UNION ALL SELECT 'bill_items.quantity <= 0', id FROM bill_items WHERE quantity <= 0
UNION ALL SELECT 'kot_items.quantity <= 0', id FROM kot_items WHERE quantity <= 0
-- orphans for the FKs in 002. products.last_invoice_id rows here are REPAIRED by 002 (backed up, then cleared); report them, do not block
UNION ALL SELECT 'products.last_invoice_id orphan', p.id FROM products p LEFT JOIN supplier_invoices i ON i.id = p.last_invoice_id WHERE p.last_invoice_id IS NOT NULL AND i.id IS NULL
-- bank_statement_lines.account_id must equal its statement's account
UNION ALL SELECT 'bank line account mismatch', l.id FROM bank_statement_lines l JOIN bank_statements s ON s.id = l.statement_id WHERE s.account_id <> l.account_id;
