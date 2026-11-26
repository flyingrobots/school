-- 0010: installed courses (RFC 7 §7; flyingrobots/school#232).
--
-- A learner adds a course from School's own pages, from a git repository at a commit or from an
-- uploaded git bundle. The files go to the course store; the record keeps, append-only like every
-- record table, which commit of which course the learner had at any moment, and whether they
-- trusted it.
--
-- What this adds:
--   * course_installs: each install, under the course name the learner chose (its progress key),
--     with where it came from (a https URL, or a bundle's SHA-256), the commit, the SHA-256 of the
--     installed files' manifest, and the title and format version its course.json declared. A
--     later install under the same name is an update.
--   * course_removals: each time a course stopped being installed. Its progress is untouched.
--   * course_trust_choices: each trust choice, for one install, so a new commit starts untrusted.
--   * install_course, remove_installed_course, choose_course_trust: append one row each;
--     installed_courses(): each name's current install, its latest install with no later
--     removal, with its latest trust choice (none means untrusted). All four are granted to
--     school_app.
--
-- source is one named CHECK, course_installs_source, so a later migration can widen it (RFC 9
-- adds `authored`) by dropping and adding that constraint alone: the URL and bundle rules ask
-- only that each is set exactly for its own source. install_course and remove_installed_course
-- serialise per course name on an advisory lock, and so need READ COMMITTED (0005).

CREATE TABLE school.course_installs (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  id uuid NOT NULL CONSTRAINT course_installs_id UNIQUE,
  -- NAME and RESERVED in server/config.ts.
  course text NOT NULL CONSTRAINT course_installs_course
    CHECK (course ~ '^[a-z0-9][a-z0-9-]*$' AND course NOT IN ('assets', 'courses', 'lessons', 'reference', 'api')),
  source text NOT NULL CONSTRAINT course_installs_source CHECK (source IN ('git', 'bundle')),
  url text CONSTRAINT course_installs_url CHECK ((url IS NOT NULL) = (source = 'git') AND (url IS NULL OR url ~ '^https://\S+$')),
  bundle_sha256 text CONSTRAINT course_installs_bundle
    CHECK ((bundle_sha256 IS NOT NULL) = (source = 'bundle') AND (bundle_sha256 IS NULL OR bundle_sha256 ~ '^[0-9a-f]{64}$')),
  commit text NOT NULL CONSTRAINT course_installs_commit CHECK (commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  content_sha256 text NOT NULL CONSTRAINT course_installs_content CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  title text NOT NULL CONSTRAINT course_installs_title CHECK (btrim(title) <> ''),
  format integer CONSTRAINT course_installs_format CHECK (format > 0),
  at timestamptz NOT NULL
);
CREATE INDEX course_installs_course_seq ON school.course_installs (course, seq);

CREATE TABLE school.course_removals (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  id uuid NOT NULL CONSTRAINT course_removals_id UNIQUE,
  course text NOT NULL CONSTRAINT course_removals_course
    CHECK (course ~ '^[a-z0-9][a-z0-9-]*$' AND course NOT IN ('assets', 'courses', 'lessons', 'reference', 'api')),
  at timestamptz NOT NULL
);
CREATE INDEX course_removals_course_seq ON school.course_removals (course, seq);

CREATE TABLE school.course_trust_choices (
  seq bigint PRIMARY KEY DEFAULT nextval('school.record_seq'),
  id uuid NOT NULL CONSTRAINT course_trust_choices_id UNIQUE,
  install_id uuid NOT NULL REFERENCES school.course_installs (id),
  trusted boolean NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX course_trust_choices_install_seq ON school.course_trust_choices (install_id, seq);

CREATE TRIGGER course_installs_append_only BEFORE UPDATE OR DELETE ON school.course_installs FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER course_installs_no_truncate BEFORE TRUNCATE ON school.course_installs FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER course_removals_append_only BEFORE UPDATE OR DELETE ON school.course_removals FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER course_removals_no_truncate BEFORE TRUNCATE ON school.course_removals FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER course_trust_choices_append_only BEFORE UPDATE OR DELETE ON school.course_trust_choices FOR EACH ROW EXECUTE FUNCTION school.refuse_change();
CREATE TRIGGER course_trust_choices_no_truncate BEFORE TRUNCATE ON school.course_trust_choices FOR EACH STATEMENT EXECUTE FUNCTION school.refuse_change();

-- Internal: true when `course` has a current install. Not granted to anyone.
CREATE FUNCTION school.course_is_installed(p_course text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = school, pg_temp
RETURN EXISTS (
  SELECT 1 FROM school.course_installs i
  WHERE i.course = p_course
    AND NOT EXISTS (SELECT 1 FROM school.course_removals r WHERE r.course = p_course AND r.seq > i.seq));

-- install_course(id, course, source, url, bundle_sha256, commit, content_sha256, title, format, at) -> text
-- Appends an install, which becomes the course's current one. Answers 'installed' (the name had no
-- current install), 'updated' (it had one), 'duplicate' (this id already holds this same install,
-- whatever its at) or 'conflict' (it holds another; the first stands). A malformed install raises
-- on the table's constraints and stores nothing.
CREATE FUNCTION school.install_course(p_id uuid, p_course text, p_source text, p_url text, p_bundle_sha256 text, p_commit text,
                                      p_content_sha256 text, p_title text, p_format integer, p_at timestamptz)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
DECLARE
  v_updated boolean;
  v_seq bigint;
  i school.course_installs%ROWTYPE;
BEGIN
  PERFORM school.require_read_committed('school.install_course');
  PERFORM pg_advisory_xact_lock(hashtextextended('school.course_installs ' || coalesce(p_course, ''), 0));
  v_updated := school.course_is_installed(p_course);
  INSERT INTO school.course_installs AS c (id, course, source, url, bundle_sha256, commit, content_sha256, title, format, at)
  VALUES (p_id, p_course, p_source, p_url, p_bundle_sha256, p_commit, p_content_sha256, p_title, p_format, p_at)
  ON CONFLICT (id) DO NOTHING
  RETURNING c.seq INTO v_seq;
  IF v_seq IS NOT NULL THEN
    RETURN CASE WHEN v_updated THEN 'updated' ELSE 'installed' END;
  END IF;
  SELECT * INTO i FROM school.course_installs c WHERE c.id = p_id;
  IF i.course = p_course AND i.source = p_source AND i.url IS NOT DISTINCT FROM p_url
     AND i.bundle_sha256 IS NOT DISTINCT FROM p_bundle_sha256 AND i.commit = p_commit AND i.content_sha256 = p_content_sha256
     AND i.title = p_title AND i.format IS NOT DISTINCT FROM p_format THEN
    RETURN 'duplicate';
  END IF;
  RETURN 'conflict';
END
$$;
GRANT EXECUTE ON FUNCTION school.install_course(uuid, text, text, text, text, text, text, text, integer, timestamptz) TO school_app;

-- remove_installed_course(course, at) -> text
-- Appends a removal: the course is no longer current. Answers 'removed', or 'not-installed',
-- storing nothing, when it has no current install. Its progress is untouched.
CREATE FUNCTION school.remove_installed_course(p_course text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
BEGIN
  PERFORM school.require_read_committed('school.remove_installed_course');
  PERFORM pg_advisory_xact_lock(hashtextextended('school.course_installs ' || coalesce(p_course, ''), 0));
  IF NOT school.course_is_installed(p_course) THEN
    RETURN 'not-installed';
  END IF;
  INSERT INTO school.course_removals (id, course, at) VALUES (gen_random_uuid(), p_course, p_at);
  RETURN 'removed';
END
$$;
GRANT EXECUTE ON FUNCTION school.remove_installed_course(text, timestamptz) TO school_app;

-- choose_course_trust(install_id, trusted, at) -> text
-- Appends a trust choice for one install. Answers 'stored', or 'rejected', storing nothing, when
-- no install has that id.
CREATE FUNCTION school.choose_course_trust(p_install uuid, p_trusted boolean, p_at timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = school, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school.course_installs c WHERE c.id = p_install) THEN
    RETURN 'rejected';
  END IF;
  INSERT INTO school.course_trust_choices (id, install_id, trusted, at) VALUES (gen_random_uuid(), p_install, p_trusted, p_at);
  RETURN 'stored';
END
$$;
GRANT EXECUTE ON FUNCTION school.choose_course_trust(uuid, boolean, timestamptz) TO school_app;

-- installed_courses() -> rows of (id, course, source, url, bundle_sha256, commit, content_sha256,
--   title, format, at, trusted), ordered by course
-- Each name's current install: its latest install by seq with no later removal, and the latest
-- trust choice for that install, false when there is none.
CREATE FUNCTION school.installed_courses()
RETURNS TABLE (id uuid, course text, source text, url text, bundle_sha256 text, commit text, content_sha256 text,
               title text, format integer, at timestamptz, trusted boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = school, pg_temp AS $$
  SELECT i.id, i.course, i.source, i.url, i.bundle_sha256, i.commit, i.content_sha256, i.title, i.format, i.at,
         coalesce((SELECT t.trusted FROM school.course_trust_choices t WHERE t.install_id = i.id ORDER BY t.seq DESC LIMIT 1), false)
  FROM school.course_installs i
  WHERE i.seq = (SELECT max(j.seq) FROM school.course_installs j WHERE j.course = i.course)
    AND NOT EXISTS (SELECT 1 FROM school.course_removals r WHERE r.course = i.course AND r.seq > i.seq)
  ORDER BY i.course COLLATE "C"
$$;
GRANT EXECUTE ON FUNCTION school.installed_courses() TO school_app;
