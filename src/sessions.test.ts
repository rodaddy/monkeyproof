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
  test("persists owner and labels and supports filters", async () => {
    const cwd = await tmpCwd();
    const session = createSession({
      task: "hello",
      cwd,
      command: "bun",
      args: ["--eval", "console.log('hello')"],
      owner: "bilby",
      labels: ["maintenance", "mp"],
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
});
