-- 0016: authoring requests, drafts and decisions (RFC 9 §5.5; flyingrobots/school#258).
--
-- A learner asks an agent, from School's own page, to change an installed course. The record keeps
-- who asked for what, on which install, with which skill; each round the agent drafted, with what
-- the check said; and what the learner decided. Append-only like every record table: a row is
-- written once, through a function, and never changed.
--
-- What this adds:
--   * authoring_requests: each request, under the course name, naming the install it was based on
--     (the course's current install when it was asked), its text (1 to 20,000 characters, counted
--     in code points), the SHA-256 of the skill's manifest and School's version.
--   * authoring_drafts: each round of a request, at most two: `ready` or `refused` by the check, with
--     the agent, the draft commit and the SHA-256 of its files' manifest, and for `refused` the
--     check's message; or `failed` (the agent failed or ran out of time), with no commit and
--     perhaps no agent. Token counts when the agent reported them. Round 2 follows only a refused
--     round 1.
--   * authoring_decisions: at most one per draft, `accepted` or `discarded`. An accept names the
--     `authored` install the draft became and keeps the draft's patch, so the install can be
--     rebuilt from the record (RFC 9 §5.4).
--   * course_installs (0010) gains the source `authored`, with parent_install_id (the install the
--     draft was based on) and draft_id, set exactly for that source; an authored row has neither
--     url nor bundle_sha256 and names the draft commit as its commit. A draft becomes at most one
--     install.
--   * request_authoring, record_draft and decide_draft append one row each; course_authoring(course)
--     reads a course's requests with their drafts and decisions. install_course and
--     installed_courses are replaced to carry the new columns. All are granted to school_app.
--
-- request_authoring, decide_draft and install_course serialise per course name on install_course's
-- advisory lock, so "the course's current install" cannot change between a check and its write;
-- record_draft serialises per request. All four writers need READ COMMITTED (0005).

-- ---- Tables ------------------------------------------------------------------------------------

CREATE TABLE school.authoring_requests (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  id uuid NOT NULL CONSTRAINT authoring_requests_id UNIQUE,
  -- NAME and RESERVED in server/config.ts, as course_installs_course.
  course text NOT NULL CONSTRAINT authoring_requests_course
    CHECK (course ~ '^[a-z0-9][a-z0-9-]*$' AND course NOT IN ('assets', 'courses', 'lessons', 'reference', 'api')),
  base_install_id uuid NOT NULL CONSTRAINT authoring_requests_base REFERENCES school.course_installs (id),
  text text NOT NULL CONSTRAINT authoring_requests_text CHECK (char_length(text) BETWEEN 1 AND 20000),
  skill_sha256 text NOT NULL CONSTRAINT authoring_requests_skill CHECK (skill_sha256 ~ '^[0-9a-f]{64}$'),
  school_version text NOT NULL CONSTRAINT authoring_requests_school_version CHECK (char_length(school_version) BETWEEN 1 AND 200),
  at timestamptz NOT NULL
);
CREATE INDEX authoring_requests_course_seq ON school.authoring_requests (course, seq);

CREATE TABLE school.authoring_drafts (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  id uuid NOT NULL CONSTRAINT authoring_drafts_id UNIQUE,
  request_id uuid NOT NULL CONSTRAINT authoring_drafts_request REFERENCES school.authoring_requests (id),
  round integer NOT NULL CONSTRAINT authoring_drafts_round CHECK (round IN (1, 2)),
  status text NOT NULL CONSTRAINT authoring_drafts_status CHECK (status IN ('ready', 'refused', 'failed')),
  agent text CONSTRAINT authoring_drafts_agent CHECK (CASE WHEN agent IS NULL THEN status = 'failed' ELSE agent <> '' END),
  commit text CONSTRAINT authoring_drafts_commit
    CHECK ((commit IS NOT NULL) = (status <> 'failed') AND (commit IS NULL OR commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')),
  content_sha256 text CONSTRAINT authoring_drafts_content
    CHECK ((content_sha256 IS NOT NULL) = (status <> 'failed') AND (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')),
  check_message text CONSTRAINT authoring_drafts_check_message
    CHECK ((check_message IS NOT NULL) = (status = 'refused') AND (check_message IS NULL OR check_message <> '')),
  input_tokens integer CONSTRAINT authoring_drafts_input_tokens CHECK (input_tokens >= 0),
  output_tokens integer CONSTRAINT authoring_drafts_output_tokens CHECK (output_tokens >= 0),
  at timestamptz NOT NULL,
  CONSTRAINT authoring_drafts_one_per_round UNIQUE (request_id, round)
);

ALTER TABLE school.course_installs DROP CONSTRAINT course_installs_source;
ALTER TABLE school.course_installs ADD CONSTRAINT course_installs_source CHECK (source IN ('git', 'bundle', 'authored'));
ALTER TABLE school.course_installs
  ADD COLUMN parent_install_id uuid CONSTRAINT course_installs_parent REFERENCES school.course_installs (id),
  ADD COLUMN draft_id uuid CONSTRAINT course_installs_draft_once UNIQUE CONSTRAINT course_installs_draft REFERENCES school.authoring_drafts (id);
ALTER TABLE school.course_installs ADD CONSTRAINT course_installs_authored
  CHECK ((parent_install_id IS NOT NULL) = (source = 'authored') AND (draft_id IS NOT NULL) = (source = 'authored'));

CREATE TABLE school.authoring_decisions (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  id uuid NOT NULL CONSTRAINT authoring_decisions_id UNIQUE,
  draft_id uuid NOT NULL CONSTRAINT authoring_decisions_once UNIQUE CONSTRAINT authoring_decisions_draft REFERENCES school.authoring_drafts (id),
  decision text NOT NULL CONSTRAINT authoring_decisions_decision CHECK (decision IN ('accepted', 'discarded')),
  install_id uuid CONSTRAINT authoring_decisions_install REFERENCES school.course_installs (id),
  patch text,
  at timestamptz NOT NULL,
  CONSTRAINT authoring_decisions_accepted CHECK ((install_id IS NOT NULL) = (decision = 'accepted') AND (patch IS NOT NULL) = (decision = 'accepted')
                                                 AND (patch IS NULL OR patch <> ''))
);

CREATE TRIGGER authoring_requests_append_only BEFORE UPDATE OR DELETE ON school.authoring_requests FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER authoring_requests_no_truncate BEFORE TRUNCATE ON school.authoring_requests FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER authoring_drafts_append_only BEFORE UPDATE OR DELETE ON school.authoring_drafts FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER authoring_drafts_no_truncate BEFORE TRUNCATE ON school.authoring_drafts FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER authoring_decisions_append_only BEFORE UPDATE OR DELETE ON school.authoring_decisions FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER authoring_decisions_no_truncate BEFORE TRUNCATE ON school.authoring_decisions FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();

-- ---- Functions ---------------------------------------------------------------------------------

-- Internal: the course's current install, its latest install by seq with no later removal, or NULL.
-- Not granted to anyone.
CREATE FUNCTION school.current_install(p_course text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = school, pg_temp
RETURN (
  SELECT i.id FROM school.course_installs i
  WHERE i.course = p_course
    AND NOT EXISTS (SELECT 1 FROM school.course_removals r WHERE r.course = p_course AND r.seq > i.seq)
  ORDER BY i.seq DESC LIMIT 1);

-- install_course(id, course, source, url, bundle_sha256, commit, content_sha256, title, format,
--                parent_install_id, draft_id, at) -> text
-- As 0010's, with the install's parent and draft, both NULL unless the source is 'authored'.
-- Answers 'installed', 'updated', 'duplicate' (this id already holds this same install, whatever its
-- at) or 'conflict' (it holds another; the first stands), as before. An authored install stores
-- nothing and answers 'rejected' unless its draft is a `ready` draft, with no decision and no install
-- yet, whose commit and content digest it names, of a request under this course name based on its parent; then 'stale' unless its parent is
-- still the course's current install. A malformed install raises on the table's constraints and
-- stores nothing.
DROP FUNCTION school.install_course(uuid, text, text, text, text, text, text, text, integer, timestamptz);
CREATE FUNCTION school.install_course(p_id uuid, p_course text, p_source text, p_url text, p_bundle_sha256 text, p_commit text,
                                      p_content_sha256 text, p_title text, p_format integer, p_parent_install_id uuid, p_draft_id uuid,
                                      p_at timestamptz)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_current uuid;
  v_seq bigint;
  i school.course_installs%ROWTYPE;
BEGIN
  PERFORM school.require_read_committed('school.install_course');
  PERFORM pg_advisory_xact_lock(hashtextextended('school.course_installs ' || coalesce(p_course, ''), 0));
  IF NOT EXISTS (SELECT 1 FROM school.course_installs c WHERE c.id = p_id) THEN
    v_current := school.current_install(p_course);
    -- A missing parent or draft is malformed: the insert raises on course_installs_authored.
    IF p_source = 'authored' AND p_parent_install_id IS NOT NULL AND p_draft_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM school.authoring_drafts d JOIN school.authoring_requests q ON q.id = d.request_id
        WHERE d.id = p_draft_id AND d.status = 'ready' AND d.commit = p_commit AND d.content_sha256 = p_content_sha256 AND q.course = p_course AND q.base_install_id = p_parent_install_id
          AND NOT EXISTS (SELECT 1 FROM school.authoring_decisions x WHERE x.draft_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM school.course_installs c WHERE c.draft_id = d.id)) THEN
        RETURN 'rejected';
      END IF;
      IF v_current IS DISTINCT FROM p_parent_install_id THEN
        RETURN 'stale';
      END IF;
    END IF;
    INSERT INTO school.course_installs AS c (id, course, source, url, bundle_sha256, commit, content_sha256, title, format,
                                             parent_install_id, draft_id, at)
    VALUES (p_id, p_course, p_source, p_url, p_bundle_sha256, p_commit, p_content_sha256, p_title, p_format,
            p_parent_install_id, p_draft_id, p_at)
    ON CONFLICT (id) DO NOTHING
    RETURNING c.seq INTO v_seq;
    IF v_seq IS NOT NULL THEN
      RETURN CASE WHEN v_current IS NOT NULL THEN 'updated' ELSE 'installed' END;
    END IF;
  END IF;
  -- The id is taken: by this same install (a resend), or by another, perhaps under another name.
  SELECT * INTO i FROM school.course_installs c WHERE c.id = p_id;
  IF i.course = p_course AND i.source = p_source AND i.url IS NOT DISTINCT FROM p_url
     AND i.bundle_sha256 IS NOT DISTINCT FROM p_bundle_sha256 AND i.commit = p_commit AND i.content_sha256 = p_content_sha256
     AND i.title = p_title AND i.format IS NOT DISTINCT FROM p_format
     AND i.parent_install_id IS NOT DISTINCT FROM p_parent_install_id AND i.draft_id IS NOT DISTINCT FROM p_draft_id THEN
    RETURN 'duplicate';
  END IF;
  RETURN 'conflict';
END
$$;
GRANT EXECUTE ON FUNCTION school.install_course(uuid, text, text, text, text, text, text, text, integer, uuid, uuid, timestamptz) TO school_app;

-- installed_courses() -> rows of (id, course, source, url, bundle_sha256, commit, content_sha256,
--   title, format, at, trusted, parent_install_id, draft_id), ordered by course
-- As 0010's, with each install's parent and draft (NULL unless it was authored).
DROP FUNCTION school.installed_courses();
CREATE FUNCTION school.installed_courses()
RETURNS TABLE (id uuid, course text, source text, url text, bundle_sha256 text, commit text, content_sha256 text,
               title text, format integer, at timestamptz, trusted boolean, parent_install_id uuid, draft_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT i.id, i.course, i.source, i.url, i.bundle_sha256, i.commit, i.content_sha256, i.title, i.format, i.at,
         coalesce((SELECT t.trusted FROM school.course_trust_choices t WHERE t.install_id = i.id ORDER BY t.seq DESC LIMIT 1), false),
         i.parent_install_id, i.draft_id
  FROM school.course_installs i
  WHERE i.seq = (SELECT max(j.seq) FROM school.course_installs j WHERE j.course = i.course)
    AND NOT EXISTS (SELECT 1 FROM school.course_removals r WHERE r.course = i.course AND r.seq > i.seq)
  ORDER BY i.course COLLATE "C"
$$;
GRANT EXECUTE ON FUNCTION school.installed_courses() TO school_app;

-- request_authoring(id, course, base_install_id, text, skill_sha256, school_version, at) -> text
-- Appends a request. Answers 'stored'; 'duplicate' (this id already holds this same request, whatever
-- its at); 'conflict' (it holds another; the first stands); or 'refused', storing nothing, when the
-- base is not the course's current install. A malformed request raises on the table's constraints.
CREATE FUNCTION school.request_authoring(p_id uuid, p_course text, p_base_install_id uuid, p_text text, p_skill_sha256 text,
                                         p_school_version text, p_at timestamptz)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_seq bigint;
  q school.authoring_requests%ROWTYPE;
BEGIN
  PERFORM school.require_read_committed('school.request_authoring');
  PERFORM pg_advisory_xact_lock(hashtextextended('school.course_installs ' || coalesce(p_course, ''), 0));
  IF NOT EXISTS (SELECT 1 FROM school.authoring_requests r WHERE r.id = p_id) THEN
    IF school.current_install(p_course) IS DISTINCT FROM p_base_install_id THEN
      RETURN 'refused';
    END IF;
    INSERT INTO school.authoring_requests AS r (id, course, base_install_id, text, skill_sha256, school_version, at)
    VALUES (p_id, p_course, p_base_install_id, p_text, p_skill_sha256, p_school_version, p_at)
    ON CONFLICT (id) DO NOTHING
    RETURNING r.seq INTO v_seq;
    IF v_seq IS NOT NULL THEN RETURN 'stored'; END IF;
  END IF;
  SELECT * INTO q FROM school.authoring_requests r WHERE r.id = p_id;
  RETURN CASE WHEN q.course = p_course AND q.base_install_id = p_base_install_id AND q.text = p_text
                   AND q.skill_sha256 = p_skill_sha256 AND q.school_version = p_school_version
              THEN 'duplicate' ELSE 'conflict' END;
END
$$;
GRANT EXECUTE ON FUNCTION school.request_authoring(uuid, text, uuid, text, text, text, timestamptz) TO school_app;

-- record_draft(id, request_id, round, status, agent, commit, content_sha256, check_message,
--              input_tokens, output_tokens, at) -> text
-- Appends one round of a request. Answers 'stored'; 'duplicate' (this id already holds this same
-- draft, whatever its at); 'conflict' (it holds another; the first stands); or 'rejected', storing
-- nothing, when no request has that id or the round is not the request's next: round 1 once it has
-- any draft, round 2 unless round 1 was refused, has no decision and there is no round 2 yet. A malformed draft (a
-- round other than 1 or 2, fields that do not match its status) raises on the table's constraints.
CREATE FUNCTION school.record_draft(p_id uuid, p_request uuid, p_round integer, p_status text, p_agent text, p_commit text,
                                    p_content_sha256 text, p_check_message text, p_input_tokens integer, p_output_tokens integer,
                                    p_at timestamptz)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_seq bigint;
  d school.authoring_drafts%ROWTYPE;
BEGIN
  PERFORM school.require_read_committed('school.record_draft');
  PERFORM pg_advisory_xact_lock(hashtextextended('school.authoring_drafts ' || coalesce(p_request::text, ''), 0));
  IF NOT EXISTS (SELECT 1 FROM school.authoring_drafts x WHERE x.id = p_id) THEN
    IF NOT EXISTS (SELECT 1 FROM school.authoring_requests q WHERE q.id = p_request)
       OR (p_round = 1 AND EXISTS (SELECT 1 FROM school.authoring_drafts x WHERE x.request_id = p_request))
       OR (p_round = 2 AND NOT (EXISTS (SELECT 1 FROM school.authoring_drafts x WHERE x.request_id = p_request AND x.round = 1 AND x.status = 'refused'
                                        AND NOT EXISTS (SELECT 1 FROM school.authoring_decisions y WHERE y.draft_id = x.id))
                                AND NOT EXISTS (SELECT 1 FROM school.authoring_drafts x WHERE x.request_id = p_request AND x.round = 2))) THEN
      RETURN 'rejected';
    END IF;
    INSERT INTO school.authoring_drafts AS x (id, request_id, round, status, agent, commit, content_sha256, check_message,
                                              input_tokens, output_tokens, at)
    VALUES (p_id, p_request, p_round, p_status, p_agent, p_commit, p_content_sha256, p_check_message, p_input_tokens, p_output_tokens, p_at)
    ON CONFLICT (id) DO NOTHING
    RETURNING x.seq INTO v_seq;
    IF v_seq IS NOT NULL THEN RETURN 'stored'; END IF;
  END IF;
  SELECT * INTO d FROM school.authoring_drafts x WHERE x.id = p_id;
  RETURN CASE WHEN d.request_id = p_request AND d.round = p_round AND d.status = p_status AND d.agent IS NOT DISTINCT FROM p_agent
                   AND d.commit IS NOT DISTINCT FROM p_commit AND d.content_sha256 IS NOT DISTINCT FROM p_content_sha256
                   AND d.check_message IS NOT DISTINCT FROM p_check_message AND d.input_tokens IS NOT DISTINCT FROM p_input_tokens
                   AND d.output_tokens IS NOT DISTINCT FROM p_output_tokens
              THEN 'duplicate' ELSE 'conflict' END;
END
$$;
GRANT EXECUTE ON FUNCTION school.record_draft(uuid, uuid, integer, text, text, text, text, text, integer, integer, timestamptz) TO school_app;

-- decide_draft(id, draft_id, decision, install_id, patch, at) -> text
-- Appends the decision on a draft. Answers 'stored'; 'duplicate' (this id already holds this same
-- decision, whatever its at); 'conflict' (it holds another; the first stands). Storing nothing, it
-- answers 'rejected' when no draft has that id; 'already-decided' when the draft has a decision; and,
-- for an accept: 'not-ready' when the draft is not `ready`; 'rejected' when install_id is not the
-- draft's own authored install (under its course, on its request's base); 'stale' when that install
-- is no longer the course's current one. A discard is stored whatever the draft's status or base, but 'rejected' when an install already names the draft.
-- A malformed decision raises on the table's constraints.
CREATE FUNCTION school.decide_draft(p_id uuid, p_draft uuid, p_decision text, p_install uuid, p_patch text, p_at timestamptz)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_course text;
  v_base uuid;
  v_status text;
  v_seq bigint;
  x school.authoring_decisions%ROWTYPE;
BEGIN
  PERFORM school.require_read_committed('school.decide_draft');
  -- A draft's course and base never change, so they may be read before the course's lock.
  SELECT q.course, q.base_install_id, d.status INTO v_course, v_base, v_status
  FROM school.authoring_drafts d JOIN school.authoring_requests q ON q.id = d.request_id WHERE d.id = p_draft;
  PERFORM pg_advisory_xact_lock(hashtextextended('school.course_installs ' || coalesce(v_course, ''), 0));
  IF NOT EXISTS (SELECT 1 FROM school.authoring_decisions y WHERE y.id = p_id) THEN
    IF v_status IS NULL THEN
      RETURN 'rejected';
    END IF;
    IF EXISTS (SELECT 1 FROM school.authoring_decisions y WHERE y.draft_id = p_draft) THEN
      RETURN 'already-decided';
    END IF;
    -- An install already names the draft: the accept is yet to be recorded, and a discard would
    -- contradict the install.
    IF p_decision = 'discarded' AND EXISTS (SELECT 1 FROM school.course_installs c WHERE c.draft_id = p_draft) THEN
      RETURN 'rejected';
    END IF;
    -- An accept with no install is malformed: the insert raises on authoring_decisions_accepted.
    IF p_decision = 'accepted' AND p_install IS NOT NULL THEN
      IF v_status <> 'ready' THEN
        RETURN 'not-ready';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM school.course_installs c
                     WHERE c.id = p_install AND c.draft_id = p_draft AND c.course = v_course AND c.parent_install_id = v_base) THEN
        RETURN 'rejected';
      END IF;
      IF school.current_install(v_course) IS DISTINCT FROM p_install THEN
        RETURN 'stale';
      END IF;
    END IF;
    INSERT INTO school.authoring_decisions AS y (id, draft_id, decision, install_id, patch, at)
    VALUES (p_id, p_draft, p_decision, p_install, p_patch, p_at)
    ON CONFLICT (id) DO NOTHING
    RETURNING y.seq INTO v_seq;
    IF v_seq IS NOT NULL THEN RETURN 'stored'; END IF;
  END IF;
  SELECT * INTO x FROM school.authoring_decisions y WHERE y.id = p_id;
  RETURN CASE WHEN x.draft_id = p_draft AND x.decision = p_decision AND x.install_id IS NOT DISTINCT FROM p_install
                   AND x.patch IS NOT DISTINCT FROM p_patch
              THEN 'duplicate' ELSE 'conflict' END;
END
$$;
GRANT EXECUTE ON FUNCTION school.decide_draft(uuid, uuid, text, uuid, text, timestamptz) TO school_app;

-- course_authoring(course) -> rows of (request jsonb), in seq order
-- The course's requests, each as the model's RecordedRequest: its fields, its at as school.iso
-- text, and its drafts in seq order, each with its decision or null. Reads only.
CREATE FUNCTION school.course_authoring(p_course text) RETURNS TABLE (request jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', q.id, 'course', q.course, 'baseInstallId', q.base_install_id, 'text', q.text, 'skillSha256', q.skill_sha256,
    'schoolVersion', q.school_version, 'at', school.iso(q.at),
    'drafts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'round', d.round, 'status', d.status, 'agent', d.agent, 'commit', d.commit, 'contentSha256', d.content_sha256,
        'checkMessage', d.check_message, 'inputTokens', d.input_tokens, 'outputTokens', d.output_tokens, 'at', school.iso(d.at),
        'decision', (SELECT jsonb_build_object('id', x.id, 'decision', x.decision, 'installId', x.install_id, 'patch', x.patch, 'at', school.iso(x.at))
                     FROM school.authoring_decisions x WHERE x.draft_id = d.id)) ORDER BY d.seq)
      FROM school.authoring_drafts d WHERE d.request_id = q.id), '[]'::jsonb))
  FROM school.authoring_requests q
  WHERE q.course = p_course
  ORDER BY q.seq
$$;
GRANT EXECUTE ON FUNCTION school.course_authoring(text) TO school_app;
