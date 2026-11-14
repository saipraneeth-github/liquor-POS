-- T01 DATA FINGERPRINT — run BEFORE and AFTER every phase; the two outputs must be identical.
-- Proves no row was lost, added or altered by DDL-only changes. Order-independent (md5 of rows sorted by id).
SELECT 'bills'                AS tbl, count(*) AS n, md5(string_agg(t::text, '|' ORDER BY id)) AS h FROM bills t
UNION ALL SELECT 'bill_items',            count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM bill_items t
UNION ALL SELECT 'stock',                 count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM stock t
UNION ALL SELECT 'stock_audit',           count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM stock_audit t
UNION ALL SELECT 'journal_vouchers',      count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM journal_vouchers t
UNION ALL SELECT 'journal_lines',         count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM journal_lines t
UNION ALL SELECT 'customers',             count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM customers t
UNION ALL SELECT 'credit_transactions',   count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM credit_transactions t
UNION ALL SELECT 'supplier_invoices',     count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM supplier_invoices t
UNION ALL SELECT 'kot_items',             count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM kot_items t
UNION ALL SELECT 'products',              count(*), md5(string_agg(t::text, '|' ORDER BY id)) FROM products t
ORDER BY 1;
