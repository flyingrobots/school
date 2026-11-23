-- 0006: due review, the blocks School brings back for delayed review, each with its reason
-- (RFC 2 §5; flyingrobots/school#32).
--
-- RFC 2 §5: a correct answer with no recorded aid, after a delay, is the strongest evidence School
-- can hold, and no lesson brought an earlier item back to collect it. This adds a read-only
-- selector over the record and a way to open a lesson with the items it chose, snapshotted with the
-- lesson and noted with the encounter, so a reload shows the same items with the same reasons.
--
-- What this adds:
--   * encounters.lesson_hash: the hash of the lesson as written, when School added review to its
--     snapshot; NULL when the snapshot is the lesson as written (every encounter before this);
--   * due_review(course, blocks, at, delay_ms, limit): the selector. Reads only;
--   * open_lesson_encounter(course, lesson, lesson_content, content, at, aid_tracking, notes):
--     resumes or opens an encounter keyed by the lesson as written, and stores the review's
--     decision notes with a new one, in one transaction.
--
-- Order is the record's: every "first", "latest" and "before" here is by seq, never by `at`
-- (RFC 3 §3.4). `at` is read only to measure the delay since a block was last answered.

ALTER TABLE school.encounters ADD COLUMN lesson_hash text;
CREATE INDEX encounters_lesson_written ON school.encounters (course, lesson, (coalesce(lesson_hash, snapshot_hash)), seq);
CREATE INDEX answers_block ON school.answers (block_id, seq);

-- ---------------------------------------------------------------------------------------------
-- The selector.
-- ---------------------------------------------------------------------------------------------

-- due_review(course, blocks, at, delay_ms, limit) -> rows of (item), at most `limit`
-- blocks is a jsonb array of quiz block ids: the ones the caller could show (another type, or an
-- id no answer names, is never due). For each, over its answers in the course's encounters:
--
--   An episode is one encounter's answers to the block. Its first try is the one first_try marks.
--   An episode is weak when its first try was
--     wrong                                                       -> 'due-review/wrong-first-try';
--     right, after an exposure to the block in that encounter     -> 'due-review/aided-first-try';
--     right, in an encounter whose aid_tracking is NULL           -> 'due-review/unknown-aid'.
--   Otherwise (right, with no recorded aid) it is clean.
--
--   A block is due when its latest weak episode is followed by no clean episode whose first try
--   came at least delay_ms after that weak episode's last answer (a right answer a minute after a
--   wrong one is memory, not review), and its latest answer is at least delay_ms before `at`.
--
-- item is {blockId, rule, answeredAt, corrected, shown, lastSeen, evidence}: answeredAt the weak
-- first try's time; corrected, for a wrong first try, whether a later answer in that encounter was
-- right; shown, the kinds of exposure among the evidence, each once, in seq order; lastSeen the
-- time of the block's latest answer; evidence the rows the decision cites, by seq (at most 100):
--   wrong first try: the episode's answers up to and including its first right one (all of them
--                    if none was right), and the block's exposures in it before the last of those;
--   aided:           the block's exposures in the encounter before the first try, and the first try;
--   unknown aid:     the encounter (its row records that aid was not tracked), and the first try.
-- Ranked wrong first tries, then aided, then unknown aid; within a rule, by the first try's seq.
CREATE FUNCTION school.due_review(p_course text, p_blocks jsonb, p_at timestamptz, p_delay_ms bigint, p_limit integer)
RETURNS TABLE (item jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
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
  ),
  judged AS (
    SELECT ep.*,
           CASE WHEN NOT ep.first_correct THEN 'wrong-first-try'
                WHEN ep.aid_tracking IS NULL THEN 'unknown-aid'
                WHEN EXISTS (SELECT 1 FROM school.exposures p
                             WHERE p.encounter_id = ep.encounter_id AND p.block_id = ep.block_id AND p.seq < ep.first_seq)
                  THEN 'aided-first-try'
           END AS weakness
    FROM episode ep
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
      WHERE p.encounter_id = d.encounter_id AND p.block_id = d.block_id
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

-- ---------------------------------------------------------------------------------------------
-- Opening a lesson with review.
-- ---------------------------------------------------------------------------------------------

-- open_lesson_encounter(course, lesson, lesson_content, content, at, aid_tracking, notes)
--   -> (id, hash, resumed, content)
-- lesson_content is the lesson as written, its canonical JSON; content is what is shown: the lesson
-- with any review School added. Like open_encounter, but an encounter is found by the lesson as
-- written, not by what was shown: the latest encounter of this course and lesson whose lesson as
-- written is lesson_content (its snapshot, for an encounter opened without review) resumes, under
-- open_encounter's rule (the same aid_tracking, and its last activity within six hours before
-- `at`). Then `content` and `notes` are ignored, and the content returned is the resumed
-- encounter's snapshot, so a reload shows the review it was opened with, whatever would be chosen
-- now. Otherwise `content` is stored as a snapshot and a new encounter opened on it, and each note,
-- a jsonb array of {blockId, rule, reason, evidence}, is stored as a decision note for that block
-- of this lesson and this encounter (record_decision_note), under a new note id. A note that
-- record_decision_note would not store raises, and nothing is opened or stored. Like open_encounter
-- (0005), it refuses to run outside READ COMMITTED (invalid_transaction_state).
CREATE FUNCTION school.open_lesson_encounter(p_course text, p_lesson text, p_lesson_content text, p_content text, p_at timestamptz,
                                             p_aid_tracking integer, p_notes jsonb)
RETURNS TABLE (id uuid, hash text, resumed boolean, content jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_written text := encode(sha256(convert_to(p_lesson_content, 'UTF8')), 'hex');
  v_hash text := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  v_id uuid;
  v_snapshot text;
  v_note jsonb;
  v_status text;
BEGIN
  -- It serialises on an advisory lock and then reads what the previous holder committed, which
  -- holds only under READ COMMITTED (0005, school.require_read_committed).
  PERFORM school.require_read_committed('school.open_lesson_encounter');
  IF jsonb_typeof(p_notes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'open_lesson_encounter: notes must be a jsonb array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('school.open_lesson_encounter ' || p_course || ' ' || p_lesson || ' ' || v_written, 0));
  SELECT l.id, l.snapshot_hash INTO v_id, v_snapshot
  FROM (SELECT e.id, e.at, e.aid_tracking, e.snapshot_hash FROM school.encounters e
        WHERE e.course = p_course AND e.lesson = p_lesson AND e.view = 'web' AND coalesce(e.lesson_hash, e.snapshot_hash) = v_written
        ORDER BY e.seq DESC LIMIT 1) l
  WHERE l.aid_tracking IS NOT DISTINCT FROM p_aid_tracking
    AND greatest(l.at,
                 (SELECT max(a.at) FROM school.answers a WHERE a.encounter_id = l.id),
                 (SELECT max(x.at) FROM school.explanations x WHERE x.encounter_id = l.id)) >= p_at - interval '6 hours';
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_snapshot, true, (SELECT s.content::jsonb FROM school.snapshots s WHERE s.hash = v_snapshot);
    RETURN;
  END IF;
  INSERT INTO school.snapshots (hash, content, at) VALUES (v_hash, p_content, p_at) ON CONFLICT (hash) DO NOTHING;
  v_id := gen_random_uuid();
  INSERT INTO school.encounters (id, course, lesson, view, snapshot_hash, aid_tracking, at, lesson_hash)
  VALUES (v_id, p_course, p_lesson, 'web', v_hash, p_aid_tracking, p_at, CASE WHEN v_hash = v_written THEN NULL ELSE v_written END);
  FOR v_note IN SELECT n.value FROM jsonb_array_elements(p_notes) n LOOP
    SELECT r.status INTO v_status
    FROM school.record_decision_note(gen_random_uuid(), p_course, p_lesson, v_note ->> 'blockId', v_id,
                                     v_note ->> 'rule', v_note ->> 'reason', v_note -> 'evidence', p_at) r;
    IF v_status IS DISTINCT FROM 'stored' THEN
      RAISE EXCEPTION 'open_lesson_encounter: the decision note for block % was %', v_note ->> 'blockId', coalesce(v_status, 'not stored')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_id, v_hash, false, p_content::jsonb;
END
$$;

-- Privileges (RFC 3 §3.1): new functions start revoked from PUBLIC (0001's default privileges), and
-- are granted by name. The new column is behind the table's revoked privileges like the rest.
GRANT EXECUTE ON FUNCTION school.due_review(text, jsonb, timestamptz, bigint, integer) TO school_app;
GRANT EXECUTE ON FUNCTION school.open_lesson_encounter(text, text, text, text, timestamptz, integer, jsonb) TO school_app;
