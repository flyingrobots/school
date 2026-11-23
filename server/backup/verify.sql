-- Every table of School's record with its row count and a digest of its rows, for comparing a
-- restored database with the one it came from (docs/workflows/backup-and-restore/README.md):
-- two databases holding the same record print the same lines. Read-only; run it as the superuser,
-- since school_app may not read tables:
--
--   docker compose exec -T backup psql --dbname=<database> --tuples-only --no-align < backup/verify.sql
SELECT format('%I.%I', table_schema, table_name),
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text AS rows,
  (xpath('/row/h/text()', query_to_xml(format('SELECT md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) AS h FROM %I.%I t', table_schema, table_name), false, true, '')))[1]::text AS md5
FROM information_schema.tables
WHERE table_schema IN ('school', 'public') AND table_type = 'BASE TABLE'
ORDER BY 1;
