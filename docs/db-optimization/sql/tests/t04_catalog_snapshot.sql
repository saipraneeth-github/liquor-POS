-- T04 CATALOG SNAPSHOT — a hash of every index, constraint and column definition. Taken before Phase 1 and again after the
-- DOWN scripts: equal hashes prove the rollback restored the schema exactly.
SELECT 'indexes' AS part, count(*) AS n, md5(string_agg(indexdef, ';' ORDER BY indexname)) AS h
  FROM pg_indexes WHERE schemaname = 'public'
UNION ALL SELECT 'constraints', count(*), md5(string_agg(conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conrelid::regclass::text, conname))
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace
UNION ALL SELECT 'columns', count(*), md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ';' ORDER BY table_name, column_name))
  FROM information_schema.columns WHERE table_schema = 'public';
