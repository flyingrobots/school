-- 0012: what the record holds under a course name (RFC 7 §5.2; flyingrobots/school#237).
--
-- A course's name is its progress key. Before a course is installed under a name, its preview says
-- whether the record already has progress there (a course removed earlier, or one that was
-- configured before), so the learner can choose to continue it or pick another name.
--
-- What this adds:
--   * course_progress(course): how many encounters were opened under the name, how many quiz answers
--     and explanations were given in them, and how many views were recorded under it. Reads only.
--     Granted to school_app.
--
-- Decision notes are not counted: each cites evidence of its course, which is one of the encounters
-- or answers counted here.

-- course_progress(course) -> one row (encounters, answers, explanations, views), each a count, 0 for none.
CREATE FUNCTION school.course_progress(p_course text)
RETURNS TABLE (encounters integer, answers integer, explanations integer, views integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT
    (SELECT count(*)::integer FROM school.encounters e WHERE e.course = p_course),
    (SELECT count(*)::integer FROM school.answers a JOIN school.encounters e ON e.id = a.encounter_id WHERE e.course = p_course),
    (SELECT count(*)::integer FROM school.explanations x JOIN school.encounters e ON e.id = x.encounter_id WHERE e.course = p_course),
    (SELECT count(*)::integer FROM school.views v WHERE v.course = p_course)
$$;
GRANT EXECUTE ON FUNCTION school.course_progress(text) TO school_app;
