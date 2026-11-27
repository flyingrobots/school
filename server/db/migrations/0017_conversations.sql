-- 0017: conversations about a passage, kept in the record (RFC 6 §5.2, Figure 5.1, Table 5.3;
-- flyingrobots/school#225).
--
-- A learner selects a passage of a lesson and asks about it. The question is stored, with the
-- `ai-help` exposure it counts as (0012), before any model is asked; the answer is stored after,
-- whether or not the page is still there to receive it. Nothing about a conversation lives
-- anywhere else.
--
-- What this adds:
--   * conversations: one per passage asked about, anchored to the lesson of the encounter it was
--     opened in and to the block where the passage begins;
--   * questions: each question, in the encounter it was asked in, naming its own ai-help exposure
--     of that encounter (questions_exposure_encounter: the exposure's encounter is the question's);
--   * replies: at most one per question, succeeded or failed, with the answer, its checked sources,
--     the agent and model, and the token counts when the agent reports them;
--   * ask, record_reply, lesson_conversations: the only way in, granted to school_app.
--
-- The tables are append-only like every record table, and take their seq from record_seq, so a
-- question's exposure is before any answer the learner gives after it. ask serialises per
-- conversation and per question on advisory locks, so it needs READ COMMITTED (0005); so does
-- record_reply, which reads back what a concurrent caller committed.

-- An exposure's encounter, by its seq: what questions_exposure_encounter references.
ALTER TABLE school.exposures ADD CONSTRAINT exposures_seq_encounter UNIQUE (seq, encounter_id);

CREATE TABLE school.conversations (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  conversation_id uuid NOT NULL CONSTRAINT conversations_id UNIQUE,
  course text NOT NULL,
  lesson text NOT NULL,
  block_id text NOT NULL,
  -- PASSAGE_MAX in server/core/model.ts.
  passage text NOT NULL CONSTRAINT conversations_passage CHECK (passage <> '' AND char_length(passage) <= 2000),
  at timestamptz NOT NULL
);
CREATE INDEX conversations_lesson ON school.conversations (course, lesson, seq);

CREATE TABLE school.questions (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  question_id uuid NOT NULL CONSTRAINT questions_id UNIQUE,
  conversation_id uuid NOT NULL REFERENCES school.conversations (conversation_id),
  encounter_id uuid NOT NULL REFERENCES school.encounters (id),
  -- QUESTION_MAX in server/core/model.ts.
  text text NOT NULL CONSTRAINT questions_text CHECK (text <> '' AND char_length(text) <= 4000),
  exposure_seq bigint NOT NULL CONSTRAINT questions_exposure UNIQUE,
  at timestamptz NOT NULL,
  CONSTRAINT questions_exposure_encounter FOREIGN KEY (exposure_seq, encounter_id) REFERENCES school.exposures (seq, encounter_id)
);
CREATE INDEX questions_conversation ON school.questions (conversation_id, seq);

CREATE TABLE school.replies (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  question_id uuid NOT NULL CONSTRAINT replies_question UNIQUE REFERENCES school.questions (question_id),
  status text NOT NULL CONSTRAINT replies_status CHECK (status IN ('succeeded', 'failed')),
  -- The answer as shown: the whole of it, or for a failed reply whatever reached the learner.
  text text NOT NULL,
  sources jsonb NOT NULL CONSTRAINT replies_sources CHECK (jsonb_typeof(sources) = 'array'),
  agent text,
  model text,
  usage jsonb CONSTRAINT replies_usage CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
  error text,
  at timestamptz NOT NULL,
  CONSTRAINT replies_outcome CHECK ((status = 'succeeded' AND text <> '' AND error IS NULL)
                                 OR (status = 'failed' AND error IS NOT NULL AND error <> ''))
);

CREATE TRIGGER conversations_append_only BEFORE UPDATE OR DELETE ON school.conversations FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER conversations_no_truncate BEFORE TRUNCATE ON school.conversations FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER questions_append_only BEFORE UPDATE OR DELETE ON school.questions FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER questions_no_truncate BEFORE TRUNCATE ON school.questions FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER replies_append_only BEFORE UPDATE OR DELETE ON school.replies FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER replies_no_truncate BEFORE TRUNCATE ON school.replies FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();

-- Internal: true when `content` (a snapshot) holds a block with this id that a passage can begin
-- in: any block but the page itself. Choices and sources carry ids but no type, so they are not
-- blocks. Not granted to anyone.
CREATE FUNCTION school.has_passage_block(content text, block_id text) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path = school, pg_temp
RETURN jsonb_path_exists(content::jsonb, 'strict $.** ? (@.id == $id && @.type.type() == "string" && @.type != "page")',
                         jsonb_build_object('id', block_id));

-- ask(conversation_id, question_id, encounter_id, block_id, passage, text, at) -> status
-- In one transaction: opens the conversation on its first question, records the question's
-- ai-help exposure through record_lesson_help (0012), and stores the question. Answers:
--   'stored';
--   'duplicate': this question id already holds this question (the same conversation, encounter
--     and text, and for a conversation's first question the same block and passage), whatever its at;
--   'conflict': it holds another; the first stands and nothing is stored;
--   'rejected', storing nothing: no such encounter, or its aid_tracking is NULL; or the conversation
--     is new and block_id or passage is NULL, or the encounter's snapshot has no such block; or the
--     conversation exists and block_id or passage is given (they are the conversation's), or the
--     encounter is of another course or lesson than the conversation.
-- A malformed passage or text raises on the tables' constraints and stores nothing, its exposure
-- included. The question is the learner's activity in the encounter, but open_encounter's resume
-- rule reads answers and explanations only (RFC 6 Q8); that is unchanged here.
CREATE FUNCTION school.ask(p_conversation uuid, p_question uuid, p_encounter uuid, p_block text, p_passage text, p_text text,
                           p_at timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  e school.encounters%ROWTYPE;
  c school.conversations%ROWTYPE;
  q school.questions%ROWTYPE;
  v_exposure uuid;
  v_exposure_seq bigint;
  v_first boolean;
BEGIN
  PERFORM school.require_read_committed('school.ask');
  -- The conversation first, then the question: always this order, so two calls cannot deadlock.
  PERFORM pg_advisory_xact_lock(hashtextextended('school.conversations ' || coalesce(p_conversation::text, ''), 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('school.questions ' || coalesce(p_question::text, ''), 0));

  SELECT * INTO q FROM school.questions x WHERE x.question_id = p_question;
  IF FOUND THEN
    SELECT * INTO c FROM school.conversations x WHERE x.conversation_id = q.conversation_id;
    v_first := q.seq = (SELECT min(x.seq) FROM school.questions x WHERE x.conversation_id = q.conversation_id);
    IF q.conversation_id = p_conversation AND q.encounter_id = p_encounter AND q.text = p_text
       AND (CASE WHEN v_first THEN c.block_id = p_block AND c.passage = p_passage
                 ELSE p_block IS NULL AND p_passage IS NULL END) THEN
      RETURN 'duplicate';
    END IF;
    RETURN 'conflict';
  END IF;

  SELECT * INTO e FROM school.encounters x WHERE x.id = p_encounter AND x.aid_tracking IS NOT NULL;
  IF NOT FOUND THEN RETURN 'rejected'; END IF;

  SELECT * INTO c FROM school.conversations x WHERE x.conversation_id = p_conversation;
  IF FOUND THEN
    IF p_block IS NOT NULL OR p_passage IS NOT NULL OR c.course <> e.course OR c.lesson <> e.lesson THEN
      RETURN 'rejected';
    END IF;
  ELSE
    IF p_block IS NULL OR p_passage IS NULL
       OR NOT coalesce((SELECT school.has_passage_block(s.content, p_block) FROM school.snapshots s WHERE s.hash = e.snapshot_hash), false) THEN
      RETURN 'rejected';
    END IF;
    INSERT INTO school.conversations (conversation_id, course, lesson, block_id, passage, at)
    VALUES (p_conversation, e.course, e.lesson, p_block, p_passage, p_at);
  END IF;

  -- The exposure's id is the record's own: the question's id names the question, and the caller
  -- never sees or resends the exposure.
  v_exposure := gen_random_uuid();
  IF school.record_lesson_help(v_exposure, p_encounter, 'ai-help', p_at) <> 'stored' THEN
    RAISE EXCEPTION 'school.ask: the ai-help exposure for question % was not stored', p_question;
  END IF;
  SELECT x.seq INTO v_exposure_seq FROM school.exposures x WHERE x.exposure_id = v_exposure;

  INSERT INTO school.questions (question_id, conversation_id, encounter_id, text, exposure_seq, at)
  VALUES (p_question, p_conversation, p_encounter, p_text, v_exposure_seq, p_at);
  RETURN 'stored';
END
$$;

-- record_reply(question_id, status, text, sources, agent, model, usage, error, at) -> status
-- Stores the one reply to a question: status 'succeeded' with a non-empty text and no error, or
-- 'failed' with an error and whatever text reached the learner. Answers 'stored'; 'duplicate' (the
-- question already has this same reply, whatever its at); 'conflict' (it has another; the first
-- stands); or 'rejected' (no such question; nothing stored). A malformed reply raises on the
-- table's constraints and stores nothing.
CREATE FUNCTION school.record_reply(p_question uuid, p_status text, p_text text, p_sources jsonb, p_agent text, p_model text,
                                    p_usage jsonb, p_error text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_seq bigint;
  r school.replies%ROWTYPE;
BEGIN
  PERFORM school.require_read_committed('school.record_reply');
  IF NOT EXISTS (SELECT 1 FROM school.questions x WHERE x.question_id = p_question) THEN
    RETURN 'rejected';
  END IF;
  INSERT INTO school.replies AS x (question_id, status, text, sources, agent, model, usage, error, at)
  VALUES (p_question, p_status, p_text, p_sources, p_agent, p_model, p_usage, p_error, p_at)
  ON CONFLICT (question_id) DO NOTHING
  RETURNING x.seq INTO v_seq;
  IF v_seq IS NOT NULL THEN RETURN 'stored'; END IF;
  -- A new statement, so under READ COMMITTED it sees the reply that won.
  SELECT * INTO r FROM school.replies x WHERE x.question_id = p_question;
  IF r.status = p_status AND r.text = p_text AND r.sources = p_sources AND r.agent IS NOT DISTINCT FROM p_agent
     AND r.model IS NOT DISTINCT FROM p_model AND r.usage IS NOT DISTINCT FROM p_usage AND r.error IS NOT DISTINCT FROM p_error THEN
    RETURN 'duplicate';
  END IF;
  RETURN 'conflict';
END
$$;

-- lesson_conversations(course, lesson) -> rows of (conversation), in seq order
-- Each conversation opened in an encounter of this course and lesson, as
-- {conversationId, blockId, passage, seq, at, questions}, its questions in seq order, each as
-- {questionId, encounterId, text, seq, exposureSeq, at, reply}, and reply as
-- {status, text, sources, agent, model, usage, error, seq, at} or null when there is none yet.
CREATE FUNCTION school.lesson_conversations(p_course text, p_lesson text) RETURNS TABLE (conversation jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT jsonb_build_object(
           'conversationId', c.conversation_id, 'blockId', c.block_id, 'passage', c.passage, 'seq', c.seq, 'at', school.iso(c.at),
           'questions', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'questionId', q.question_id, 'encounterId', q.encounter_id, 'text', q.text, 'seq', q.seq,
                      'exposureSeq', q.exposure_seq, 'at', school.iso(q.at),
                      'reply', (SELECT jsonb_build_object('status', r.status, 'text', r.text, 'sources', r.sources, 'agent', r.agent,
                                                          'model', r.model, 'usage', r.usage, 'error', r.error, 'seq', r.seq, 'at', school.iso(r.at))
                                FROM school.replies r WHERE r.question_id = q.question_id))
                    ORDER BY q.seq)
             FROM school.questions q WHERE q.conversation_id = c.conversation_id), '[]'::jsonb))
  FROM school.conversations c
  WHERE c.course = p_course AND c.lesson = p_lesson
  ORDER BY c.seq
$$;

-- Privileges (RFC 3 §3.1): new functions start revoked from PUBLIC (0001's default privileges), and
-- are granted by name. has_passage_block is not granted.
GRANT EXECUTE ON FUNCTION school.ask(uuid, uuid, uuid, text, text, text, timestamptz) TO school_app;
GRANT EXECUTE ON FUNCTION school.record_reply(uuid, text, text, jsonb, text, text, jsonb, text, timestamptz) TO school_app;
GRANT EXECUTE ON FUNCTION school.lesson_conversations(text, text) TO school_app;
