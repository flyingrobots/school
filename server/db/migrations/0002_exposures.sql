-- 0002: exposures recorded through the API, and aid derived from them (RFC 2 §3, Listing 1;
-- flyingrobots/school#29).
--
-- What this changes:
--   * exposures gain exposure_id, the client's id for one exposure, unique, so a resend is stored
--     once. Rows recorded before this migration have none (NULL), and still count as exposures;
--   * record_exposure(encounter, block, kind, at) from 0001 is replaced by
--     record_exposure(exposure_id, encounter, block, kind, at), which reports a status instead of
--     raising, and refuses an exposure the record could not honestly use: no such encounter, an
--     encounter opened without aid tracking, or a block that is not a quiz or explain block in
--     the encounter's snapshot. The old signature is dropped, so school_app has no unchecked path;
--   * submission_aid(submission_id) derives a submission's aid by seq, never by `at` (RFC 3 §3.4).
--     Aid is never stored.

ALTER TABLE school.exposures ADD COLUMN exposure_id uuid CONSTRAINT exposures_exposure_id UNIQUE;

DROP FUNCTION school.record_exposure(uuid, text, text, timestamptz);

-- record_exposure(exposure_id, encounter_id, block_id, kind, at) -> status
-- Help shown for a block: kind is 'hint', 'model-answer', 'feedback' or 'reference' (another kind
-- raises exposures_kind). Returns 'stored'; 'duplicate' (this id already names this encounter,
-- block and kind); 'conflict' (it names something else; the first stands); or 'rejected' (no such
-- encounter, the encounter's aid_tracking is NULL, or no quiz or explain block with that id in its
-- snapshot). An exposure after the encounter's resume window is still the encounter's: the page
-- that shows it is still open on it. Recording one is not the learner's activity, so it does not
-- keep the encounter open (open_encounter reads answers and explanations only).
CREATE FUNCTION school.record_exposure(p_exposure uuid, p_encounter uuid, p_block text, p_kind text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_seq bigint;
  p school.exposures%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school.exposures y WHERE y.exposure_id = p_exposure) THEN
    IF NOT EXISTS (SELECT 1 FROM school.encounters e JOIN school.snapshots s ON s.hash = e.snapshot_hash
                   WHERE e.id = p_encounter AND e.aid_tracking IS NOT NULL
                     AND (school.find_block(s.content, p_block, 'quiz') IS NOT NULL
                          OR school.find_block(s.content, p_block, 'explain') IS NOT NULL)) THEN
      RETURN 'rejected';
    END IF;
    INSERT INTO school.exposures (exposure_id, encounter_id, block_id, kind, at)
    VALUES (p_exposure, p_encounter, p_block, p_kind, p_at)
    ON CONFLICT (exposure_id) DO NOTHING
    RETURNING seq INTO v_seq;
    IF v_seq IS NOT NULL THEN RETURN 'stored'; END IF;
  END IF;
  SELECT * INTO p FROM school.exposures y WHERE y.exposure_id = p_exposure;
  RETURN CASE WHEN p.encounter_id IS NOT DISTINCT FROM p_encounter AND p.block_id IS NOT DISTINCT FROM p_block
              AND p.kind IS NOT DISTINCT FROM p_kind THEN 'duplicate' ELSE 'conflict' END;
END
$$;

-- submission_aid(submission_id) -> rows of (aid)
-- The aid of a quiz answer or an explanation, as RFC 2 Listing 1 derives it: 'unknown' when its
-- encounter's aid_tracking is NULL; 'aided' when an exposure to the same block in the same
-- encounter has a smaller seq; otherwise 'no-recorded-aid'. No row when there is no such
-- submission; two if an answer and an explanation share the id, which the caller must refuse.
CREATE FUNCTION school.submission_aid(p_submission uuid) RETURNS TABLE (aid text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT CASE WHEN e.aid_tracking IS NULL THEN 'unknown'
              WHEN EXISTS (SELECT 1 FROM school.exposures p
                           WHERE p.encounter_id = s.encounter_id AND p.block_id = s.block_id AND p.seq < s.seq) THEN 'aided'
              ELSE 'no-recorded-aid' END
  FROM (SELECT a.encounter_id, a.block_id, a.seq FROM school.answers a WHERE a.submission_id = p_submission
        UNION ALL
        SELECT x.encounter_id, x.block_id, x.seq FROM school.explanations x WHERE x.submission_id = p_submission) s
  JOIN school.encounters e ON e.id = s.encounter_id
$$;

-- Privileges (RFC 3 §3.1): new functions start revoked from PUBLIC (0001's default privileges).
GRANT EXECUTE ON FUNCTION school.record_exposure(uuid, uuid, text, text, timestamptz) TO school_app;
GRANT EXECUTE ON FUNCTION school.submission_aid(uuid) TO school_app;
