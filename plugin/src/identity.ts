import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import fs from "node:fs";
import path from "node:path";
import type { NostrIdentity } from "./types.js";

const DEFAULT_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".openclaw",
);
const IDENTITY_FILE = "p2p-identity.json";

interface StoredIdentity {
  privateKeyHex: string;
  publicKey: string;
}

export function loadOrCreateIdentity(configDir?: string): NostrIdentity {
  const dir = configDir ?? DEFAULT_DIR;
  const filePath = path.join(dir, IDENTITY_FILE);

  if (fs.existsSync(filePath)) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      // Filesystem error (permissions, etc) — don't silently regenerate
      throw new Error(`Cannot read identity file ${filePath}: ${(err as Error).message}`);
    }
    try {
      const stored: StoredIdentity = JSON.parse(raw);
      if (
        typeof stored.privateKeyHex !== "string" ||
        stored.privateKeyHex.length !== 64 ||
        typeof stored.publicKey !== "string" ||
        stored.publicKey.length !== 64
      ) {
        throw new Error("invalid identity format");
      }
      const privateKey = hexToBytes(stored.privateKeyHex);
      // Verify key pair consistency
      const derivedPub = getPublicKey(privateKey);
      if (derivedPub !== stored.publicKey) {
        throw new Error("public key does not match private key");
      }
      console.log(`[p2p] Loaded identity: ${stored.publicKey.substring(0, 12)}...`);
      return { privateKey, publicKey: stored.publicKey };
    } catch (err) {
      console.error(
        `[p2p] Corrupted identity file, regenerating: ${err instanceof Error ? err.message : err}`,
      );
      // Back up corrupted file before overwriting
      const backupPath = `${filePath}.bak`;
      try {
        fs.renameSync(filePath, backupPath);
        console.warn(`[p2p] Corrupted identity backed up to ${backupPath}`);
      } catch {
        // Best-effort backup — proceed even if rename fails
      }
    }
  }

  const privateKey = generateSecretKey();
  const publicKey = getPublicKey(privateKey);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const stored: StoredIdentity = {
    privateKeyHex: bytesToHex(privateKey),
    publicKey,
  };
  fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), {
    mode: 0o600,
  });

  console.log(`[p2p] Generated new identity: ${publicKey.substring(0, 12)}...`);
  return { privateKey, publicKey };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
