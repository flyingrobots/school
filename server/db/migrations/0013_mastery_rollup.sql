-- 0013: the mastery rollup, how each lesson's and course's quizzes are held at a given time (RFC 5
-- §4.5; flyingrobots/school#218).
--
-- A page says how a lesson or a course is holding in words, and explain mode ranks lessons by how
-- well they are held. Both read this one definition, so every number shown comes from the record.
--
-- What this adds:
--   * mastery_rollup(course, groups, at, delay_ms): per group of quiz blocks, how many are in each
--     of the four states and their mean strength, from mastery (0011). Reads only. Granted to
--     school_app.

-- mastery_rollup(course, groups, at, delay_ms) -> one row per group key, in byte order of the key
-- groups is a jsonb object from a key (a lesson, or the whole course) to a jsonb array of quiz block
-- ids. groups that is not an object asks about nothing; a key whose value is not an array is an
-- empty group, and a null in an array is not a block. Each distinct block in a group is measured
-- once by mastery(course, [every block asked], at, delay_ms) and placed in exactly one state
-- (RFC 5 Table 4.5, the words of §4.7):
--
--   notStarted  never answered: mastery's strength is null;
--   settling    answered, not settled: due review's weak rules still hold it;
--   holding     settled, strength one half or more;
--   faded       settled, strength below one half ("ready for another look").
--
-- A block in two groups counts in both; a block twice in one group counts once. quizzes is the
-- number of distinct blocks in the group, so the four counts sum to it. strength is the mean of
-- mastery's strength over the group, a quiz not started counting 0, and null for an empty group: it
-- is for explain mode to rank by, never for display.
--
-- item is {key, quizzes, notStarted, settling, holding, faded, strength}.
CREATE FUNCTION school.mastery_rollup(p_course text, p_groups jsonb, p_at timestamptz, p_delay_ms bigint)
RETURNS TABLE (item jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  WITH grp AS (
    SELECT g.key, g.value
    FROM jsonb_each(CASE WHEN jsonb_typeof(p_groups) = 'object' THEN p_groups ELSE '{}'::jsonb END) g
  ),
  member AS (
    SELECT DISTINCT g.key, b.value AS block_id
    FROM grp g
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.value) = 'array' THEN g.value ELSE '[]'::jsonb END) b
    WHERE b.value IS NOT NULL
  ),
  held AS (
    SELECT m.item ->> 'blockId' AS block_id,
           (m.item ->> 'strength')::float8 AS strength,
           (m.item ->> 'settled')::boolean AS settled
    FROM school.mastery(p_course, (SELECT coalesce(jsonb_agg(DISTINCT b.block_id), '[]'::jsonb) FROM member b), p_at, p_delay_ms) m
  ),
  placed AS (
    SELECT b.key, b.block_id, h.strength,
           CASE WHEN h.strength IS NULL THEN 'notStarted'
                WHEN NOT h.settled THEN 'settling'
                WHEN h.strength >= 0.5 THEN 'holding'
                ELSE 'faded' END AS state
    FROM member b JOIN held h ON h.block_id = b.block_id
  ),
  counted AS (
    SELECT g.key,
           count(p.block_id) AS quizzes,
           count(*) FILTER (WHERE p.state = 'notStarted') AS not_started,
           count(*) FILTER (WHERE p.state = 'settling') AS settling,
           count(*) FILTER (WHERE p.state = 'holding') AS holding,
           count(*) FILTER (WHERE p.state = 'faded') AS faded,
           avg(coalesce(p.strength, 0)) FILTER (WHERE p.block_id IS NOT NULL) AS strength
    FROM grp g LEFT JOIN placed p ON p.key = g.key
    GROUP BY g.key
  )
  SELECT jsonb_build_object(
           'key', c.key,
           'quizzes', c.quizzes,
           'notStarted', c.not_started,
           'settling', c.settling,
           'holding', c.holding,
           'faded', c.faded,
           'strength', c.strength)
  FROM counted c
  ORDER BY c.key COLLATE "C"
$$;

-- Privileges (RFC 3 §3.1): new functions start revoked from PUBLIC (0001's default privileges), and
-- are granted by name.
GRANT EXECUTE ON FUNCTION school.mastery_rollup(text, jsonb, timestamptz, bigint) TO school_app;
