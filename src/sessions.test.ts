import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  createSession,
  getSession,
  killSession,
  listSessions,
  readTranscript,
  killSessionsByFilter,
  isSessionStatus,
} from "./sessions";

const tempDirs: string[] = [];

async function tmpCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const session of listSessions()) {
    killSession(session.id);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("sessions", () => {
  test("defaults to direct exec mode and runs task through a shell", async () => {
    const cwd = await tmpCwd();
    const session = createSession({
      task: "printf 'direct-exec:%s' \"$PWD\"",
      cwd,
    });

    expect(session.type).toBe("exec");
    expect(session.command).toContain("/bin/sh -lc");

    for (let i = 0; i < 40; i++) {
      const transcript = await readTranscript(session.id);
      if (transcript?.text.includes("direct-exec:")) break;
      await Bun.sleep(25);
    }

    const detail = await getSession(session.id);
    const transcript = await readTranscript(session.id);
    expect(detail?.status).toBe("exited");
    expect(detail?.exitCode).toBe(0);
    expect(transcript?.text).toContain(`direct-exec:${cwd}`);
  });

  test("explicit print mode keeps agent-style task argument behavior", async () => {
    const cwd = await tmpCwd();
    const session = createSession({
      type: "print",
      task: "print-task-arg",
      cwd,
      command: "bun",
      args: ["--eval", "console.log(process.argv.at(-1))"],
    });

    expect(session.type).toBe("print");
    expect(session.command).toBe("bun --eval console.log(process.argv.at(-1))");

    for (let i = 0; i < 40; i++) {
      const transcript = await readTranscript(session.id);
      if (transcript?.text.includes("print-task-arg")) break;
      await Bun.sleep(25);
    }

    expect((await readTranscript(session.id))?.text).toContain("print-task-arg");
  });

  test("persists owner and labels and supports filters", async () => {
    const cwd = await tmpCwd();
    const session = createSession({
      task: "hello",
      cwd,
      command: "bun",
      args: ["--eval", "console.log('hello')"],
      owner: "bilby",
      labels: [" Maintenance ", "MP", "mp"],
    });

    await Bun.sleep(50);

    expect(session.owner).toBe("bilby");
    expect(session.labels).toEqual(["maintenance", "mp"]);
    expect(listSessions({ owner: "bilby" }).map((s) => s.id)).toContain(session.id);
    expect(listSessions({ label: "maintenance" }).map((s) => s.id)).toContain(session.id);

    for (let i = 0; i < 40; i++) {
      const detail = await getSession(session.id);
      if (detail?.status === "exited") break;
      await Bun.sleep(25);
    }
    expect(listSessions({ status: "exited" }).map((s) => s.id)).toContain(session.id);
  });

  test("validates session status query values", () => {
    expect(isSessionStatus("running")).toBe(true);
    expect(isSessionStatus("exited")).toBe(true);
    expect(isSessionStatus("killed")).toBe(true);
    expect(isSessionStatus("bogus")).toBe(false);
  });

  test("refuses empty-filter bulk kill", async () => {
    const cwd = await tmpCwd();
    const session = createSession({
      task: "long",
      cwd,
      command: "bun",
      args: ["--eval", "setTimeout(() => {}, 10000)"],
    });

    expect(killSessionsByFilter({})).toBe(0);
    await expect(getSession(session.id)).resolves.toMatchObject({ status: "running" });
  });

  test("uses byte offsets for transcript polling", async () => {
    const cwd = await tmpCwd();
    const session = createSession({
      task: "utf8",
      cwd,
      command: "bun",
      args: ["--eval", "console.log('éclair')"],
    });

    for (let i = 0; i < 40; i++) {
      const transcript = await readTranscript(session.id);
      if (transcript?.text.includes("éclair")) break;
      await Bun.sleep(25);
    }

    const full = await readTranscript(session.id);
    expect(full).not.toBeNull();
    expect(full!.text).toContain("éclair");
    expect(full!.totalSize).toBe(new TextEncoder().encode(full!.text).byteLength);

    const marker = full!.text.indexOf("éclair");
    const byteOffset = new TextEncoder().encode(full!.text.slice(0, marker)).byteLength;
    const partial = await readTranscript(session.id, byteOffset);
    expect(partial).not.toBeNull();
    expect(partial!.offset).toBe(byteOffset);
    expect(partial!.text).toStartWith("éclair");
  });

  test("normalizes relative cwd and keeps transcript under cwd/.session", async () => {
    const cwd = await tmpCwd();
    const relativeCwd = cwd.replace(`${process.cwd()}/`, "");
    const session = createSession({ task: "pwd", cwd: relativeCwd, command: "bun", args: ["--eval", "console.log('ok')"] });
    const detail = await getSession(session.id);

    expect(detail?.cwd).toStartWith("/");
    expect(detail?.transcriptPath).toStartWith(`${detail?.cwd}/.session/`);
  });

  test("empty bulk-kill filter is a no-op", async () => {
    const cwd = await tmpCwd();
    const session = createSession({
      task: "long",
      cwd,
      command: "bun",
      args: ["--eval", "setTimeout(() => {}, 2000)"],
    });

    expect(killSessionsByFilter({})).toBe(0);
    expect((await getSession(session.id))?.status).toBe("running");
  });

  test("validates known session statuses", () => {
    expect(isSessionStatus("running")).toBe(true);
    expect(isSessionStatus("exited")).toBe(true);
    expect(isSessionStatus("killed")).toBe(true);
    expect(isSessionStatus("wat")).toBe(false);
  });
});
