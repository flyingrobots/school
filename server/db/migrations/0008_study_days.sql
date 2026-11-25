-- 0008: a study day is a day with study in it (flyingrobots/school#177).
--
-- study_days(from, to, tz) keeps its signature, grant and ordering, and now counts only an answer
-- stored or an explanation saved: retrieval, the part of studying that makes learning stick. An
-- encounter opened or a view recorded is a visit, not study, so it no longer makes a day a study
-- day. One answer is enough; there is no minimum. last_studied, which picks the lesson to resume,
-- still counts any activity. Glossary: "Study day".
CREATE OR REPLACE FUNCTION school.study_days(p_from timestamptz, p_to timestamptz, p_tz text)
RETURNS TABLE (course text, day text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT DISTINCT t.course, to_char(t.at AT TIME ZONE p_tz, 'YYYY-MM-DD') AS day FROM (
    SELECT e.course, a.at FROM school.answers a JOIN school.encounters e ON e.id = a.encounter_id
    UNION ALL
    SELECT e.course, x.at FROM school.explanations x JOIN school.encounters e ON e.id = x.encounter_id
  ) t
  WHERE t.at >= p_from AND t.at < p_to
  ORDER BY day, t.course
$$;
