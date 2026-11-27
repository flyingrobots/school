-- 0011: mastery, how well each quiz is held at a given time (RFC 5 §4.1, §4.2; flyingrobots/school#217).
--
-- A quiz answered cleanly last month is not held as surely as one answered cleanly this morning, and
-- each clean answer given after a delay makes it last longer. This adds a read-only measure of that,
-- derived from the append-only record every time it is asked, so nothing derived is stored.
--
-- What this adds:
--   * quiz_episodes(course, blocks): due review's episodes (0006, due_review), each with how its
--     first try was weak, as one function, so the measure reads them exactly as due review does.
--     Not granted: only the record's own functions call it;
--   * mastery(course, blocks, at, delay_ms): per asked quiz, its stability and its strength at
--     `at`. Reads only. Granted to school_app.
--
-- Order is the record's: every "first", "latest", "previous" and "after" here is by seq, never by
-- `at` (RFC 3 §3.4). `at` is read only to measure elapsed time. The caller passes the time.

-- quiz_episodes(course, blocks) -> one row per episode of an asked quiz
-- blocks is a jsonb array of quiz block ids (anything else asks about none). An episode is one
-- encounter's answers to the block, in the course's encounters; its first try is the one first_try
-- marks. weakness is due review's, unchanged:
--   'wrong-first-try'  the first try was wrong;
--   'unknown-aid'      right, in an encounter whose aid_tracking is NULL;
--   'aided-first-try'  right, after an exposure to the block in that encounter;
--   NULL               right with no recorded aid: clean.
-- right_seq is the episode's first right answer, last_seq and last_at its last answer, by seq.
-- 0006's due_review computes the same rows in its own body; an applied migration is not edited, so
-- it keeps that copy until a later migration replaces it.
CREATE FUNCTION school.quiz_episodes(p_course text, p_blocks jsonb)
RETURNS TABLE (block_id text, encounter_id uuid, encounter_seq bigint, aid_tracking integer, first_seq bigint, first_at timestamptz,
               first_correct boolean, right_seq bigint, last_seq bigint, last_at timestamptz, weakness text)
LANGUAGE sql STABLE SET search_path = school, pg_temp AS $$
  WITH asked AS (
    SELECT DISTINCT b.value AS block_id
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_blocks) = 'array' THEN p_blocks ELSE '[]'::jsonb END) b
  ),
  answer AS (
    SELECT a.seq, a.block_id, a.encounter_id, a.correct, a.first_try, a.at, e.seq AS encounter_seq, e.aid_tracking
    FROM asked k
    JOIN school.answers a ON a.block_id = k.block_id
    JOIN school.encounters e ON e.id = a.encounter_id
    WHERE e.course = p_course
  ),
  episode AS (
    SELECT f.block_id, f.encounter_id, f.encounter_seq, f.aid_tracking,
           f.seq AS first_seq, f.at AS first_at, f.correct AS first_correct,
           min(x.seq) FILTER (WHERE x.correct) AS right_seq,
           max(x.seq) AS last_seq,
           (array_agg(x.at ORDER BY x.seq DESC))[1] AS last_at
    FROM answer f JOIN answer x ON x.block_id = f.block_id AND x.encounter_id = f.encounter_id
    WHERE f.first_try
    GROUP BY f.block_id, f.encounter_id, f.encounter_seq, f.aid_tracking, f.seq, f.at, f.correct
  )
  SELECT ep.block_id, ep.encounter_id, ep.encounter_seq, ep.aid_tracking, ep.first_seq, ep.first_at, ep.first_correct,
         ep.right_seq, ep.last_seq, ep.last_at,
         CASE WHEN NOT ep.first_correct THEN 'wrong-first-try'
              WHEN ep.aid_tracking IS NULL THEN 'unknown-aid'
              WHEN EXISTS (SELECT 1 FROM school.exposures p
                           WHERE p.encounter_id = ep.encounter_id AND p.block_id = ep.block_id AND p.seq < ep.first_seq)
                THEN 'aided-first-try'
         END
  FROM episode ep
$$;

-- mastery(course, blocks, at, delay_ms) -> one row per asked block, in the order first asked
-- blocks is a jsonb array of quiz block ids; each is measured once. For each, over its episodes
-- (quiz_episodes):
--
--   An episode is spaced when its first try came at least delay_ms after the previous episode's
--   last answer; the first episode is spaced. The anchor is the latest episode whose first try was
--   wrong or aided, or came right after a wrong one (a wrong first try starts the chain again: the
--   next right first try is one day, however long after, and anchors the next); if there is none,
--   the first episode.
--
--   stabilityMs  one day x 2.5^k, k the spaced clean episodes after the anchor. k stops at 100
--                (2.5^100 days is about 10^37 years), so stability stays a finite number.
--   refreshedAt  the `at` of the latest right first try (clean, aided or unknown aid).
--   strength     0 when the latest episode's first try was wrong; otherwise
--                0.5^((at - refreshedAt) / stabilityMs), and 1 when `at` is not after refreshedAt.
--                Past 1000 stabilities it is 0, where 0.5^x would leave double precision.
--   settled      due review's clearing rule: no weak episode, or a clean episode whose first try
--                came at least delay_ms after the latest weak episode's last answer.
--   evidence     the seqs of the anchor's first try, each counted episode's first try and the
--                latest right first try, ascending; at most 100, keeping the latest.
--
-- A block with no episode (never answered in this course, or not a quiz) has strength,
-- stabilityMs and refreshedAt null, settled false, and evidence []. The two constants, one day and
-- 2.5, are RFC 5's (§4.1) and live here alone.
--
-- item is {blockId, strength, stabilityMs, refreshedAt, settled, evidence}. Strength is how far
-- through its half-life a quiz is, not a probability of recall.
CREATE FUNCTION school.mastery(p_course text, p_blocks jsonb, p_at timestamptz, p_delay_ms bigint)
RETURNS TABLE (item jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  WITH asked AS (
    SELECT b.value AS block_id, min(b.n) AS n
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_blocks) = 'array' THEN p_blocks ELSE '[]'::jsonb END) WITH ORDINALITY b(value, n)
    GROUP BY b.value
  ),
  episode AS (
    SELECT q.block_id, q.first_seq, q.first_at, q.first_correct, q.last_at, q.weakness,
           coalesce(q.weakness IN ('wrong-first-try', 'aided-first-try'), false)
             OR coalesce(NOT lag(q.first_correct) OVER (PARTITION BY q.block_id ORDER BY q.first_seq), false) AS resets,
           q.first_seq = min(q.first_seq) OVER (PARTITION BY q.block_id) AS is_first,
           coalesce(q.first_at - lag(q.last_at) OVER (PARTITION BY q.block_id ORDER BY q.first_seq)
                      >= p_delay_ms * interval '1 millisecond', true) AS spaced
    FROM school.quiz_episodes(p_course, p_blocks) q
  ),
  anchor AS (
    SELECT DISTINCT ON (e.block_id) e.block_id, e.first_seq FROM episode e
    WHERE e.resets OR e.is_first
    ORDER BY e.block_id, e.resets DESC, e.first_seq DESC
  ),
  counted AS (
    SELECT e.block_id, e.first_seq FROM episode e JOIN anchor a ON a.block_id = e.block_id
    WHERE e.first_seq > a.first_seq AND e.weakness IS NULL AND e.spaced
  ),
  latest AS (
    SELECT DISTINCT ON (e.block_id) e.block_id, e.first_correct FROM episode e ORDER BY e.block_id, e.first_seq DESC
  ),
  refreshed AS (
    SELECT DISTINCT ON (e.block_id) e.block_id, e.first_seq, e.first_at FROM episode e WHERE e.first_correct ORDER BY e.block_id, e.first_seq DESC
  ),
  latest_weak AS (
    SELECT DISTINCT ON (e.block_id) e.block_id, e.first_seq, e.last_at FROM episode e WHERE e.weakness IS NOT NULL ORDER BY e.block_id, e.first_seq DESC
  ),
  cited AS (
    SELECT a.block_id, a.first_seq AS seq FROM anchor a
    UNION SELECT c.block_id, c.first_seq FROM counted c
    UNION SELECT r.block_id, r.first_seq FROM refreshed r
  ),
  capped AS (
    SELECT c.block_id, c.seq, row_number() OVER (PARTITION BY c.block_id ORDER BY c.seq DESC) AS n FROM cited c
  ),
  measured AS (
    SELECT k.block_id, k.n, l.block_id IS NOT NULL AS answered, l.first_correct AS latest_right, r.first_at AS refreshed_at,
           86400000 * power(2.5::float8, least((SELECT count(*) FROM counted c WHERE c.block_id = k.block_id), 100)) AS stability_ms,
           l.block_id IS NOT NULL
             AND (w.block_id IS NULL
                  OR EXISTS (SELECT 1 FROM episode c
                             WHERE c.block_id = w.block_id AND c.weakness IS NULL AND c.first_seq > w.first_seq
                               AND c.first_at - w.last_at >= p_delay_ms * interval '1 millisecond')) AS settled
    FROM asked k
    LEFT JOIN latest l ON l.block_id = k.block_id
    LEFT JOIN refreshed r ON r.block_id = k.block_id
    LEFT JOIN latest_weak w ON w.block_id = k.block_id
  ),
  faded AS (
    SELECT m.*, (extract(epoch FROM p_at - m.refreshed_at) * 1000)::float8 / m.stability_ms AS halves FROM measured m
  )
  SELECT jsonb_build_object(
           'blockId', f.block_id,
           'strength', CASE WHEN NOT f.answered THEN NULL
                            WHEN NOT f.latest_right THEN 0
                            WHEN f.halves <= 0 THEN 1
                            WHEN f.halves >= 1000 THEN 0
                            ELSE power(0.5::float8, f.halves) END,
           'stabilityMs', CASE WHEN f.answered THEN f.stability_ms END,
           'refreshedAt', school.iso(f.refreshed_at),
           'settled', f.settled,
           'evidence', coalesce((SELECT jsonb_agg(c.seq ORDER BY c.seq) FROM capped c WHERE c.block_id = f.block_id AND c.n <= 100), '[]'::jsonb))
  FROM faded f
  ORDER BY f.n
$$;

-- Privileges (RFC 3 §3.1): new functions start revoked from PUBLIC (0001's default privileges), and
-- are granted by name. quiz_episodes is not granted: mastery, as its owner, calls it.
GRANT EXECUTE ON FUNCTION school.mastery(text, jsonb, timestamptz, bigint) TO school_app;
