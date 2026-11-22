FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY server.ts blocks.ts render.ts migrate.ts ./
ENV HOST=0.0.0.0 PORT=4747 SCHOOL_ROOT=/school AION_ROOT=/aion DB_PATH=/school/progress/progress.db
USER bun
EXPOSE 4747
CMD ["bun", "server.ts"]
