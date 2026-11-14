-- T03 REFERENTIAL INTEGRITY — generic: for EVERY foreign key in the schema count child rows whose parent is missing,
-- and list any constraint that is still NOT VALID. The result must be empty after each phase.
CREATE TEMP TABLE IF NOT EXISTS _ri (check_name text, bad bigint);
TRUNCATE _ri;
DO $$
DECLARE r record; n bigint;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS child, c.confrelid::regclass AS parent,
           (SELECT string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' AND ' ORDER BY k.ord)
              FROM unnest(c.conkey, c.confkey) WITH ORDINALITY k(cattnum, pattnum, ord)
              JOIN pg_attribute ca ON ca.attrelid = c.conrelid  AND ca.attnum = k.cattnum
              JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.pattnum) AS joincond,
           (SELECT string_agg(format('c.%I IS NOT NULL', ca.attname), ' AND ')
              FROM unnest(c.conkey) k(cattnum) JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.cattnum) AS notnull
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('SELECT count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)', r.child, r.notnull, r.parent, r.joincond) INTO n;
    IF n > 0 THEN INSERT INTO _ri VALUES (r.conname || ' (' || r.child || ' -> ' || r.parent || ')', n); END IF;
  END LOOP;
  INSERT INTO _ri SELECT 'NOT VALID constraint: ' || conname, 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated;
END $$;
SELECT * FROM _ri;
