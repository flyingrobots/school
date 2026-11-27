// The pinned school skill (RFC 9 §5.3, flyingrobots/school#257). At start School hashes the skill it
// would give an authoring agent, with the references the skill links, into one manifest digest, or
// reports authoring off with the reason. docs/topics/architecture/test-plan.md lists these cases by ID.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoringStatus, guideManifest } from "./skill.ts";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const CHECKOUT = join(import.meta.dir, "..");

// FIPS 180-2's published SHA-256 vectors: "abc", and the empty message.
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let scratch: string;
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "school-skill-")); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh guide: a skill folder and a references folder, laid out as compose mounts them. */
function fixture(): { skill: string; docs: string } {
  const root = mkdtempSync(join(scratch, "guide-"));
  const skill = join(root, "skills", "school");
  const docs = join(root, "docs");
  mkdirSync(join(skill, "example"), { recursive: true });
  mkdirSync(join(docs, "course-format"), { recursive: true });
  mkdirSync(join(docs, "voice"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "abc");
  writeFileSync(join(skill, "example", "a.json"), "");
  writeFileSync(join(skill, "example", "Z.json"), "abc");
  writeFileSync(join(docs, "course-format", "README.md"), "abc");
  writeFileSync(join(docs, "voice", "README.md"), "");
  return { skill, docs };
}

// The manifest's definition (RFC 9 §5.3, after RFC 7 §7): one line per regular file, the SHA-256 of
// its bytes in lowercase hex, one space, its path under the agent's guide/ folder, then "\n"; sorted
// by path as UTF-8 bytes, so `Z` comes before `a`. The skill's files sit at the guide's root and the
// references under docs/. Written out by hand from the definition and the vectors above.
const FIXTURE_MANIFEST = [
  `${ABC} SKILL.md\n`,
  `${ABC} docs/course-format/README.md\n`,
  `${EMPTY} docs/voice/README.md\n`,
  `${ABC} example/Z.json\n`,
  `${EMPTY} example/a.json\n`,
].join("");

describe("the guide's manifest", () => {
  test("SKILLPIN-2: is one `<sha256> <path>` line per file under guide/, sorted by path as bytes", () => {
    const { skill, docs } = fixture();
    expect(guideManifest(skill, docs)).toBe(FIXTURE_MANIFEST);
  });

  test("SKILLPIN-3: authoring is on with the SHA-256 of the manifest's text and the number of files", () => {
    const { skill, docs } = fixture();
    expect(authoringStatus(skill, docs)).toEqual({ authoring: "on", skill: { digest: sha256(FIXTURE_MANIFEST), files: 5 } });
  });

  test("SKILLPIN-4: one changed byte in any file changes the digest", () => {
    const a = fixture();
    const b = fixture();
    writeFileSync(join(b.docs, "voice", "README.md"), "x");
    expect(authoringStatus(a.skill, a.docs)).not.toEqual(authoringStatus(b.skill, b.docs));
  });

  test("SKILLPIN-5: a renamed file changes the digest, though no byte changed", () => {
    const a = fixture();
    const b = fixture();
    rmSync(join(b.skill, "example", "a.json"));
    writeFileSync(join(b.skill, "example", "b.json"), "");
    expect(authoringStatus(a.skill, a.docs)).not.toEqual(authoringStatus(b.skill, b.docs));
  });

  test("SKILLPIN-6: a skill folder named through a symlink is hashed as the folder it names", () => {
    const { skill, docs } = fixture();
    const link = join(mkdtempSync(join(scratch, "link-")), "school");
    symlinkSync(skill, link);
    expect(authoringStatus(link, docs)).toEqual(authoringStatus(skill, docs));
  });
});

// Each way the guide can be missing or unfit. School still starts; authoring is off and says why.
describe("without the mounted skill, authoring is off with the reason", () => {
  const off = (skill: string | null, docs: string) => {
    const status = authoringStatus(skill, docs);
    if (status.authoring !== "off") throw new Error(`expected authoring off, got ${JSON.stringify(status)}`);
    return status.reason;
  };

  test("SKILLPIN-7: SCHOOL_SKILL is empty", () => {
    const { docs } = fixture();
    expect(off(null, docs)).toContain("SCHOOL_SKILL is empty");
  });

  test("SKILLPIN-8: the skill folder is not there, naming it and the folder to mount", () => {
    const { docs } = fixture();
    const missing = join(scratch, "no-such-skill");
    const reason = off(missing, docs);
    expect(reason).toContain(missing);
    expect(reason).toContain(".agents/skills/school");
  });

  test("SKILLPIN-9: the skill path is a file, not a folder", () => {
    const { docs } = fixture();
    const file = join(mkdtempSync(join(scratch, "file-")), "school");
    writeFileSync(file, "");
    expect(off(file, docs)).toContain(`${file} is not a folder`);
  });

  test("SKILLPIN-10: the skill folder holds no SKILL.md", () => {
    const { skill, docs } = fixture();
    rmSync(join(skill, "SKILL.md"));
    expect(off(skill, docs)).toContain(`${skill} has no SKILL.md`);
  });

  test.each(["course-format", "voice"])("SKILLPIN-11: the %s reference is not there, naming it and the folder to mount", (name) => {
    const { skill, docs } = fixture();
    rmSync(join(docs, name), { recursive: true });
    const reason = off(skill, docs);
    expect(reason).toContain(join(docs, name));
    expect(reason).toContain(`docs/topics/${name}`);
  });

  test.each(["skill", "docs"] as const)("SKILLPIN-12: a symlink inside the %s folder, naming it: only regular files are hashed and sent", (where) => {
    const g = fixture();
    const link = where === "skill" ? join(g.skill, "example", "link.json") : join(g.docs, "voice", "link.md");
    symlinkSync(join(g.skill, "SKILL.md"), link);
    expect(off(g.skill, g.docs)).toContain(`${link} is a symlink`);
  });
});

/**
 * The checkout's own manifest digest, by an independent pipeline: the files git tracks in the three
 * folders compose mounts, each hashed by `shasum`, their paths mapped to guide/'s, sorted by `sort`
 * in the C locale (byte order), and the whole hashed by `shasum` again.
 */
function checkoutDigest(): { digest: string; files: number } {
  const script = [
    "set -euo pipefail",
    "git ls-files -- .agents/skills/school docs/topics/course-format docs/topics/voice | while IFS= read -r f; do",
    "  h=$(shasum -a 256 \"$f\" | cut -d' ' -f1)",
    "  p=$(printf '%s' \"$f\" | sed -e 's#^\\.agents/skills/school/##' -e 's#^docs/topics/#docs/#')",
    "  printf '%s %s\\n' \"$h\" \"$p\"",
    "done | LC_ALL=C sort -k2 > \"$1\"",
    "shasum -a 256 < \"$1\" | cut -d' ' -f1",
  ].join("\n");
  const manifest = join(mkdtempSync(join(scratch, "checkout-")), "manifest");
  const run = Bun.spawnSync(["bash", "-c", script, "checkout-digest", manifest], { cwd: CHECKOUT, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`the checkout's digest pipeline failed: ${run.stderr.toString()}`);
  const lines = Bun.spawnSync(["wc", "-l"], { stdin: Bun.file(manifest), stdout: "pipe" }).stdout.toString().trim();
  return { digest: run.stdout.toString().trim(), files: Number(lines) };
}

/** The checkout's skill and references copied where server/compose.yaml mounts them under /framework. */
function mounted(): { skill: string; docs: string } {
  const framework = mkdtempSync(join(scratch, "framework-"));
  cpSync(join(CHECKOUT, ".agents", "skills", "school"), join(framework, "skills", "school"), { recursive: true });
  cpSync(join(CHECKOUT, "docs", "topics", "course-format"), join(framework, "docs", "course-format"), { recursive: true });
  cpSync(join(CHECKOUT, "docs", "topics", "voice"), join(framework, "docs", "voice"), { recursive: true });
  return { skill: join(framework, "skills", "school"), docs: join(framework, "docs") };
}

describe("a School started with the mounted skill", () => {
  let school: Started;
  beforeAll(async () => {
    const root = mkdtempSync(join(scratch, "school-"));
    mkdirSync(join(root, "course", "lessons"), { recursive: true });
    const { skill, docs } = mounted();
    school = await startSchool({
      ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_COURSES: `c=${join(root, "course")}`,
      SCHOOL_SKILL: skill, SCHOOL_SKILL_DOCS: docs,
    });
  }, timeout(1));
  afterAll(() => { school?.proc.kill(); });

  test("SKILLPIN-1: reports authoring on, with the mounted skill's digest equal to the checkout's", async () => {
    const body = await (await fetch(`${school.url}/api/settings/authoring`)).json();
    expect(body).toEqual({ authoring: "on", skill: checkoutDigest() });
  });
});

describe("a School started without the mounted skill", () => {
  let school: Started;
  let missing: string;
  beforeAll(async () => {
    const root = mkdtempSync(join(scratch, "school-"));
    mkdirSync(join(root, "course", "lessons"), { recursive: true });
    missing = join(root, "framework", "skills", "school");
    school = await startSchool({
      ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_COURSES: `c=${join(root, "course")}`,
      SCHOOL_SKILL: missing, SCHOOL_SKILL_DOCS: join(root, "framework", "docs"),
    });
  }, timeout(1));
  afterAll(() => { school?.proc.kill(); });

  test("SKILLPIN-13: still serves, and reports authoring off with the reason", async () => {
    const res = await fetch(`${school.url}/api/settings/authoring`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ authoring: "off", reason: expect.stringContaining(missing) });
  });

  test("SKILLPIN-14: says at start that authoring is off, and why", async () => {
    school.proc.kill();
    const { stdout } = await school.output();
    expect(stdout).toContain(`school: authoring off: the school skill is not at ${missing}`);
  });
});
