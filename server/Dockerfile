# Ubuntu LTS, with Bun copied in from the official image at the pinned version (ADR 4).
# Bun ships no Ubuntu image of its own; its binary is self-contained.
FROM oven/bun:1.4.4 AS bun

FROM ubuntu:26.04
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# git fetches an installed course's commit over https, which needs the CA certificates
# (RFC 7 §5.1 and §6, flyingrobots/school#233).
RUN apt-get update && apt-get install --yes --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
# The build context is already filtered by .dockerignore: modules at any depth, no tests.
COPY . ./
# The course and any source mounts are supplied at run time, not baked in (ADR 6).
ENV HOST=0.0.0.0 PORT=4747 SCHOOL_ROOT=/framework SCHOOL_COURSE=/course SCHOOL_STATE=/state
# A dedicated non-root user with no extra groups (Ubuntu's own `ubuntu` user is in sudo, adm
# and others). uid 1000, as the Alpine image's `bun` user was, so existing state keeps working.
RUN userdel --remove ubuntu && useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin school
# The course store's mount point (SCHOOL_COURSE_STORE under compose). Docker fills a new, empty
# named volume from the image's folder at its mount point, owner included, so `school` can write it.
RUN install --directory --owner=school --group=school --mode=0755 /store
USER school
EXPOSE 4747
CMD ["bun", "server.ts"]
