-- 0014: due review brings back a quiz whose mastery has faded (RFC 5 §4.6, Table 5.1 step 3;
-- flyingrobots/school#219).
--
-- A quiz answered cleanly was never brought back, however long ago. Mastery (0011) now says how far
-- through its half-life each quiz is, so due review gains one rule, ranked after the three it has.
--
-- What this changes:
--   * due_review (0012's) is replaced with the same signature, return type, volatility, security
--     and search_path; CREATE OR REPLACE keeps its grant. Its three rules, their ranking, what they
--     cite and the facts they return are 0012's, unchanged. It adds 'due-review/faded': a block
--     none of them chose, settled, whose strength from mastery at `at` is below one half, and whose
--     latest answer is at least delay_ms before `at`. Faded items come after every weak one, lowest
--     strength first, then by the seq of the first try that last refreshed them, and fill only what
--     the weak ones leave of `limit`.
--
-- Order is the record's: "latest" and "first" are by seq, never by `at` (RFC 3 §3.4). `at` is read
-- only to measure elapsed time. The caller passes the time.

-- due_review(course, blocks, at, delay_ms, limit) -> rows of (item), at most `limit`
-- blocks is a jsonb array of quiz block ids (anything else asks about none).
--
-- Weak items, as 0012's: a block's latest weak episode (quiz_episodes) is due when no clean episode
-- follows it at least delay_ms after its last answer, and the block's latest answer is at least
-- delay_ms before `at`. They rank wrong first tries, then aided, then unknown aid, oldest first try
-- first within a rule, and take the first `limit` places. Each cites:
--   wrong first try: the episode's answers up to its first right one (all if none), and the block's
--                    and the encounter's exposures in it before the last of those;
--   aided:           the block's and the encounter's exposures in it before the first try, and it;
--   unknown aid:     the encounter row, and the first try.
--
-- Faded items take the places left. A block is faded when it is not a weak item, mastery says it is
-- settled with strength below one half (a whole stability has passed since it was refreshed), and
-- its latest answer is at least delay_ms before `at`. It cites mastery's evidence: the anchor's
-- first try, each counted episode's first try and the latest right first try, at most 100. Its
-- answeredAt is mastery's refreshedAt; corrected is false and shown is [].
--
-- item is {blockId, rule, answeredAt, corrected, shown, lastSeen, evidence}.
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
  ),
  weak AS (
    SELECT d.rank, NULL::float8 AS strength, d.first_seq AS seq,
           jsonb_build_object(
             'blockId', d.block_id,
             'rule', 'due-review/' || d.weakness,
             'answeredAt', school.iso(d.first_at),
             'corrected', d.weakness = 'wrong-first-try' AND d.right_seq IS NOT NULL,
             'shown', coalesce((SELECT jsonb_agg(k.kind ORDER BY k.first) FROM (
                         SELECT c.kind, min(c.seq) AS first FROM capped c
                         WHERE c.block_id = d.block_id AND c.n <= 100 AND c.kind NOT IN ('answer', 'encounter') GROUP BY c.kind) k),
                       '[]'::jsonb),
             'lastSeen', school.iso(d.seen_at),
             'evidence', (SELECT jsonb_agg(c.seq ORDER BY c.seq) FROM capped c WHERE c.block_id = d.block_id AND c.n <= 100)) AS item
    FROM due d
  ),
  room AS (
    SELECT greatest(p_limit, 0) - (SELECT count(*) FROM due) AS n
  ),
  held AS (
    -- Measured only when the weak items leave room: a full list never reads mastery.
    SELECT m.item ->> 'blockId' AS block_id, (m.item ->> 'strength')::float8 AS strength, m.item
    FROM school.mastery(p_course, p_blocks, p_at, p_delay_ms) m
    WHERE (SELECT n FROM room) > 0
  ),
  faded AS (
    SELECT 3 AS rank, h.strength,
           (SELECT max(e.value::bigint) FROM jsonb_array_elements_text(h.item -> 'evidence') e) AS seq,
           jsonb_build_object(
             'blockId', h.block_id,
             'rule', 'due-review/faded',
             'answeredAt', h.item -> 'refreshedAt',
             'corrected', false,
             'shown', '[]'::jsonb,
             'lastSeen', school.iso(s.at),
             'evidence', h.item -> 'evidence') AS item
    FROM held h JOIN last_seen s ON s.block_id = h.block_id
    WHERE (h.item ->> 'settled')::boolean AND h.strength < 0.5
      AND p_at - s.at >= p_delay_ms * interval '1 millisecond'
      AND NOT EXISTS (SELECT 1 FROM due d WHERE d.block_id = h.block_id)
    ORDER BY h.strength, seq
    LIMIT (SELECT n FROM room)
  )
  SELECT x.item FROM (SELECT * FROM weak UNION ALL SELECT * FROM faded) x
  ORDER BY x.rank, x.strength, x.seq
$$;
