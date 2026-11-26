// A process that writes to both streams and never serves: processes.test.ts starts it as School to
// see a start that never gets ready. It lives in the repository, not in tmpdir(): Bun reads the
// directory a script is in when it starts, and a crowded temp directory can cost it the whole
// test's readiness budget (flyingrobots/school#215).
console.log("still opening the record");
console.error("a warning on stderr");
setInterval(() => {}, 1000);
