-- 0009: the learner's chosen time zone (flyingrobots/school#181).
--
-- What this adds:
--   * time_zone_choices, append-only like every record table: each choice the learner makes in
--     Settings, with when. A NULL zone is a choice too: back to automatic, the zone the browser
--     sends. The newest choice, by seq, is the one in force.
--   * choose_time_zone(zone, at) appends a choice; time_zone() is the zone in force, or NULL.
-- The server checks a zone against the IANA database before it gets here (Intl); the table only
-- bounds its shape. Both functions are granted to school_app like every function the port calls.
CREATE TABLE school.time_zone_choices (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  zone text CONSTRAINT time_zone_choices_zone CHECK (zone IS NULL OR (length(zone) <= 64 AND zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$')),
  at timestamptz NOT NULL
);

CREATE TRIGGER time_zone_choices_append_only BEFORE UPDATE OR DELETE ON school.time_zone_choices FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER time_zone_choices_no_truncate BEFORE TRUNCATE ON school.time_zone_choices FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();

CREATE FUNCTION school.choose_time_zone(p_zone text, p_at timestamptz) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  INSERT INTO school.time_zone_choices (zone, at) VALUES (p_zone, p_at)
$$;
GRANT EXECUTE ON FUNCTION school.choose_time_zone(text, timestamptz) TO school_app;

CREATE FUNCTION school.time_zone() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT c.zone FROM school.time_zone_choices c ORDER BY c.seq DESC LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION school.time_zone() TO school_app;
