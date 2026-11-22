FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY server.ts blocks.ts render.ts migrate.ts config.ts record.ts ./
# The course and any source mounts are supplied at run time, not baked in (ADR 6).
ENV HOST=0.0.0.0 PORT=4747 SCHOOL_ROOT=/framework SCHOOL_COURSE=/course SCHOOL_STATE=/state
USER bun
EXPOSE 4747
CMD ["bun", "server.ts"]
