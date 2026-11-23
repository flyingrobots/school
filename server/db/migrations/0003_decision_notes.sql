-- 0003: decision notes, why School chose what it brings back (RFC 2 §3 and §5; flyingrobots/school#31).
--
-- RFC 2 §3 separates what the record holds: observations are stored, judgments are derived or
-- appended, and decisions (what to review next) are notes that name their evidence. A note says
-- what was chosen (a course, a lesson, or a block of a lesson), the rule that chose it, a reason a
-- person can read, and the record rows it cites, by seq. It cites rows, never judgments, so a later
-- reinterpretation (a regrading, a new aid rule) cannot change what a note pointed at.
--
-- What this creates:
--   * decision_notes, append-only like every record table, its seq from record_seq, and every cited
--     seq smaller than its own, so the evidence always precedes the decision (RFC 3 §3.4);
--   * encounter_evidence(encounter_id): the rows an encounter holds that a note may cite;
--   * record_decision_note(...): stores a note once per note id, refusing one that cites a row
--     that does not exist, is not evidence, or is evidence of another course than the choice's;
--   * choice_decision_notes(course, lesson, block_id) and encounter_decision_notes(encounter_id).
--
-- Evidence is a row of encounters, answers, explanations, gradings, exposures or views. A snapshot
-- is content, not evidence, and a note is a decision, not evidence: neither may be cited.

CREATE TABLE school.decision_notes (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  note_id uuid NOT NULL CONSTRAINT decision_notes_note_id UNIQUE,
  course text NOT NULL CONSTRAINT decision_notes_course CHECK (course <> ''),
  lesson text CONSTRAINT decision_notes_lesson CHECK (lesson <> ''),
  block_id text CONSTRAINT decision_notes_block CHECK (block_id <> ''),
  -- The encounter the choice was made for, if any: one the reviewed item is shown in.
  encounter_id uuid REFERENCES school.encounters (id),
  rule text NOT NULL CONSTRAINT decision_notes_rule
    CHECK (length(rule) <= 100 AND rule ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)+$'),
  reason text NOT NULL CONSTRAINT decision_notes_reason CHECK (btrim(reason) <> ''),
  evidence bigint[] NOT NULL CONSTRAINT decision_notes_evidence
    CHECK (cardinality(evidence) >= 1 AND array_position(evidence, NULL) IS NULL),
  at timestamptz NOT NULL,
  CONSTRAINT decision_notes_block_in_lesson CHECK (block_id IS NULL OR lesson IS NOT NULL),
  CONSTRAINT decision_notes_evidence_precedes CHECK (seq > ALL (evidence))
);
CREATE INDEX decision_notes_choice ON school.decision_notes (course, lesson, block_id, seq);
CREATE INDEX decision_notes_encounter ON school.decision_notes (encounter_id, seq) WHERE encounter_id IS NOT NULL;

CREATE TRIGGER decision_notes_append_only BEFORE UPDATE OR DELETE ON school.decision_notes FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER decision_notes_no_truncate BEFORE TRUNCATE ON school.decision_notes FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Internal helpers. Not granted to anyone.
-- ---------------------------------------------------------------------------------------------

-- The course a row of evidence belongs to, or NULL if no evidence row has that seq. Each seq is
-- unique across the record (record_seq), so at most one branch finds it; COALESCE stops there.
CREATE FUNCTION school.evidence_course(p_seq bigint) RETURNS text
LANGUAGE sql STABLE SET search_path = school, pg_temp
RETURN coalesce(
  (SELECT e.course FROM school.encounters e WHERE e.seq = p_seq),
  (SELECT e.course FROM school.answers a JOIN school.encounters e ON e.id = a.encounter_id WHERE a.seq = p_seq),
  (SELECT e.course FROM school.explanations x JOIN school.encounters e ON e.id = x.encounter_id WHERE x.seq = p_seq),
  (SELECT e.course FROM school.gradings g JOIN school.explanations x ON x.submission_id = g.submission_id
     JOIN school.encounters e ON e.id = x.encounter_id WHERE g.seq = p_seq),
  (SELECT e.course FROM school.exposures p JOIN school.encounters e ON e.id = p.encounter_id WHERE p.seq = p_seq),
  (SELECT v.course FROM school.views v WHERE v.seq = p_seq));

-- A note as the model's DecisionNote: {id, seq, choice: {course, lesson, blockId}, encounterId,
-- rule, reason, evidence, at}.
CREATE FUNCTION school.decision_note_json(n school.decision_notes) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = school, pg_temp
RETURN jsonb_build_object('id', n.note_id, 'seq', n.seq,
                          'choice', jsonb_build_object('course', n.course, 'lesson', n.lesson, 'blockId', n.block_id),
                          'encounterId', n.encounter_id, 'rule', n.rule, 'reason', n.reason,
                          'evidence', to_jsonb(n.evidence), 'at', school.iso(n.at));

-- ---------------------------------------------------------------------------------------------
-- The public functions.
-- ---------------------------------------------------------------------------------------------

-- encounter_evidence(encounter_id) -> rows of (seq, kind, block_id), ordered by seq
-- The rows this encounter holds that a note may cite: the encounter itself (block_id NULL), and
-- its answers, explanations, their gradings, and exposures. None if there is no such encounter.
CREATE FUNCTION school.encounter_evidence(p_encounter uuid) RETURNS TABLE (seq bigint, kind text, block_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT t.seq, t.kind, t.block_id FROM (
    SELECT e.seq, 'encounter' AS kind, NULL::text AS block_id FROM school.encounters e WHERE e.id = p_encounter
    UNION ALL SELECT a.seq, 'answer', a.block_id FROM school.answers a WHERE a.encounter_id = p_encounter
    UNION ALL SELECT x.seq, 'explanation', x.block_id FROM school.explanations x WHERE x.encounter_id = p_encounter
    UNION ALL SELECT g.seq, 'grading', x.block_id FROM school.gradings g
                JOIN school.explanations x ON x.submission_id = g.submission_id WHERE x.encounter_id = p_encounter
    UNION ALL SELECT p.seq, 'exposure', p.block_id FROM school.exposures p WHERE p.encounter_id = p_encounter
  ) t ORDER BY t.seq
$$;

-- record_decision_note(note_id, course, lesson, block_id, encounter_id, rule, reason, evidence, at)
--   -> (status, note)
-- The choice is the course, lesson and block_id (lesson and block_id may be NULL; a block needs a
-- lesson). evidence is a jsonb array of seqs. status is 'stored'; 'duplicate' (this note id
-- already names this same note: choice, encounter, rule, reason and evidence, in order);
-- 'conflict' (it names another; the first stands); or 'rejected', storing nothing, when evidence is
-- not a non-empty array of distinct positive integers, a cited seq is not an evidence row of the
-- choice's course, or encounter_id is given and is not an encounter of the choice's course (and
-- lesson, if given) whose snapshot holds the block as a quiz or explain block (if given). note is
-- decision_note_json when stored or duplicate, NULL otherwise. A malformed rule or reason raises
-- (decision_notes_rule, decision_notes_reason), as a malformed exposure kind does.
CREATE FUNCTION school.record_decision_note(p_note uuid, p_course text, p_lesson text, p_block text, p_encounter uuid,
                                            p_rule text, p_reason text, p_evidence jsonb, p_at timestamptz)
RETURNS TABLE (status text, note jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_evidence bigint[];
  v_seq bigint;
  n school.decision_notes%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school.decision_notes d WHERE d.note_id = p_note) THEN
    IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'array' OR jsonb_array_length(p_evidence) = 0
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_evidence) x
                  WHERE jsonb_typeof(x) <> 'number' OR x::text !~ '^[1-9][0-9]{0,17}$') THEN
      RETURN QUERY SELECT 'rejected'::text, NULL::jsonb;
      RETURN;
    END IF;
    v_evidence := ARRAY(SELECT x.value::text::bigint FROM jsonb_array_elements(p_evidence) WITH ORDINALITY x ORDER BY x.ordinality);
    IF (SELECT count(DISTINCT u) FROM unnest(v_evidence) u) <> cardinality(v_evidence)
       OR EXISTS (SELECT 1 FROM unnest(v_evidence) u WHERE school.evidence_course(u) IS DISTINCT FROM p_course)
       OR (p_encounter IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM school.encounters e JOIN school.snapshots s ON s.hash = e.snapshot_hash
             WHERE e.id = p_encounter AND e.course = p_course AND (p_lesson IS NULL OR e.lesson = p_lesson)
               AND (p_block IS NULL OR school.find_block(s.content, p_block, 'quiz') IS NOT NULL
                                    OR school.find_block(s.content, p_block, 'explain') IS NOT NULL))) THEN
      RETURN QUERY SELECT 'rejected'::text, NULL::jsonb;
      RETURN;
    END IF;
    INSERT INTO school.decision_notes (note_id, course, lesson, block_id, encounter_id, rule, reason, evidence, at)
    VALUES (p_note, p_course, p_lesson, p_block, p_encounter, p_rule, p_reason, v_evidence, p_at)
    ON CONFLICT (note_id) DO NOTHING
    RETURNING seq INTO v_seq;
  END IF;
  SELECT * INTO n FROM school.decision_notes d WHERE d.note_id = p_note;
  IF v_seq IS NOT NULL THEN
    RETURN QUERY SELECT 'stored'::text, school.decision_note_json(n);
  ELSIF n.course IS NOT DISTINCT FROM p_course AND n.lesson IS NOT DISTINCT FROM p_lesson AND n.block_id IS NOT DISTINCT FROM p_block
        AND n.encounter_id IS NOT DISTINCT FROM p_encounter AND n.rule IS NOT DISTINCT FROM p_rule
        AND n.reason IS NOT DISTINCT FROM p_reason AND to_jsonb(n.evidence) IS NOT DISTINCT FROM p_evidence THEN
    RETURN QUERY SELECT 'duplicate'::text, school.decision_note_json(n);
  ELSE
    RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
  END IF;
END
$$;

-- choice_decision_notes(course, lesson, block_id) -> rows of (seq, note), ordered by seq
-- The notes for exactly this choice: a course's notes (lesson and block_id NULL) do not include
-- its lessons' or blocks'. note is decision_note_json.
CREATE FUNCTION school.choice_decision_notes(p_course text, p_lesson text, p_block text) RETURNS TABLE (seq bigint, note jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT d.seq, school.decision_note_json(d) FROM school.decision_notes d
  WHERE d.course = p_course AND d.lesson IS NOT DISTINCT FROM p_lesson AND d.block_id IS NOT DISTINCT FROM p_block
  ORDER BY d.seq
$$;

-- encounter_decision_notes(encounter_id) -> rows of (seq, note), ordered by seq
-- The notes recorded for this encounter.
CREATE FUNCTION school.encounter_decision_notes(p_encounter uuid) RETURNS TABLE (seq bigint, note jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT d.seq, school.decision_note_json(d) FROM school.decision_notes d WHERE d.encounter_id = p_encounter ORDER BY d.seq
$$;

-- Privileges (RFC 3 §3.1): the table is reached only through the functions; new functions start
-- revoked from PUBLIC (0001's default privileges), and are granted by name.
REVOKE ALL ON TABLE school.decision_notes FROM PUBLIC, school_app;
REVOKE EXECUTE ON FUNCTION school.evidence_course(bigint), school.decision_note_json(school.decision_notes) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION school.encounter_evidence(uuid) TO school_app;
GRANT EXECUTE ON FUNCTION school.record_decision_note(uuid, text, text, text, uuid, text, text, jsonb, timestamptz) TO school_app;
GRANT EXECUTE ON FUNCTION school.choice_decision_notes(text, text, text) TO school_app;
GRANT EXECUTE ON FUNCTION school.encounter_decision_notes(uuid) TO school_app;
