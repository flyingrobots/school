-- 0004: the functions that serialise on an advisory lock refuse to run outside READ COMMITTED
-- (RFC 3 §3.2; flyingrobots/school#50, F-8 of the review of flyingrobots/school#45).
--
-- open_encounter and record_grading take an advisory lock and then read what the previous holder
-- committed: the latest encounter, or the latest grading to supersede. That works only if the read
-- takes its snapshot after the lock is granted, which READ COMMITTED does for each statement. Under
-- REPEATABLE READ or SERIALIZABLE the transaction keeps the snapshot of its first statement, taken
-- before the lock, so a second concurrent open does not see the first's encounter and opens another
-- (reproduced on Postgres 18: every one of 20 races opened two), and a second grading supersedes
-- the same attempt as the first and fails, on gradings_one_first or gradings_supersedes_once.
--
-- A function cannot choose its isolation level: Postgres allows SET TRANSACTION ISOLATION LEVEL
-- only before a transaction's first query, and the call is that query. So each refuses any other
-- level, with invalid_transaction_state, before it locks or writes anything; the Bun.SQL adapter
-- begins every request READ COMMITTED whatever the database's default (server/adapters/bunsql.ts).
-- submit needs no such check: its partial unique index answers_one_first_try decides first try
-- whatever its snapshot saw, and a resent submission meets the unique submission_id.
--
-- The bodies are 0001's, unchanged after the check. CREATE OR REPLACE keeps the grants.

-- Raises unless the current transaction is READ COMMITTED. Internal: not granted to anyone.
CREATE FUNCTION school.require_read_committed(p_function text) RETURNS void
LANGUAGE plpgsql SET search_path = school, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '% needs READ COMMITTED, not %', p_function, upper(current_setting('transaction_isolation'))
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION school.open_encounter(p_course text, p_lesson text, p_content text, p_at timestamptz, p_aid_tracking integer)
RETURNS TABLE (id uuid, hash text, resumed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_hash text := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  v_id uuid;
BEGIN
  PERFORM school.require_read_committed('school.open_encounter');
  PERFORM pg_advisory_xact_lock(hashtextextended('school.open_encounter ' || p_course || ' ' || p_lesson || ' ' || v_hash, 0));
  INSERT INTO school.snapshots (hash, content, at) VALUES (v_hash, p_content, p_at) ON CONFLICT (hash) DO NOTHING;
  SELECT l.id INTO v_id
  FROM (SELECT e.id, e.at, e.aid_tracking FROM school.encounters e
        WHERE e.course = p_course AND e.lesson = p_lesson AND e.view = 'web' AND e.snapshot_hash = v_hash
        ORDER BY e.seq DESC LIMIT 1) l
  WHERE l.aid_tracking IS NOT DISTINCT FROM p_aid_tracking
    AND greatest(l.at,
                 (SELECT max(a.at) FROM school.answers a WHERE a.encounter_id = l.id),
                 (SELECT max(x.at) FROM school.explanations x WHERE x.encounter_id = l.id)) >= p_at - interval '6 hours';
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

CREATE OR REPLACE FUNCTION school.record_grading(p_submission uuid, p_status text, p_rubric_version text, p_prompt_version text, p_adapter text,
                                      p_model text, p_sources jsonb, p_raw_response text, p_findings jsonb, p_error text, p_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  g school.gradings%ROWTYPE;
BEGIN
  PERFORM school.require_read_committed('school.record_grading');
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
