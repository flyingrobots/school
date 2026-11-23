-- 0003: where the learner left off, for the home page (flyingrobots/school#39).
--
-- What this adds:
--   * last_studied() -> at most one row of (course, lesson, at): the course and lesson of the
--     record's latest activity, ordered by seq (RFC 3 §3.4), never by `at`. Activity is an
--     encounter opened, an answer or explanation stored, or a view recorded. A refused submission
--     stores nothing, and a resumed encounter adds no row, so neither moves it. No row on an empty
--     record. Reads only; granted to school_app like every function the port calls.

CREATE FUNCTION school.last_studied() RETURNS TABLE (course text, lesson text, at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT t.course, t.lesson, t.at FROM (
    SELECT e.course, e.lesson, e.at, e.seq FROM school.encounters e
    UNION ALL
    SELECT e.course, e.lesson, a.at, a.seq FROM school.answers a JOIN school.encounters e ON e.id = a.encounter_id
    UNION ALL
    SELECT e.course, e.lesson, x.at, x.seq FROM school.explanations x JOIN school.encounters e ON e.id = x.encounter_id
    UNION ALL
    SELECT v.course, v.lesson, v.at, v.seq FROM school.views v
  ) t
  ORDER BY t.seq DESC
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION school.last_studied() TO school_app;
