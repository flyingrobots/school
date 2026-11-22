# Ubuntu LTS, with Bun copied in from the official image at the pinned version (ADR 4).
# Bun ships no Ubuntu image of its own; its binary is self-contained, SQLite included.
FROM oven/bun:1.4.4 AS bun

FROM ubuntu:26.04
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY *.ts ./
# The course and any source mounts are supplied at run time, not baked in (ADR 6).
ENV HOST=0.0.0.0 PORT=4747 SCHOOL_ROOT=/framework SCHOOL_COURSE=/course SCHOOL_STATE=/state
# A dedicated non-root user with no extra groups (Ubuntu's own `ubuntu` user is in sudo, adm
# and others). uid 1000, as the Alpine image's `bun` user was, so existing state keeps working.
RUN userdel --remove ubuntu && useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin school
USER school
EXPOSE 4747
CMD ["bun", "server.ts"]
