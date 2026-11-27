// Opening a lesson over HTTP the way the web app does (web/src/lib/school-api.ts, openLesson): a
// JSON POST to the lesson's address, which opens the learner's encounter or resumes the open one
// (flyingrobots/school#321). A GET of the same address only reads the lesson. Not shipped
// (server/.dockerignore).

/**
 * Opens or resumes `lesson` of `course` on the School at `base`. `query` is the address's query,
 * `?aid=1` and `&tz=` as the page sends them, or empty for an untracked encounter; `headers` are
 * added to the JSON content type, such as the fetch metadata a browser sends.
 */
export function openLesson(base: string, course: string, lesson: string, query = "", headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/courses/${course}/lessons/${lesson}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: "{}",
  });
}
