-- T02 BUSINESS INVARIANTS — query RESULTS (not just structure) that must not change after a migration.
-- Each row is one invariant; `violations` must be 0 both before and after. Run on the real database too (read-only).
SELECT 'every PAID bill has at least one line' AS invariant, count(*) AS violations
  FROM bills b WHERE b.status = 'PAID' AND NOT EXISTS (SELECT 1 FROM bill_items i WHERE i.bill_id = b.id)
UNION ALL SELECT 'every voucher balances (debit = credit)', count(*) FROM
  (SELECT voucher_id FROM journal_lines GROUP BY voucher_id HAVING sum(debit) <> sum(credit)) x
UNION ALL SELECT 'stock never negative', count(*) FROM stock WHERE quantity < 0
UNION ALL SELECT 'sum of explicit sale-type counters <= shop stock', count(*) FROM stock s
  JOIN (SELECT branch_id, product_id, sum(quantity) q FROM stock_by_type GROUP BY 1,2) t USING (branch_id, product_id) WHERE t.q > s.quantity
UNION ALL SELECT 'customer balance = last credit_transactions.balance_after', count(*) FROM customers c
  JOIN LATERAL (SELECT balance_after FROM credit_transactions WHERE customer_id = c.id ORDER BY recorded_at DESC, id DESC LIMIT 1) l ON true
  WHERE c.current_credit <> l.balance_after
UNION ALL SELECT 'bill numbers are unique', count(*) FROM (SELECT bill_number FROM bills GROUP BY 1 HAVING count(*) > 1) x;
