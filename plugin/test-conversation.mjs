#!/usr/bin/env node
/**
 * P2P Conversation Test — Two agents chat via Nostr using Ollama.
 *
 * Prerequisites:
 *   - Ollama running on localhost:11434
 *   - nostr-tools installed (cd ../plugin && npm install)
 *
 * Usage: node test-conversation.mjs
 *   (run from the docker/ directory, or set NODE_PATH=../plugin/node_modules)
 */

import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import * as nip04 from "nostr-tools/nip04";
import http from "node:http";
import crypto from "node:crypto";

const RELAYS = process.env.P2P_NOSTR_RELAYS
  ? process.env.P2P_NOSTR_RELAYS.split(",").map((s) => s.trim())
  : ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"];
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const MAX_ROUNDS = parseInt(process.env.MAX_ROUNDS || "4", 10);

const DM_KIND = 4;

// ── Ollama Chat ──────────────────────────────────────────────────────────────

function chatOllama(system, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: system }, ...messages],
      stream: false,
    });
    const url = new URL(OLLAMA_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 120_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve(data.message?.content ?? "(no response)");
          } catch (e) {
            reject(new Error("Ollama JSON parse error"));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama timeout"));
    });
    req.end(body);
  });
}

// ── Agent ────────────────────────────────────────────────────────────────────

function createAgent(agentId, name, capabilities, systemPrompt) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const pool = new SimplePool();

  const history = [];
  let roomId = null;
  let onMessage = null;
  let onCallAccepted = null;
  let onIncomingCall = null;
  let onCallEnded = null;
  let onFile = null;
  let dmSub = null;
  let messageCount = 0;
  const receivedFiles = [];

  function subscribeDMs() {
    dmSub = pool.subscribeMany(
      RELAYS,
      {
        kinds: [DM_KIND],
        "#p": [pk],
        since: Math.floor(Date.now() / 1000) - 10,
      },
      {
        onevent: async (event) => {
          try {
            const plaintext = await nip04.decrypt(
              sk,
              event.pubkey,
              event.content,
            );
            const msg = JSON.parse(plaintext);
            if (!msg.type || !msg.roomId) return;

            switch (msg.type) {
              case "call_request":
                console.log(
                  `[${name}] 📞 Incoming call from ${msg.agentName}: "${msg.topic}"`,
                );
                roomId = msg.roomId;
                if (onIncomingCall) onIncomingCall(msg);
                break;
              case "call_accepted":
                console.log(`[${name}] ✅ Call accepted by ${msg.agentName}`);
                roomId = msg.roomId;
                if (onCallAccepted) onCallAccepted(msg);
                break;
              case "room_message":
                console.log(`[${name}] 💬 ${msg.sender}: ${msg.content}`);
                history.push({ role: "user", content: msg.content });
                messageCount++;
                if (onMessage) onMessage(msg);
                break;
              case "room_file":
                console.log(
                  `[${name}] 📎 File from ${msg.sender}: ${msg.filename} (${msg.mimeType})`,
                );
                receivedFiles.push({
                  filename: msg.filename,
                  content: msg.content,
                  mimeType: msg.mimeType,
                  sender: msg.sender,
                });
                if (onFile) onFile(msg);
                break;
              case "end_call":
                console.log(
                  `[${name}] 📴 Call ended: ${msg.reason} (${messageCount} messages)`,
                );
                if (onCallEnded) onCallEnded(msg);
                break;
            }
          } catch {
            // Not for us or corrupted
          }
        },
      },
    );
  }

  async function sendDM(recipientPk, payload) {
    const plaintext = JSON.stringify(payload);
    const ciphertext = await nip04.encrypt(sk, recipientPk, plaintext);
    const event = finalizeEvent(
      {
        kind: DM_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", recipientPk]],
        content: ciphertext,
      },
      sk,
    );
    await Promise.any(pool.publish(RELAYS, event));
  }

  async function call(targetPk, topic) {
    roomId = crypto.randomUUID();
    await sendDM(targetPk, {
      type: "call_request",
      roomId,
      agentId,
      agentName: name,
      topic,
    });
    console.log(`[${name}] Calling... room=${roomId}`);
  }

  async function accept(callerPk, incomingRoomId) {
    await sendDM(callerPk, {
      type: "call_accepted",
      roomId: incomingRoomId,
      agentId,
      agentName: name,
    });
    roomId = incomingRoomId;
    console.log(`[${name}] Accepted call`);
  }

  async function sendMessage(peerPk, content) {
    await sendDM(peerPk, {
      type: "room_message",
      roomId,
      sender: name,
      content,
    });
    history.push({ role: "assistant", content });
    messageCount++;
  }

  async function sendFile(peerPk, filename, content, mimeType) {
    await sendDM(peerPk, {
      type: "room_file",
      roomId,
      sender: name,
      filename,
      content,
      mimeType,
    });
    console.log(`[${name}] 📎 Sent file: ${filename}`);
  }

  async function generateAndSend(peerPk) {
    const reply = await chatOllama(systemPrompt, history);
    const trimmed = reply.trim().substring(0, 500);
    console.log(`[${name}] 🤖 ${trimmed}`);
    await sendMessage(peerPk, trimmed);
    return trimmed;
  }

  async function endCall(peerPk) {
    await sendDM(peerPk, {
      type: "end_call",
      roomId,
      reason: "ended_by_peer",
    });
    console.log(`[${name}] Ended call. ${messageCount} messages`);
    return { messageCount };
  }

  function waitFor(eventSetter) {
    return new Promise((resolve) => {
      eventSetter(resolve);
    });
  }

  function disconnect() {
    if (dmSub) dmSub.close();
    pool.close(RELAYS);
  }

  return {
    name,
    pk,
    subscribeDMs,
    call,
    accept,
    sendMessage,
    sendFile,
    generateAndSend,
    endCall,
    disconnect,
    history,
    receivedFiles,
    get roomId() {
      return roomId;
    },
    get messageCount() {
      return messageCount;
    },
    set onMessage(fn) {
      onMessage = fn;
    },
    set onCallAccepted(fn) {
      onCallAccepted = fn;
    },
    set onIncomingCall(fn) {
      onIncomingCall = fn;
    },
    set onCallEnded(fn) {
      onCallEnded = fn;
    },
    set onFile(fn) {
      onFile = fn;
    },
    waitForMessage: () =>
      waitFor((r) => {
        onMessage = r;
      }),
    waitForAccepted: () =>
      waitFor((r) => {
        onCallAccepted = r;
      }),
    waitForIncoming: () =>
      waitFor((r) => {
        onIncomingCall = r;
      }),
    waitForEnded: () =>
      waitFor((r) => {
        onCallEnded = r;
      }),
    waitForFile: () =>
      waitFor((r) => {
        onFile = r;
      }),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(51));
  console.log("  P2P Agent Conversation Test (Nostr + Ollama)");
  console.log("═".repeat(51) + "\n");
  console.log(`Relays: ${RELAYS.join(", ")}`);
  console.log(`Model: ${MODEL}\n`);

  const alice = createAgent(
    "alice-test",
    "Alice",
    ["research", "analysis"],
    "You are Alice, a curious AI researcher. You're having a short conversation with Bob about building multi-agent systems. Keep replies concise (2-3 sentences). Be friendly and ask follow-up questions.",
  );

  const bob = createAgent(
    "bob-test",
    "Bob",
    ["coding", "devops"],
    "You are Bob, a pragmatic software engineer. You're having a short conversation with Alice about building multi-agent systems. Keep replies concise (2-3 sentences). Be practical and share concrete examples.",
  );

  try {
    // Subscribe to DMs before anything else
    alice.subscribeDMs();
    bob.subscribeDMs();
    console.log("[Setup] Subscribed to DMs, waiting for relay connections...");
    await new Promise((r) => setTimeout(r, 3000));

    // Alice calls Bob via encrypted DM
    const topic = "How should we design communication between AI agents?";
    const incomingPromise = bob.waitForIncoming();
    await alice.call(bob.pk, topic);
    console.log("[Setup] Waiting for Bob to receive the call...");
    const incomingData = await Promise.race([
      incomingPromise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timeout waiting for incoming call (30s). Relays may be slow.")), 30_000),
      ),
    ]);

    // Bob accepts
    const acceptedPromise = alice.waitForAccepted();
    await bob.accept(alice.pk, incomingData.roomId);
    await Promise.race([
      acceptedPromise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timeout waiting for call acceptance (30s).")), 30_000),
      ),
    ]);

    console.log("\n" + "─".repeat(51));
    console.log("  Conversation started! Topic:", topic);
    console.log("─".repeat(51) + "\n");

    // Seed Alice's history so she starts the conversation
    alice.history.push({
      role: "user",
      content: `The topic is: "${topic}". Start the discussion with your opening thoughts.`,
    });

    // Conversation loop
    for (let round = 0; round < MAX_ROUNDS; round++) {
      console.log(`\n── Round ${round + 1}/${MAX_ROUNDS} ──\n`);

      const bobReceive = bob.waitForMessage();
      await alice.generateAndSend(bob.pk);
      await Promise.race([
        bobReceive,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`Timeout: Bob didn't receive Alice's message (round ${round + 1})`)), 30_000),
        ),
      ]);

      const aliceReceive = alice.waitForMessage();
      await bob.generateAndSend(alice.pk);
      await Promise.race([
        aliceReceive,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`Timeout: Alice didn't receive Bob's message (round ${round + 1})`)), 30_000),
        ),
      ]);
    }

    // ── File transfer test ──
    console.log("\n" + "─".repeat(51));
    console.log("  Testing file transfer...");
    console.log("─".repeat(51) + "\n");

    const testFile = {
      filename: "test-data.json",
      content: Buffer.from(JSON.stringify({ hello: "world", agents: ["alice", "bob"] })).toString("base64"),
      mimeType: "application/json",
    };

    const bobFilePromise = bob.waitForFile();
    await alice.sendFile(bob.pk, testFile.filename, testFile.content, testFile.mimeType);
    const receivedFileMsg = await Promise.race([
      bobFilePromise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timeout: Bob didn't receive file (30s)")), 30_000),
      ),
    ]);

    // Verify file was received correctly
    const received = bob.receivedFiles[bob.receivedFiles.length - 1];
    if (received.filename !== testFile.filename) {
      throw new Error(`File name mismatch: got "${received.filename}", expected "${testFile.filename}"`);
    }
    if (received.content !== testFile.content) {
      throw new Error("File content mismatch");
    }
    if (received.mimeType !== testFile.mimeType) {
      throw new Error(`MIME type mismatch: got "${received.mimeType}", expected "${testFile.mimeType}"`);
    }
    console.log("✅ File transfer verified: filename, content, and MIME type match");

    // Also test Bob sending a file back to Alice
    const aliceFilePromise = alice.waitForFile();
    const replyFile = {
      filename: "reply.txt",
      content: Buffer.from("Got your file, thanks!").toString("base64"),
      mimeType: "text/plain",
    };
    await bob.sendFile(alice.pk, replyFile.filename, replyFile.content, replyFile.mimeType);
    await Promise.race([
      aliceFilePromise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timeout: Alice didn't receive reply file (30s)")), 30_000),
      ),
    ]);

    const aliceReceived = alice.receivedFiles[alice.receivedFiles.length - 1];
    if (aliceReceived.filename !== replyFile.filename) {
      throw new Error(`Reply file name mismatch: got "${aliceReceived.filename}"`);
    }
    console.log("✅ Bidirectional file transfer verified");

    // End call
    console.log("\n" + "─".repeat(51));
    console.log("  Conversation complete! Ending call...");
    console.log("─".repeat(51) + "\n");

    const bobEnded = bob.waitForEnded();
    const result = await alice.endCall(bob.pk);
    await Promise.race([
      bobEnded,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timeout waiting for call end acknowledgment")), 15_000),
      ),
    ]);

    console.log(`\n📋 Transcript: ${result.messageCount} messages`);
    console.log(`📎 Files transferred: ${alice.receivedFiles.length + bob.receivedFiles.length}`);
    console.log("\n✅ Test passed!");
  } catch (err) {
    console.error("\n❌ Test failed:", err.message);
    process.exitCode = 1;
  } finally {
    alice.disconnect();
    bob.disconnect();
    // Give pool time to close cleanly
    setTimeout(() => process.exit(process.exitCode ?? 0), 1000);
  }
}

main();
