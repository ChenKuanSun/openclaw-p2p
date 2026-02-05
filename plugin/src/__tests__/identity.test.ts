import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadOrCreateIdentity } from "../identity.js";
import { getPublicKey } from "nostr-tools/pure";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("identity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new identity when none exists", () => {
    const identity = loadOrCreateIdentity(tmpDir);

    expect(identity.privateKey).toBeInstanceOf(Uint8Array);
    expect(identity.privateKey.length).toBe(32);
    expect(identity.publicKey).toHaveLength(64);
    // Verify key pair consistency
    expect(getPublicKey(identity.privateKey)).toBe(identity.publicKey);
  });

  it("persists identity to file", () => {
    loadOrCreateIdentity(tmpDir);

    const filePath = path.join(tmpDir, "p2p-identity.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(stored.privateKeyHex).toHaveLength(64);
    expect(stored.publicKey).toHaveLength(64);
  });

  it("loads existing identity on subsequent calls", () => {
    const first = loadOrCreateIdentity(tmpDir);
    const second = loadOrCreateIdentity(tmpDir);

    expect(second.publicKey).toBe(first.publicKey);
    expect(Array.from(second.privateKey)).toEqual(Array.from(first.privateKey));
  });

  it("regenerates identity if file is corrupted JSON", () => {
    const filePath = path.join(tmpDir, "p2p-identity.json");
    fs.writeFileSync(filePath, "not-json-at-all");

    const identity = loadOrCreateIdentity(tmpDir);
    expect(identity.publicKey).toHaveLength(64);
    expect(getPublicKey(identity.privateKey)).toBe(identity.publicKey);
  });

  it("regenerates identity if privateKeyHex is wrong length", () => {
    const filePath = path.join(tmpDir, "p2p-identity.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ privateKeyHex: "abcd", publicKey: "x".repeat(64) }),
    );

    const identity = loadOrCreateIdentity(tmpDir);
    expect(identity.publicKey).toHaveLength(64);
    expect(getPublicKey(identity.privateKey)).toBe(identity.publicKey);
  });

  it("regenerates identity if public key doesn't match private key", () => {
    const filePath = path.join(tmpDir, "p2p-identity.json");
    // Valid-length hex but mismatched public key
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        privateKeyHex: "aa".repeat(32),
        publicKey: "bb".repeat(32),
      }),
    );

    const identity = loadOrCreateIdentity(tmpDir);
    expect(getPublicKey(identity.privateKey)).toBe(identity.publicKey);
  });

  it("creates the config directory if it doesn't exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "dir");
    const identity = loadOrCreateIdentity(nestedDir);

    expect(fs.existsSync(nestedDir)).toBe(true);
    expect(identity.publicKey).toHaveLength(64);
  });

  it("throws on filesystem read error instead of regenerating", () => {
    const filePath = path.join(tmpDir, "p2p-identity.json");
    // Create a valid file first, then make it unreadable
    fs.writeFileSync(filePath, "valid content");
    fs.chmodSync(filePath, 0o000);

    try {
      expect(() => loadOrCreateIdentity(tmpDir)).toThrow(/Cannot read identity file/);
    } finally {
      // Restore permissions so afterEach cleanup works
      fs.chmodSync(filePath, 0o644);
    }
  });
});
