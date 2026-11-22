-- 0001: School's learning record on Postgres (RFC 3 v0.4.0 §3.5; flyingrobots/school#45).
--
-- What this creates:
--   * two roles: school_owner, which owns every object here, and school_app, which the server
--     connects as and which may only EXECUTE the public functions below (§3.1);
--   * the record's tables in schema `school`, append-only, with no column kept for legacy SQLite
--     rows: every answer names its encounter, block, choice and submission (§3.3);
--   * record_seq, the one sequence every evidence row takes its `seq` from, so "before" and
--     "after" across tables compare seq, never `at` (§3.4);
--   * exposures, and aid_tracking on encounters, so aid is observable from the first study (RFC 2 §3);
--   * the partial unique index allowing one first try per encounter and block (§3.2);
--   * the functions the LearningRecord port needs (server/core/ports.ts).
--
-- Time: every function that appends a row takes `at` from the server's Clock as an argument. No
-- function here and no column default reads a clock (§3.4).
--
-- Guard rails, not tamper-proofing: the owner can still drop a trigger (§3.1).
--
-- The runner (server/db/migrate.ts) runs this file in one transaction. It must connect as a role
-- that can create roles and become them; in practice the database's superuser.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'school_owner') THEN
    CREATE ROLE school_owner NOLOGIN;
  END IF;
  -- NOLOGIN here; a deployment gives it LOGIN and a password (the adapter's task, flyingrobots/school#46).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'school_app') THEN
    CREATE ROLE school_app NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA school AUTHORIZATION school_owner;

-- Everything below is created as, and so owned by, the owner.
SET LOCAL ROLE school_owner;

-- Postgres grants EXECUTE on every new function to PUBLIC. Not here: functions the owner creates,
-- now or in any later migration, start revoked, and are granted by name.
ALTER DEFAULT PRIVILEGES FOR ROLE school_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON SCHEMA school FROM PUBLIC;
GRANT USAGE ON SCHEMA school TO school_app;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

CREATE SEQUENCE school.record_seq AS bigint;

-- A resolved lesson as served, once per distinct content. `hash` is the SHA-256 of `content`, the
-- page's canonical JSON (sorted keys, server/record.ts `canonical`), and the database checks it.
CREATE TABLE school.snapshots (
  hash text PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('school.record_seq'),
  content text NOT NULL,
  at timestamptz NOT NULL,
  CONSTRAINT snapshots_hash CHECK (hash = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
  CONSTRAINT snapshots_page CHECK (jsonb_typeof(content::jsonb) = 'object')
);

-- One occasion of a lesson being shown. `aid_tracking` is the version of aid capture in force
-- when it opened; NULL means aid was not observed, so its aid is unknown, never "unaided".
CREATE TABLE school.encounters (
  id uuid PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('school.record_seq'),
  course text NOT NULL,
  lesson text NOT NULL,
  view text NOT NULL CONSTRAINT encounters_view CHECK (view = 'web'),
  snapshot_hash text NOT NULL REFERENCES school.snapshots (hash),
  aid_tracking integer CONSTRAINT encounters_aid_tracking CHECK (aid_tracking > 0),
  at timestamptz NOT NULL
);
CREATE INDEX encounters_lesson ON school.encounters (course, lesson, snapshot_hash, seq);

-- A quiz answer. `correct` and `first_try` are derived by school.submit from the snapshot and the
-- encounter's earlier answers, never taken from the client. Course, lesson and the choice's
-- wording are not copied here: the encounter and its snapshot hold them.
CREATE TABLE school.answers (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  submission_id uuid NOT NULL UNIQUE,
  encounter_id uuid NOT NULL REFERENCES school.encounters (id),
  block_id text NOT NULL,
  choice_id text NOT NULL,
  correct boolean NOT NULL,
  first_try boolean NOT NULL,
  ms integer NOT NULL CONSTRAINT answers_ms CHECK (ms >= 0),
  at timestamptz NOT NULL
);
-- Two concurrent first answers to one block cannot both be first (§3.2).
CREATE UNIQUE INDEX answers_one_first_try ON school.answers (encounter_id, block_id) WHERE first_try;
CREATE INDEX answers_encounter ON school.answers (encounter_id, block_id, seq);

-- An explanation, saved as a submission before anything is sent to a grader.
CREATE TABLE school.explanations (
  submission_id uuid PRIMARY KEY,
  seq bigint NOT NULL UNIQUE DEFAULT nextval('school.record_seq'),
  encounter_id uuid NOT NULL REFERENCES school.encounters (id),
  block_id text NOT NULL,
  text text NOT NULL CONSTRAINT explanations_text CHECK (text <> ''),
  ms integer NOT NULL CONSTRAINT explanations_ms CHECK (ms >= 0),
  at timestamptz NOT NULL
);
CREATE INDEX explanations_encounter ON school.explanations (encounter_id, block_id, seq);

-- Every grading attempt, succeeded or failed. A retry is a new row superseding the latest attempt
-- on the same submission; each attempt is superseded at most once, so the attempts form one chain.
CREATE TABLE school.gradings (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  submission_id uuid NOT NULL REFERENCES school.explanations (submission_id),
  status text NOT NULL CONSTRAINT gradings_status CHECK (status IN ('succeeded', 'failed')),
  rubric_version text NOT NULL,
  prompt_version text NOT NULL,
  adapter text NOT NULL,
  model text,
  sources jsonb NOT NULL CONSTRAINT gradings_sources CHECK (jsonb_typeof(sources) = 'array'),
  raw_response text,
  findings jsonb,
  error text,
  supersedes bigint,
  at timestamptz NOT NULL,
  CONSTRAINT gradings_outcome CHECK ((status = 'succeeded' AND findings IS NOT NULL AND error IS NULL)
                                  OR (status = 'failed' AND findings IS NULL AND error IS NOT NULL)),
  CONSTRAINT gradings_seq_submission UNIQUE (seq, submission_id),
  CONSTRAINT gradings_supersedes_same_submission FOREIGN KEY (supersedes, submission_id) REFERENCES school.gradings (seq, submission_id),
  CONSTRAINT gradings_supersedes_once UNIQUE (supersedes)
);
CREATE UNIQUE INDEX gradings_one_first ON school.gradings (submission_id) WHERE supersedes IS NULL;

-- A lesson page served, for the reading history.
CREATE TABLE school.views (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  course text NOT NULL,
  lesson text NOT NULL,
  at timestamptz NOT NULL
);

-- Help shown to the learner. Aid is derived from these by comparing seq (RFC 2 §3, Listing 1).
CREATE TABLE school.exposures (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  encounter_id uuid NOT NULL REFERENCES school.encounters (id),
  block_id text NOT NULL,
  kind text NOT NULL CONSTRAINT exposures_kind CHECK (kind IN ('hint', 'model-answer', 'feedback', 'reference')),
  at timestamptz NOT NULL
);
CREATE INDEX exposures_encounter ON school.exposures (encounter_id, block_id, seq);

-- ---------------------------------------------------------------------------------------------
-- Append-only: nothing in the record is updated or deleted, even by the owner. Row triggers do not
-- fire on TRUNCATE, so a statement trigger refuses that too.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION school.refuse_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = school, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% are append-only', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER snapshots_append_only BEFORE UPDATE OR DELETE ON school.snapshots FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER snapshots_no_truncate BEFORE TRUNCATE ON school.snapshots FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER encounters_append_only BEFORE UPDATE OR DELETE ON school.encounters FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER encounters_no_truncate BEFORE TRUNCATE ON school.encounters FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER answers_append_only BEFORE UPDATE OR DELETE ON school.answers FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER answers_no_truncate BEFORE TRUNCATE ON school.answers FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER explanations_append_only BEFORE UPDATE OR DELETE ON school.explanations FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER explanations_no_truncate BEFORE TRUNCATE ON school.explanations FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER gradings_append_only BEFORE UPDATE OR DELETE ON school.gradings FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER gradings_no_truncate BEFORE TRUNCATE ON school.gradings FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER views_append_only BEFORE UPDATE OR DELETE ON school.views FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER views_no_truncate BEFORE TRUNCATE ON school.views FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER exposures_append_only BEFORE UPDATE OR DELETE ON school.exposures FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER exposures_no_truncate BEFORE TRUNCATE ON school.exposures FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();

-- ---------------------------------------------------------------------------------------------
-- Internal helpers. Not granted to anyone; the public functions call them as the owner.
-- ---------------------------------------------------------------------------------------------

-- A time as the model's ISO 8601 form, in UTC with milliseconds: 2026-11-21T10:00:00.000Z.
CREATE FUNCTION school.iso(t timestamptz) RETURNS text
LANGUAGE sql STABLE STRICT SET search_path = school, pg_temp
RETURN to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

-- The block of this type and id anywhere in a snapshot's content, or NULL.
CREATE FUNCTION school.find_block(content text, block_id text, block_type text) RETURNS jsonb
LANGUAGE sql STABLE STRICT SET search_path = school, pg_temp
RETURN jsonb_path_query_first(content::jsonb, 'strict $.** ? (@.type == $type && @.id == $id)',
                              jsonb_build_object('type', block_type, 'id', block_id));

-- A grading as the model's Grading: {id, status, findings, error, model, supersedes, at}.
CREATE FUNCTION school.grading_json(g school.gradings) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = school, pg_temp
RETURN jsonb_build_object('id', g.seq, 'status', g.status, 'findings', g.findings, 'error', g.error,
                          'model', g.model, 'supersedes', g.supersedes, 'at', school.iso(g.at));

-- The submission's latest grading attempt as grading_json, or NULL if it has none.
CREATE FUNCTION school.latest_grading(p_submission uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = school, pg_temp
RETURN (SELECT school.grading_json(g) FROM school.gradings g WHERE g.submission_id = p_submission ORDER BY g.seq DESC LIMIT 1);

-- ---------------------------------------------------------------------------------------------
-- The public functions: the only way school_app reaches the record. Each is SECURITY DEFINER,
-- runs as the owner with a fixed search_path, and is atomic (one statement, so one transaction).
-- Times in result columns are timestamptz; times inside jsonb are school.iso text.
-- ---------------------------------------------------------------------------------------------

-- open_encounter(course, lesson, content, at, aid_tracking) -> (id, hash, resumed)
-- Stores `content`, the page's canonical JSON, as a snapshot (once per distinct content), then
-- resumes the latest encounter of this lesson with that content and the same aid_tracking whose
-- last activity (its opening or its latest answer) is within six hours before `at`, or opens a
-- new one. The six hours is server/record.ts RESUME_WINDOW_MS. Concurrent opens of one lesson
-- and content are serialised, so they agree on one encounter (§3.2).
CREATE FUNCTION school.open_encounter(p_course text, p_lesson text, p_content text, p_at timestamptz, p_aid_tracking integer DEFAULT NULL)
RETURNS TABLE (id uuid, hash text, resumed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_hash text := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('school.open_encounter ' || p_course || ' ' || p_lesson || ' ' || v_hash, 0));
  INSERT INTO school.snapshots (hash, content, at) VALUES (v_hash, p_content, p_at) ON CONFLICT (hash) DO NOTHING;
  SELECT e.id INTO v_id FROM school.encounters e
  WHERE e.course = p_course AND e.lesson = p_lesson AND e.view = 'web' AND e.snapshot_hash = v_hash
    AND e.aid_tracking IS NOT DISTINCT FROM p_aid_tracking
    AND greatest(e.at, (SELECT max(a.at) FROM school.answers a WHERE a.encounter_id = e.id)) >= p_at - interval '6 hours'
  ORDER BY e.seq DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_hash, true;
    RETURN;
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO school.encounters (id, course, lesson, view, snapshot_hash, aid_tracking, at)
  VALUES (v_id, p_course, p_lesson, 'web', v_hash, p_aid_tracking, p_at);
  RETURN QUERY SELECT v_id, v_hash, false;
END
$$;

-- submit(submission_id, encounter_id, block_id, choice_id, ms, at) -> (status, correct, first_try)
-- status is 'stored', 'duplicate' (this submission id already names this same answer),
-- 'conflict' (it names a different one; the first stands) or 'rejected' (no such encounter, or
-- that quiz and choice are not in its snapshot); correct and first_try are NULL unless stored or
-- duplicate. `correct` is the snapshot's; `first_try` is true when the encounter holds no earlier
-- answer to the block. If a concurrent answer takes first try, this one is stored as not first.
CREATE FUNCTION school.submit(p_submission uuid, p_encounter uuid, p_block text, p_choice text, p_ms integer, p_at timestamptz)
RETURNS TABLE (status text, correct boolean, first_try boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_choice jsonb;
  v_seq bigint;
  v_constraint text;
  r school.answers%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school.answers a WHERE a.submission_id = p_submission) THEN
    SELECT jsonb_path_query_first(school.find_block(s.content, p_block, 'quiz'), '$.choices[*] ? (@.id == $c)', jsonb_build_object('c', p_choice))
      INTO v_choice
      FROM school.encounters e JOIN school.snapshots s ON s.hash = e.snapshot_hash WHERE e.id = p_encounter;
    IF v_choice IS NULL OR jsonb_typeof(v_choice -> 'correct') IS DISTINCT FROM 'boolean' THEN
      RETURN QUERY SELECT 'rejected'::text, NULL::boolean, NULL::boolean;
      RETURN;
    END IF;
    BEGIN
      INSERT INTO school.answers (submission_id, encounter_id, block_id, choice_id, correct, first_try, ms, at)
      VALUES (p_submission, p_encounter, p_block, p_choice, (v_choice ->> 'correct')::boolean,
              NOT EXISTS (SELECT 1 FROM school.answers a WHERE a.encounter_id = p_encounter AND a.block_id = p_block), p_ms, p_at)
      ON CONFLICT (submission_id) DO NOTHING
      RETURNING seq INTO v_seq;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'answers_one_first_try' THEN RAISE; END IF;
      INSERT INTO school.answers (submission_id, encounter_id, block_id, choice_id, correct, first_try, ms, at)
      VALUES (p_submission, p_encounter, p_block, p_choice, (v_choice ->> 'correct')::boolean, false, p_ms, p_at)
      ON CONFLICT (submission_id) DO NOTHING
      RETURNING seq INTO v_seq;
    END;
  END IF;
  SELECT * INTO r FROM school.answers a WHERE a.submission_id = p_submission;
  IF r.encounter_id <> p_encounter OR r.block_id <> p_block OR r.choice_id <> p_choice THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::boolean, NULL::boolean;
    RETURN;
  END IF;
  RETURN QUERY SELECT CASE WHEN v_seq IS NULL THEN 'duplicate' ELSE 'stored' END, r.correct, r.first_try;
END
$$;

-- encounter_answers(encounter_id) -> rows of (seq, block_id, choice_id, correct)
-- What the learner has answered in this encounter; order by seq for oldest first.
CREATE FUNCTION school.encounter_answers(p_encounter uuid)
RETURNS TABLE (seq bigint, block_id text, choice_id text, correct boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT a.seq, a.block_id, a.choice_id, a.correct FROM school.answers a WHERE a.encounter_id = p_encounter ORDER BY a.seq
$$;

-- lesson_progress(course) -> jsonb {lesson: [block_id, ...]}
-- For each lesson of the course, the quizzes ever answered correctly there, in any encounter,
-- sorted. An empty object when there are none.
CREATE FUNCTION school.lesson_progress(p_course text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(t.lesson, t.blocks), '{}'::jsonb)
  FROM (SELECT e.lesson, jsonb_agg(DISTINCT a.block_id ORDER BY a.block_id) AS blocks
        FROM school.answers a JOIN school.encounters e ON e.id = a.encounter_id
        WHERE e.course = p_course AND a.correct
        GROUP BY e.lesson) t
$$;

-- save_explanation(submission_id, encounter_id, block_id, text, ms, at) -> status
-- 'stored'; 'duplicate' (this id already holds this encounter, block and text); 'conflict' (it
-- holds something else; the first stands); or 'rejected' (no such encounter, or no explain block
-- with that id in its snapshot).
CREATE FUNCTION school.save_explanation(p_submission uuid, p_encounter uuid, p_block text, p_text text, p_ms integer, p_at timestamptz)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_seq bigint;
  x school.explanations%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school.explanations y WHERE y.submission_id = p_submission) THEN
    IF NOT EXISTS (SELECT 1 FROM school.encounters e JOIN school.snapshots s ON s.hash = e.snapshot_hash
                   WHERE e.id = p_encounter AND school.find_block(s.content, p_block, 'explain') IS NOT NULL) THEN
      RETURN 'rejected';
    END IF;
    INSERT INTO school.explanations (submission_id, encounter_id, block_id, text, ms, at)
    VALUES (p_submission, p_encounter, p_block, p_text, p_ms, p_at)
    ON CONFLICT (submission_id) DO NOTHING
    RETURNING seq INTO v_seq;
    IF v_seq IS NOT NULL THEN RETURN 'stored'; END IF;
  END IF;
  SELECT * INTO x FROM school.explanations y WHERE y.submission_id = p_submission;
  RETURN CASE WHEN x.encounter_id = p_encounter AND x.block_id = p_block AND x.text = p_text THEN 'duplicate' ELSE 'conflict' END;
END
$$;

-- explanation(submission_id) -> zero or one row of (submission_id, block_id, text, at, block, grading)
-- A saved explanation, the explain block it answers as its encounter's snapshot holds it, and its
-- latest grading as grading_json (NULL if never graded).
CREATE FUNCTION school.explanation(p_submission uuid)
RETURNS TABLE (submission_id uuid, block_id text, text text, at timestamptz, block jsonb, grading jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT x.submission_id, x.block_id, x.text, x.at, school.find_block(s.content, x.block_id, 'explain'), school.latest_grading(x.submission_id)
  FROM school.explanations x
  JOIN school.encounters e ON e.id = x.encounter_id
  JOIN school.snapshots s ON s.hash = e.snapshot_hash
  WHERE x.submission_id = p_submission
$$;

-- record_grading(submission_id, status, rubric_version, prompt_version, adapter, model, sources,
--                raw_response, findings, error, at) -> jsonb grading_json
-- Stores one grading attempt, superseding the submission's latest attempt, and returns it as
-- stored. status 'succeeded' needs findings and no error; 'failed' an error and no findings.
-- Raises if there is no explanation with that submission id.
CREATE FUNCTION school.record_grading(p_submission uuid, p_status text, p_rubric_version text, p_prompt_version text, p_adapter text,
                                      p_model text, p_sources jsonb, p_raw_response text, p_findings jsonb, p_error text, p_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  g school.gradings%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school.explanations x WHERE x.submission_id = p_submission) THEN
    RAISE EXCEPTION 'no explanation with that submission id' USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- Concurrent attempts on one submission take turns, so each supersedes the one before it.
  PERFORM pg_advisory_xact_lock(hashtextextended('school.gradings ' || p_submission::text, 0));
  INSERT INTO school.gradings (submission_id, status, rubric_version, prompt_version, adapter, model, sources,
                               raw_response, findings, error, supersedes, at)
  VALUES (p_submission, p_status, p_rubric_version, p_prompt_version, p_adapter, p_model, p_sources,
          p_raw_response, p_findings, p_error,
          (SELECT max(y.seq) FROM school.gradings y WHERE y.submission_id = p_submission), p_at)
  RETURNING * INTO g;
  RETURN school.grading_json(g);
END
$$;

-- encounter_explanations(encounter_id) -> rows of (seq, submission_id, block_id, text, at, grading)
-- The latest explanation per block in this encounter (latest by seq), each with its latest
-- grading as grading_json; order by seq.
CREATE FUNCTION school.encounter_explanations(p_encounter uuid)
RETURNS TABLE (seq bigint, submission_id uuid, block_id text, text text, at timestamptz, grading jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT t.seq, t.submission_id, t.block_id, t.text, t.at, school.latest_grading(t.submission_id)
  FROM (SELECT DISTINCT ON (x.block_id) x.* FROM school.explanations x
        WHERE x.encounter_id = p_encounter ORDER BY x.block_id, x.seq DESC) t
  ORDER BY t.seq
$$;

-- record_view(course, lesson, at) -> void
CREATE FUNCTION school.record_view(p_course text, p_lesson text, p_at timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = school, pg_temp AS $$
  INSERT INTO school.views (course, lesson, at) VALUES (p_course, p_lesson, p_at)
$$;

-- record_exposure(encounter_id, block_id, kind, at) -> seq
-- Help shown for a block: kind is 'hint', 'model-answer', 'feedback' or 'reference'.
CREATE FUNCTION school.record_exposure(p_encounter uuid, p_block text, p_kind text, p_at timestamptz) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = school, pg_temp AS $$
  INSERT INTO school.exposures (encounter_id, block_id, kind, at) VALUES (p_encounter, p_block, p_kind, p_at) RETURNING seq
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges (§3.1). The application may execute the public functions, by name, and nothing else.
-- ---------------------------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA school FROM PUBLIC, school_app;
-- Explicit, because row triggers do not fire on TRUNCATE.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA school FROM PUBLIC, school_app;
REVOKE ALL ON SEQUENCE school.record_seq FROM PUBLIC, school_app;
-- Already revoked by the default privileges above; stated again so no function depends on them.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA school FROM PUBLIC;

GRANT EXECUTE ON FUNCTION school.open_encounter(text, text, text, timestamptz, integer) TO school_app;
GRANT EXECUTE ON FUNCTION school.submit(uuid, uuid, text, text, integer, timestamptz) TO school_app;
GRANT EXECUTE ON FUNCTION school.encounter_answers(uuid) TO school_app;
GRANT EXECUTE ON FUNCTION school.lesson_progress(text) TO school_app;
GRANT EXECUTE ON FUNCTION school.save_explanation(uuid, uuid, text, text, integer, timestamptz) TO school_app;
GRANT EXECUTE ON FUNCTION school.explanation(uuid) TO school_app;
GRANT EXECUTE ON FUNCTION school.record_grading(uuid, text, text, text, text, text, jsonb, text, jsonb, text, timestamptz) TO school_app;
GRANT EXECUTE ON FUNCTION school.encounter_explanations(uuid) TO school_app;
GRANT EXECUTE ON FUNCTION school.record_view(text, text, timestamptz) TO school_app;
GRANT EXECUTE ON FUNCTION school.record_exposure(uuid, text, text, timestamptz) TO school_app;
