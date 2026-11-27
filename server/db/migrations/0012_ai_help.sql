-- 0012: help for a whole encounter counts as aid, the ai-help exposure (RFC 6 §5.1, Table 5.2;
-- flyingrobots/school#224).
--
-- When School shows the learner text a model wrote in answer to the learner's request for help
-- with a lesson, the server records one exposure of kind 'ai-help' for the whole encounter, before
-- the model is asked. A quiz answer or explanation in that encounter with a larger seq is aided,
-- whichever block it belongs to. The rule over-marks by design: it never reads help as no help.
--
-- What this changes:
--   * exposures_kind accepts 'ai-help', and exposures.block_id may be NULL, exactly when the kind is
--     'ai-help' (exposures_block). Every exposure stored before this has a block and another kind;
--   * record_lesson_help(exposure_id, encounter_id, kind, at): stores one encounter-wide exposure,
--     idempotent by its id. Granted to school_app; only the server calls it. record_exposure (0002)
--     is unchanged, so the page's route still cannot store one: a block with 'ai-help' raises
--     exposures_block, and no block is 'rejected';
--   * submission_aid (0002), quiz_episodes (0011) and due_review (0006) are replaced with the same
--     signatures, reading an exposure with no block in the same encounter as an exposure to every
--     block. Mastery reads quiz_episodes, so it reads the rule too. due_review now takes its
--     episodes from quiz_episodes rather than its own copy of them (the copy 0011 noted), so the
--     two cannot drift. Nothing else about any of them changes.
--
-- Order is the record's: "before" and "after" are by seq, never by `at` (RFC 3 §3.4).

ALTER TABLE school.exposures DROP CONSTRAINT exposures_kind;
ALTER TABLE school.exposures ADD CONSTRAINT exposures_kind CHECK (kind IN ('hint', 'model-answer', 'feedback', 'reference', 'ai-help'));
ALTER TABLE school.exposures ALTER COLUMN block_id DROP NOT NULL;
ALTER TABLE school.exposures ADD CONSTRAINT exposures_block CHECK ((kind = 'ai-help') = (block_id IS NULL));

-- record_lesson_help(exposure_id, encounter_id, kind, at) -> status
-- Help shown for the whole encounter: kind is 'ai-help' (another kind raises exposures_block, as a
-- malformed kind raises exposures_kind in record_exposure). Returns 'stored'; 'duplicate' (this id
-- already names help for this encounter of this kind); 'conflict' (it names something else, a
-- block's exposure included; the first stands); or 'rejected' (no such encounter, or its
-- aid_tracking is NULL: an untracked encounter already reads every answer as unknown).
CREATE FUNCTION school.record_lesson_help(p_exposure uuid, p_encounter uuid, p_kind text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_seq bigint;
  p school.exposures%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school.exposures y WHERE y.exposure_id = p_exposure) THEN
    IF NOT EXISTS (SELECT 1 FROM school.encounters e WHERE e.id = p_encounter AND e.aid_tracking IS NOT NULL) THEN
      RETURN 'rejected';
    END IF;
    INSERT INTO school.exposures (exposure_id, encounter_id, block_id, kind, at)
    VALUES (p_exposure, p_encounter, NULL, p_kind, p_at)
    ON CONFLICT (exposure_id) DO NOTHING
    RETURNING seq INTO v_seq;
    IF v_seq IS NOT NULL THEN RETURN 'stored'; END IF;
  END IF;
  SELECT * INTO p FROM school.exposures y WHERE y.exposure_id = p_exposure;
  RETURN CASE WHEN p.encounter_id IS NOT DISTINCT FROM p_encounter AND p.block_id IS NULL
              AND p.kind IS NOT DISTINCT FROM p_kind THEN 'duplicate' ELSE 'conflict' END;
END
$$;

-- submission_aid(submission_id) -> rows of (aid)
-- As 0002's, but an exposure with no block in the same encounter aids every block: 'unknown' when
-- its encounter's aid_tracking is NULL; 'aided' when an exposure to the same block, or to the whole
-- encounter, in the same encounter has a smaller seq; otherwise 'no-recorded-aid'. No row when
-- there is no such submission; two if an answer and an explanation share the id, which the caller
-- must refuse.
CREATE OR REPLACE FUNCTION school.submission_aid(p_submission uuid) RETURNS TABLE (aid text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT CASE WHEN e.aid_tracking IS NULL THEN 'unknown'
              WHEN EXISTS (SELECT 1 FROM school.exposures p
                           WHERE p.encounter_id = s.encounter_id AND (p.block_id = s.block_id OR p.block_id IS NULL)
                             AND p.seq < s.seq) THEN 'aided'
              ELSE 'no-recorded-aid' END
  FROM (SELECT a.encounter_id, a.block_id, a.seq FROM school.answers a WHERE a.submission_id = p_submission
        UNION ALL
        SELECT x.encounter_id, x.block_id, x.seq FROM school.explanations x WHERE x.submission_id = p_submission) s
  JOIN school.encounters e ON e.id = s.encounter_id
$$;

-- quiz_episodes(course, blocks) -> one row per episode of an asked quiz
-- As 0011's, but 'aided-first-try' is right after an exposure to the block, or to the whole
-- encounter, in that encounter. Still not granted: only the record's own functions call it.
CREATE OR REPLACE FUNCTION school.quiz_episodes(p_course text, p_blocks jsonb)
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
                           WHERE p.encounter_id = ep.encounter_id AND (p.block_id = ep.block_id OR p.block_id IS NULL)
                             AND p.seq < ep.first_seq)
                THEN 'aided-first-try'
         END
  FROM episode ep
$$;

-- due_review(course, blocks, at, delay_ms, limit) -> rows of (item), at most `limit`
-- As 0006's, with its rule, ranking, cap and item unchanged, except that an exposure to the whole
-- encounter counts wherever an exposure to the block does: it makes a right first try after it
-- 'due-review/aided-first-try', and it is cited, and named in `shown`, wherever the block's own
-- exposures are:
--   wrong first try: the block's and the encounter's exposures in it before the last answer cited;
--   aided:           the block's and the encounter's exposures in it before the first try.
-- Its episodes and their weakness are quiz_episodes', the same rows mastery reads.
CREATE OR REPLACE FUNCTION school.due_review(p_course text, p_blocks jsonb, p_at timestamptz, p_delay_ms bigint, p_limit integer)
RETURNS TABLE (item jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  WITH asked AS (
    SELECT DISTINCT b.value AS block_id
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_blocks) = 'array' THEN p_blocks ELSE '[]'::jsonb END) b
  ),
  answer AS (
    SELECT a.seq, a.block_id, a.at
    FROM asked k
    JOIN school.answers a ON a.block_id = k.block_id
    JOIN school.encounters e ON e.id = a.encounter_id
    WHERE e.course = p_course
  ),
  judged AS (
    SELECT q.* FROM school.quiz_episodes(p_course, p_blocks) q
  ),
  latest_weak AS (
    SELECT DISTINCT ON (j.block_id) j.* FROM judged j WHERE j.weakness IS NOT NULL ORDER BY j.block_id, j.first_seq DESC
  ),
  last_seen AS (
    SELECT DISTINCT ON (a.block_id) a.block_id, a.at FROM answer a ORDER BY a.block_id, a.seq DESC
  ),
  due AS (
    SELECT w.*, s.at AS seen_at,
           CASE w.weakness WHEN 'wrong-first-try' THEN 0 WHEN 'aided-first-try' THEN 1 ELSE 2 END AS rank
    FROM latest_weak w JOIN last_seen s ON s.block_id = w.block_id
    WHERE p_at - s.at >= p_delay_ms * interval '1 millisecond'
      AND NOT EXISTS (SELECT 1 FROM judged c
                      WHERE c.block_id = w.block_id AND c.weakness IS NULL AND c.first_seq > w.first_seq
                        AND c.first_at - w.last_at >= p_delay_ms * interval '1 millisecond')
    ORDER BY rank, w.first_seq
    LIMIT greatest(p_limit, 0)
  ),
  cited AS (
    -- Every row a due item cites, with its kind; the first try is kept whatever the cap.
    SELECT d.block_id, r.seq, r.kind, r.keep FROM due d
    CROSS JOIN LATERAL (
      SELECT a.seq, 'answer' AS kind, a.seq IN (d.first_seq, d.right_seq) AS keep FROM school.answers a
      WHERE a.encounter_id = d.encounter_id AND a.block_id = d.block_id
        AND CASE d.weakness WHEN 'wrong-first-try' THEN a.seq <= coalesce(d.right_seq, d.last_seq) ELSE a.seq = d.first_seq END
      UNION ALL
      SELECT p.seq, p.kind, false FROM school.exposures p
      WHERE p.encounter_id = d.encounter_id AND (p.block_id = d.block_id OR p.block_id IS NULL)
        AND CASE d.weakness WHEN 'wrong-first-try' THEN p.seq < coalesce(d.right_seq, d.last_seq)
                            WHEN 'aided-first-try' THEN p.seq < d.first_seq ELSE false END
      UNION ALL
      SELECT d.encounter_seq, 'encounter', true WHERE d.weakness = 'unknown-aid'
    ) r
  ),
  capped AS (
    SELECT c.*, row_number() OVER (PARTITION BY c.block_id ORDER BY c.keep DESC, c.seq) AS n FROM cited c
  )
  SELECT jsonb_build_object(
           'blockId', d.block_id,
           'rule', 'due-review/' || d.weakness,
           'answeredAt', school.iso(d.first_at),
           'corrected', d.weakness = 'wrong-first-try' AND d.right_seq IS NOT NULL,
           'shown', coalesce((SELECT jsonb_agg(k.kind ORDER BY k.first) FROM (
                       SELECT c.kind, min(c.seq) AS first FROM capped c
                       WHERE c.block_id = d.block_id AND c.n <= 100 AND c.kind NOT IN ('answer', 'encounter') GROUP BY c.kind) k),
                     '[]'::jsonb),
           'lastSeen', school.iso(d.seen_at),
           'evidence', (SELECT jsonb_agg(c.seq ORDER BY c.seq) FROM capped c WHERE c.block_id = d.block_id AND c.n <= 100))
  FROM due d
  ORDER BY d.rank, d.first_seq
$$;

-- Privileges (RFC 3 §3.1): new functions start revoked from PUBLIC (0001's default privileges), and
-- are granted by name. CREATE OR REPLACE keeps a function's grants, so the replaced ones keep theirs.
GRANT EXECUTE ON FUNCTION school.record_lesson_help(uuid, uuid, text, timestamptz) TO school_app;
