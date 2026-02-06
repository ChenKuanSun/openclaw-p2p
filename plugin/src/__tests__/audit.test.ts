import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AuditLogger } from "../audit.js";
import type { AuditLogEntry } from "../types.js";

describe("AuditLogger", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
    logPath = path.join(tmpDir, "audit.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates log file on first write", () => {
    const logger = new AuditLogger(logPath);
    const entry: AuditLogEntry = {
      ts: 1700000000000,
      dir: "in",
      peer: "abc123",
      room: "room-1",
      type: "room_message",
      content: "hello",
    };
    logger.log(entry);
    logger.close();

    expect(fs.existsSync(logPath)).toBe(true);
    const raw = fs.readFileSync(logPath, "utf-8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.ts).toBe(1700000000000);
    expect(parsed.dir).toBe("in");
    expect(parsed.content).toBe("hello");
  });

  it("appends multiple entries as JSONL", () => {
    const logger = new AuditLogger(logPath);
    logger.log({
      ts: 1,
      dir: "in",
      peer: "a",
      room: "r1",
      type: "room_message",
      content: "one",
    });
    logger.log({
      ts: 2,
      dir: "out",
      peer: "b",
      room: "r1",
      type: "room_message",
      content: "two",
    });
    logger.log({
      ts: 3,
      dir: "in",
      peer: "a",
      room: "r1",
      type: "end_call",
      content: "",
    });
    logger.close();

    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).content).toBe("one");
    expect(JSON.parse(lines[1]).dir).toBe("out");
    expect(JSON.parse(lines[2]).type).toBe("end_call");
  });

  it("creates parent directories if missing", () => {
    const deepPath = path.join(tmpDir, "deep", "nested", "audit.jsonl");
    const logger = new AuditLogger(deepPath);
    logger.log({ ts: 1, dir: "in", peer: "a", room: "r", type: "test", content: "" });
    logger.close();

    expect(fs.existsSync(deepPath)).toBe(true);
  });

  it("sets restrictive file permissions (0o600)", () => {
    const logger = new AuditLogger(logPath);
    logger.log({ ts: 1, dir: "in", peer: "a", room: "r", type: "test", content: "" });
    logger.close();

    const stats = fs.statSync(logPath);
    // 0o600 = owner rw only
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("close is safe to call multiple times", () => {
    const logger = new AuditLogger(logPath);
    logger.log({ ts: 1, dir: "in", peer: "a", room: "r", type: "test", content: "" });
    logger.close();
    logger.close(); // Should not throw
  });

  it("does not log content longer than what is provided", () => {
    const logger = new AuditLogger(logPath);
    const longContent = "x".repeat(1000);
    logger.log({
      ts: 1,
      dir: "in",
      peer: "a",
      room: "r",
      type: "test",
      content: longContent,
    });
    logger.close();

    const raw = fs.readFileSync(logPath, "utf-8").trim();
    const parsed = JSON.parse(raw);
    expect(parsed.content).toBe(longContent);
  });
});
