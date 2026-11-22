# Notes
- User is the author of AIΩN but asked to be taught "as if I don't know any of this stuff". Don't skip basics; don't assume they know the jargon.
- Mission = explaining to others, so every lesson should end with a "say it out loud" explanation exercise.
- Progress: lessons are served by `server/` (Docker, port 4747). At the start of each session, query `progress/progress.db` (tables `answers`, `views`) to see first-try accuracy and what was missed. Decisions are in `docs/adr/`.
- Lessons are written one at a time, as we go. Only the direction is planned (roughly the papers in order). Don't write a syllabus unless asked — see `docs/rfc/0001-school.md`, "How lessons are planned".
- The user's shell `ls` is aliased to `eza` and prints **nothing** when run non-interactively, which once made an agent read this workspace as empty. Use `/bin/ls`, or `git ls-files`.
- Captured `/teach` session transcripts (`*command-message*.txt`) are gitignored on purpose. Keep them local; never commit them.

