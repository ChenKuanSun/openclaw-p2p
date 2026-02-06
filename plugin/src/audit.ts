// Audit logging for P2P communications
// Suggested by @ShinyTamatoa — allows human operators to review
// decrypted messages locally for compliance and debugging.

import fs from "node:fs";
import path from "node:path";
import type { AuditLogEntry } from "./types.js";

const DEFAULT_AUDIT_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".openclaw",
  "p2p-audit.jsonl",
);

export class AuditLogger {
  private fd: number | null = null;
  private filePath: string;

  constructor(logPath?: string) {
    this.filePath = logPath ?? DEFAULT_AUDIT_PATH;
  }

  private ensureOpen(): void {
    if (this.fd !== null) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(this.filePath, "a", 0o600);
  }

  log(entry: AuditLogEntry): void {
    this.ensureOpen();
    const line = JSON.stringify(entry) + "\n";
    fs.writeSync(this.fd!, line);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
