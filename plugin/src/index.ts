import http from "node:http";
import type { P2PConfig, AgentInfo } from "./types.js";
import { NostrClient } from "./nostr-client.js";

const DEFAULT_IPC_PORT = 18799;
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`FATAL: Required environment variable ${key} is not set.`);
    process.exit(1);
  }
  return val;
}

export function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    console.error(`FATAL: Environment variable ${key}=${raw} is not a valid integer.`);
    process.exit(1);
  }
  return parsed;
}

export function loadConfig(): P2PConfig {
  const agentId = requireEnv("P2P_AGENT_ID");
  const relayEnv = process.env.P2P_NOSTR_RELAYS;
  const nostrRelays = relayEnv
    ? relayEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  return {
    agentId,
    agentName: process.env.P2P_AGENT_NAME,
    capabilities: process.env.P2P_CAPABILITIES?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ownerChannel: process.env.P2P_OWNER_CHANNEL,
    ipcPort: intEnv("P2P_IPC_PORT", DEFAULT_IPC_PORT),
    nostrRelays,
    identityPath: process.env.P2P_IDENTITY_PATH,
  };
}

// ---------------------------------------------------------------------------
// Service mode: Nostr connection + local HTTP IPC
// ---------------------------------------------------------------------------

async function runService(config: P2PConfig): Promise<void> {
  const client = new NostrClient(config);
  client.connect();

  const ipcPort = config.ipcPort ?? DEFAULT_IPC_PORT;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end("Method not allowed");
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "read error";
      res.writeHead(400).end(JSON.stringify({ error: msg }));
      return;
    }

    let parsed: { command: string; args: Record<string, unknown> };
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      const detail = err instanceof SyntaxError ? err.message : "parse error";
      res.writeHead(400).end(JSON.stringify({ error: `invalid JSON: ${detail}` }));
      return;
    }

    try {
      const result = await handleCommand(
        client,
        config,
        parsed.command,
        parsed.args ?? {},
      );
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      console.error(`[p2p] Command "${parsed.command}" failed:`, err);
      res.writeHead(500).end(JSON.stringify({ error: msg }));
    }
  });

  server.listen(ipcPort, "127.0.0.1", () => {
    console.log(`[p2p] IPC server on 127.0.0.1:${ipcPort}`);
  });

  console.log(
    `[p2p] Service started. Agent: ${config.agentId}, Pubkey: ${client.publicKey.substring(0, 12)}...`,
  );

  process.on("SIGINT", () => shutdown(client, server));
  process.on("SIGTERM", () => shutdown(client, server));

  await new Promise(() => {}); // Block forever
}

function shutdown(client: NostrClient, server: http.Server): void {
  console.log("[p2p] Shutting down...");
  client.disconnect();
  server.close(() => {
    console.log("[p2p] HTTP server closed.");
    process.exit(0);
  });
  // Force exit after 5s if server.close hangs
  setTimeout(() => process.exit(0), 5_000).unref();
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", (err) =>
      reject(new Error(`failed to read request body: ${err.message}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// Command handler (shared between IPC and direct CLI)
// ---------------------------------------------------------------------------

export async function handleCommand(
  client: NostrClient,
  config: P2PConfig,
  command: string,
  args: Record<string, unknown>,
): Promise<{ content: string }> {
  switch (command) {
    case "status": {
      const state = client.state.toJSON();
      state.connected = client.connected;
      const lines = [
        `Connected: ${state.connected}`,
        `Pubkey: ${client.publicKey.substring(0, 16)}...`,
        `Active call: ${state.activeCall ? JSON.stringify(state.activeCall) : "none"}`,
        `Pending incoming: ${state.pendingIncoming ? JSON.stringify(state.pendingIncoming) : "none"}`,
      ];
      return { content: lines.join("\n") };
    }

    case "list": {
      if (!client.connected) throw new Error("Not connected to Nostr relays.");
      const agents = await client.listAgents();
      if (agents.length === 0) return { content: "No agents currently online." };
      const lines = agents.map(
        (a: AgentInfo) =>
          `- ${a.name} (${a.agentId}) — capabilities: ${a.capabilities.length > 0 ? a.capabilities.join(", ") : "none"} [${a.pubkey.substring(0, 12)}...]`,
      );
      return { content: `Online agents:\n${lines.join("\n")}` };
    }

    case "call": {
      if (!client.connected) throw new Error("Not connected to Nostr relays.");
      const targetId = args.targetAgentId as string;
      if (!targetId) throw new Error("targetAgentId required.");

      // Look up target's pubkey from discovery cache
      const targetPubkey = client.lookupAgentPubkey(targetId);
      if (!targetPubkey) {
        // Try a fresh query
        await client.listAgents();
        const retryPubkey = client.lookupAgentPubkey(targetId);
        if (!retryPubkey)
          throw new Error(
            `Agent "${targetId}" not found. Run "list" first to discover agents.`,
          );
        return await initiateCall(client, config, targetId, retryPubkey, args);
      }
      return await initiateCall(client, config, targetId, targetPubkey, args);
    }

    case "answer": {
      const incoming = client.state.pendingIncoming;
      if (!incoming) return { content: "No pending incoming call to answer." };
      const accept = args.accept as boolean;
      if (accept) {
        await client.sendCallAccepted(incoming.callerPubkey, incoming.roomId);
        client.state.acceptCall(
          incoming.roomId,
          incoming.callerId,
          incoming.callerName,
          incoming.callerPubkey,
          "callee",
        );
        return {
          content: `Call accepted. In call with ${incoming.callerName} (${incoming.callerId}). Room: ${incoming.roomId}`,
        };
      }
      await client.sendCallRejected(
        incoming.callerPubkey,
        incoming.roomId,
        args.reason as string | undefined,
      );
      client.state.rejectCall();
      return { content: `Call from ${incoming.callerName} rejected.` };
    }

    case "send": {
      const call = client.state.activeCall;
      if (!call) throw new Error("No active call.");
      const content = args.content as string;
      if (!content) throw new Error("Message content required.");
      await client.sendRoomMessage(call.peerPubkey, call.roomId, content);
      return { content: `Message sent to ${call.peerName}.` };
    }

    case "sendfile": {
      const call = client.state.activeCall;
      if (!call) throw new Error("No active call.");
      const filename = args.filename as string;
      const fileContent = args.content as string;
      if (!filename || !fileContent) throw new Error("filename and content required.");
      await client.sendRoomFile(
        call.peerPubkey,
        call.roomId,
        filename,
        fileContent,
        (args.mimeType as string) ?? "application/octet-stream",
      );
      return { content: `File "${filename}" sent to ${call.peerName}.` };
    }

    case "escalate": {
      const call = client.state.activeCall;
      if (!call) throw new Error("No active call.");
      const message = args.message as string;
      if (!message) throw new Error("message required.");
      await client.sendEscalation(call.peerPubkey, call.roomId, message);
      return { content: `Escalation sent: "${message}"` };
    }

    case "end": {
      const call = client.state.activeCall;
      if (!call) return { content: "No active call to end." };
      const transcript = client.state.buildTranscript(config.agentId);
      if (!transcript) throw new Error("Cannot build transcript: no active call");
      await client.sendEndCall(call.peerPubkey, call.roomId);
      client.state.endCall({
        roomId: call.roomId,
        reason: "ended_by_self",
        transcript,
      });
      return {
        content: `Call ended. ${transcript.messageCount} messages exchanged.`,
      };
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function initiateCall(
  client: NostrClient,
  _config: P2PConfig,
  targetId: string,
  targetPubkey: string,
  args: Record<string, unknown>,
): Promise<{ content: string }> {
  const roomId = client.generateRoomId();
  const topic = (args.topic as string) ?? "";
  await client.sendCallRequest(targetPubkey, roomId, topic);
  client.state.setPendingOutgoing(roomId);
  client.startCallTimeout(roomId);
  return {
    content: `Call request sent to ${targetId}. Room: ${roomId}. Waiting for acceptance...`,
  };
}

// ---------------------------------------------------------------------------
// CLI mode: sends command to the IPC server
// ---------------------------------------------------------------------------

function sendToService(
  ipcPort: number,
  command: string,
  args: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command, args });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: ipcPort,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 25_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          const statusOk =
            res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
          try {
            const data = JSON.parse(text);
            if (!statusOk) {
              reject(new Error(data.error ?? `IPC returned status ${res.statusCode}`));
              return;
            }
            resolve(data.content ?? text);
          } catch {
            if (!statusOk) {
              reject(new Error(`IPC returned status ${res.statusCode}: ${text}`));
              return;
            }
            console.warn("[p2p] IPC response was not valid JSON");
            resolve(text);
          }
        });
      },
    );
    req.on("error", (err) =>
      reject(
        new Error(`Cannot connect to P2P service on port ${ipcPort}: ${err.message}`),
      ),
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("IPC request timed out"));
    });
    req.end(body);
  });
}

export function parseCLIArgs(argv: string[]): {
  command: string;
  args: Record<string, unknown>;
} {
  const [command, ...rest] = argv;
  switch (command) {
    case "call":
      if (!rest[0]) {
        console.error("Usage: call <targetAgentId> [topic]");
        process.exit(1);
      }
      return { command, args: { targetAgentId: rest[0], topic: rest[1] } };
    case "answer":
      if (!rest[0] || (rest[0] !== "accept" && rest[0] !== "reject")) {
        console.error("Usage: answer <accept|reject> [reason]");
        process.exit(1);
      }
      return {
        command,
        args: { accept: rest[0] === "accept", reason: rest[1] },
      };
    case "send":
      if (!rest[0]) {
        console.error("Usage: send <message>");
        process.exit(1);
      }
      return { command, args: { content: rest.join(" ") } };
    case "sendfile":
      if (!rest[0] || !rest[1]) {
        console.error("Usage: sendfile <filename> <base64content> [mimeType]");
        process.exit(1);
      }
      return {
        command,
        args: { filename: rest[0], content: rest[1], mimeType: rest[2] },
      };
    case "escalate":
      if (!rest[0]) {
        console.error("Usage: escalate <message>");
        process.exit(1);
      }
      return { command, args: { message: rest.join(" ") } };
    default:
      return { command: command ?? "status", args: {} };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const [command] = process.argv.slice(2);

  if (!command || command === "service") {
    await runService(config);
    return;
  }

  // CLI mode: forward to the background service via IPC
  const ipcPort = config.ipcPort ?? DEFAULT_IPC_PORT;
  const { command: cmd, args } = parseCLIArgs(process.argv.slice(2));
  try {
    const result = await sendToService(ipcPort, cmd, args);
    console.log(result);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Only run main when executed directly (not when imported for testing)
const isDirectExecution =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
