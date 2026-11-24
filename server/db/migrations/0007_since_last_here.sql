-- 0007: what happened since the learner was last here, for the home page (flyingrobots/school#165).
--
-- What this adds, both read-only and granted to school_app like every function the port calls:
--   * study_days(from, to, tz) -> rows of (course, day): each course's local days, in time zone
--     `tz`, with any activity in [from, to). Activity is what last_studied counts: an encounter
--     opened, an answer or explanation stored, or a view recorded. `at` is read only to place an
--     event in time, never to order the record (RFC 3 §3.4). Ordered by day, then course.
--   * latest_feedback() -> at most one row: the succeeded grading with the highest seq, with the
--     course, lesson and block of the explanation it grades. A failed attempt is never feedback,
--     and a later failed retry does not hide an earlier success.

CREATE FUNCTION school.study_days(p_from timestamptz, p_to timestamptz, p_tz text)
RETURNS TABLE (course text, day text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT DISTINCT t.course, to_char(t.at AT TIME ZONE p_tz, 'YYYY-MM-DD') AS day FROM (
    SELECT e.course, e.at FROM school.encounters e
    UNION ALL
    SELECT e.course, a.at FROM school.answers a JOIN school.encounters e ON e.id = a.encounter_id
    UNION ALL
    SELECT e.course, x.at FROM school.explanations x JOIN school.encounters e ON e.id = x.encounter_id
    UNION ALL
    SELECT v.course, v.at FROM school.views v
  ) t
  WHERE t.at >= p_from AND t.at < p_to
  ORDER BY day, t.course
$$;

GRANT EXECUTE ON FUNCTION school.study_days(timestamptz, timestamptz, text) TO school_app;

CREATE FUNCTION school.latest_feedback()
RETURNS TABLE (submission_id uuid, course text, lesson text, block_id text, model text, findings jsonb, at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT g.submission_id, e.course, e.lesson, x.block_id, g.model, g.findings, g.at
  FROM school.gradings g
  JOIN school.explanations x ON x.submission_id = g.submission_id
  JOIN school.encounters e ON e.id = x.encounter_id
  WHERE g.status = 'succeeded'
  ORDER BY g.seq DESC
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION school.latest_feedback() TO school_app;
