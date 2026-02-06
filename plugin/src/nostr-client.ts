import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { SimplePool, type SubCloser } from "nostr-tools/pool";
import * as nip04 from "nostr-tools/nip04";
import type {
  P2PConfig,
  NostrIdentity,
  AgentInfo,
  IncomingCall,
  Escalation,
} from "./types.js";
import { CallState } from "./call-state.js";
import { AgentDiscovery } from "./discovery.js";
import { loadOrCreateIdentity } from "./identity.js";
import { AuditLogger } from "./audit.js";
import { randomUUID } from "node:crypto";

const DM_KIND = 4;

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

// Protocol message types sent as NIP-04 encrypted DMs
interface ProtocolMessage {
  type:
    | "call_request"
    | "call_accepted"
    | "call_rejected"
    | "room_message"
    | "room_file"
    | "escalate"
    | "end_call";
  roomId: string;
  origin?: string; // sender agentId — Suggested by @PedroFuenmayor
  [key: string]: unknown;
}

const CALL_REQUEST_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FIELD_LENGTH = 1024; // max length for string fields like agentId, roomId

export class NostrClient {
  private pool: SimplePool;
  private identity: NostrIdentity;
  private discovery: AgentDiscovery;
  private relays: string[];
  private config: P2PConfig;
  private _connected = false;
  private dmSub: SubCloser | null = null;
  private callTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private auditLogger: AuditLogger | null = null;
  // Previous identity kept during key rotation grace period
  // Suggested by @Ki-nautilus + @ReconLobster
  private previousIdentity: NostrIdentity | null = null;
  private previousDmSub: SubCloser | null = null;
  private isRotatingKeys = false;
  readonly state: CallState;

  constructor(config: P2PConfig) {
    this.config = config;
    this.relays = config.nostrRelays ?? DEFAULT_RELAYS;
    this.pool = new SimplePool();
    this.identity = loadOrCreateIdentity(config.identityPath);
    this.state = new CallState();
    this.discovery = new AgentDiscovery(
      this.pool,
      this.relays,
      this.identity,
      config.agentId,
      config.agentName ?? config.agentId,
      config.capabilities ?? [],
    );
    // Audit mode — Suggested by @ShinyTamatoa
    if (config.auditMode) {
      this.auditLogger = new AuditLogger(config.auditLogPath);
      console.log(
        "[p2p] Audit mode enabled. Logging to:",
        config.auditLogPath ?? "~/.openclaw/p2p-audit.jsonl",
      );
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  get publicKey(): string {
    return this.identity.publicKey;
  }

  connect(): void {
    this._connected = true;
    console.log("[p2p] Connecting to Nostr relays:", this.relays.join(", "));

    // Start announcing presence
    this.discovery.startAnnouncing();

    // Subscribe to incoming DMs
    this.subscribeToDMs();

    console.log("[p2p] Connected. Listening for encrypted DMs.");
  }

  disconnect(): void {
    this.discovery.stopAnnouncing();
    this.clearCallTimeout();
    if (this.dmSub) {
      this.dmSub.close();
      this.dmSub = null;
    }
    if (this.previousDmSub) {
      this.previousDmSub.close();
      this.previousDmSub = null;
    }
    this.pool.close(this.relays);
    this._connected = false;
    this.state.clearCall();
    if (this.auditLogger) {
      this.auditLogger.close();
    }
    console.log("[p2p] Disconnected from Nostr relays.");
  }

  private subscribeToDMs(): void {
    this.dmSub = this.pool.subscribeMany(
      this.relays,
      {
        kinds: [DM_KIND],
        "#p": [this.identity.publicKey],
        since: Math.floor(Date.now() / 1000) - 10,
      },
      {
        onevent: async (event) => {
          try {
            await this.handleIncomingDM(event);
          } catch (err) {
            console.error("[p2p] Error handling DM:", err);
          }
        },
      },
    );
  }

  private async handleIncomingDM(event: {
    pubkey: string;
    content: string;
    created_at: number;
    id: string;
    kind: number;
    sig: string;
    tags: string[][];
  }): Promise<void> {
    // Verify Nostr event signature — Suggested by @KirillBorovkov
    if (!verifyEvent(event)) {
      console.warn(
        `[p2p] Rejecting DM with invalid signature from ${event.pubkey.substring(0, 12)}...`,
      );
      return;
    }

    // Reject oversized events before expensive decrypt
    if (event.content.length > MAX_MESSAGE_SIZE) {
      console.warn(`[p2p] Rejecting oversized event (${event.content.length} bytes)`);
      return;
    }

    // Try decrypting with current identity first, then previous (during rotation)
    let plaintext: string | null = null;
    try {
      plaintext = await nip04.decrypt(
        this.identity.privateKey,
        event.pubkey,
        event.content,
      );
    } catch {
      // Try previous identity if in rotation grace period
      if (this.previousIdentity) {
        try {
          plaintext = await nip04.decrypt(
            this.previousIdentity.privateKey,
            event.pubkey,
            event.content,
          );
        } catch {
          // Neither key works
        }
      }
    }

    if (!plaintext) {
      console.debug(
        `[p2p] Failed to decrypt DM from ${event.pubkey.substring(0, 12)}...`,
      );
      return;
    }

    let msg: ProtocolMessage;
    try {
      msg = JSON.parse(plaintext);
    } catch {
      console.warn(`[p2p] Received non-JSON DM from ${event.pubkey.substring(0, 12)}...`);
      return;
    }

    if (!msg.type || !msg.roomId) return;
    if (typeof msg.type !== "string" || typeof msg.roomId !== "string") return;
    if (msg.roomId.length > MAX_FIELD_LENGTH) return;

    // Audit logging — Suggested by @ShinyTamatoa
    if (this.auditLogger) {
      this.auditLogger.log({
        ts: Date.now(),
        dir: "in",
        peer: event.pubkey.substring(0, 16),
        room: msg.roomId,
        type: msg.type,
        content:
          typeof msg.content === "string"
            ? msg.content.substring(0, 500)
            : JSON.stringify(msg).substring(0, 500),
      });
    }

    switch (msg.type) {
      case "call_request":
        this.handleCallRequest(msg, event.pubkey);
        break;
      case "call_accepted":
        this.handleCallAccepted(msg, event.pubkey);
        break;
      case "call_rejected":
        this.handleCallRejected(msg);
        break;
      case "room_message":
        this.handleRoomMessage(msg, event.pubkey);
        break;
      case "room_file":
        this.handleRoomFile(msg, event.pubkey);
        break;
      case "escalate":
        this.handleEscalation(msg, event.pubkey);
        break;
      case "end_call":
        this.handleEndCall(msg, event.pubkey);
        break;
    }
  }

  private handleCallRequest(msg: ProtocolMessage, senderPubkey: string): void {
    const call: IncomingCall = {
      roomId: msg.roomId,
      callerId: msg.agentId as string,
      callerName: msg.agentName as string,
      topic: (msg.topic as string) ?? "",
      callerPubkey: senderPubkey,
    };
    console.log(
      `[p2p] Incoming call from ${call.callerName} (${call.callerId}), topic: ${call.topic}`,
    );
    this.state.setIncomingCall(call);
  }

  private handleCallAccepted(msg: ProtocolMessage, senderPubkey: string): void {
    // Verify this is for our pending outgoing call
    if (this.state.pendingOutgoing && msg.roomId !== this.state.pendingOutgoing) {
      console.warn(`[p2p] Ignoring call_accepted for unknown room ${msg.roomId}`);
      return;
    }
    const calleeId = msg.agentId as string;
    const calleeName = msg.agentName as string;
    console.log(`[p2p] Call accepted by ${calleeName}`);
    const accepted = this.state.acceptCall(
      msg.roomId,
      calleeId,
      calleeName,
      senderPubkey,
      "caller",
    );
    if (accepted) {
      this.clearCallTimeout();
    }
  }

  private handleCallRejected(msg: ProtocolMessage): void {
    console.log(`[p2p] Call rejected: ${msg.reason ?? "no reason"}`);
    this.clearCallTimeout();
    this.state.clearOutgoing();
  }

  private handleRoomMessage(msg: ProtocolMessage, senderPubkey: string): void {
    if (!this.verifyPeer(senderPubkey, "room_message")) return;
    const content = msg.content as string;
    const sender = msg.sender as string;
    const preview = content.substring(0, 100);
    console.log(`[p2p] Message from ${sender}: ${preview}`);
    this.state.addMessage({
      roomId: msg.roomId,
      sender,
      content,
      type: "text",
      timestamp: Date.now(),
    });
  }

  private handleRoomFile(msg: ProtocolMessage, senderPubkey: string): void {
    if (!this.verifyPeer(senderPubkey, "room_file")) return;
    const sender = msg.sender as string;
    const filename = msg.filename as string;
    console.log(`[p2p] File from ${sender}: ${filename}`);
    this.state.addMessage({
      roomId: msg.roomId,
      sender,
      content: `[file:${filename}]`,
      type: "file",
      timestamp: Date.now(),
    });
  }

  private handleEscalation(msg: ProtocolMessage, senderPubkey: string): void {
    if (!this.verifyPeer(senderPubkey, "escalate")) return;
    const fromAgent = msg.fromAgent as string;
    const message = msg.message as string;
    console.log(`[p2p] Escalation from ${fromAgent}: ${message}`);
    this.state.setEscalation({
      roomId: msg.roomId,
      fromAgent,
      message,
    } as Escalation);
  }

  private handleEndCall(msg: ProtocolMessage, senderPubkey: string): void {
    if (!this.verifyPeer(senderPubkey, "end_call")) return;
    const reason = (msg.reason as string) ?? "ended_by_peer";
    console.log(`[p2p] Call ended: ${reason}`);
    const transcript = this.state.buildTranscript(this.config.agentId);
    if (!transcript) {
      console.warn("[p2p] Received end_call with no active call to end");
      return;
    }
    this.state.endCall({
      roomId: msg.roomId,
      reason,
      transcript,
    });
  }

  private verifyPeer(senderPubkey: string, msgType: string): boolean {
    const active = this.state.activeCall;
    if (!active) {
      console.warn(`[p2p] Ignoring ${msgType}: no active call`);
      return false;
    }
    if (senderPubkey !== active.peerPubkey) {
      console.warn(
        `[p2p] Ignoring ${msgType} from unknown pubkey ${senderPubkey.substring(0, 12)}...`,
      );
      return false;
    }
    return true;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async sendDM(recipientPubkey: string, payload: ProtocolMessage): Promise<void> {
    // Tag with sender agentId — Suggested by @PedroFuenmayor
    const plaintext = JSON.stringify({ ...payload, origin: this.config.agentId });
    const ciphertext = await nip04.encrypt(
      this.identity.privateKey,
      recipientPubkey,
      plaintext,
    );

    const event = finalizeEvent(
      {
        kind: DM_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", recipientPubkey]],
        content: ciphertext,
      },
      this.identity.privateKey,
    );

    // Audit logging — Suggested by @ShinyTamatoa
    if (this.auditLogger) {
      this.auditLogger.log({
        ts: Date.now(),
        dir: "out",
        peer: recipientPubkey.substring(0, 16),
        room: payload.roomId,
        type: payload.type,
        content:
          typeof payload.content === "string" ? payload.content.substring(0, 500) : "",
      });
    }

    try {
      await Promise.any(this.pool.publish(this.relays, event));
    } catch (err) {
      const details =
        err instanceof AggregateError
          ? err.errors.map((e: Error) => e.message).join("; ")
          : String(err);
      throw new Error(`Failed to publish DM to any relay: ${details}`);
    }
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.discovery.queryAgents();
  }

  generateRoomId(): string {
    return randomUUID();
  }

  async sendCallRequest(
    targetPubkey: string,
    roomId: string,
    topic: string,
  ): Promise<void> {
    await this.sendDM(targetPubkey, {
      type: "call_request",
      roomId,
      agentId: this.config.agentId,
      agentName: this.config.agentName ?? this.config.agentId,
      topic,
    });
  }

  async sendCallAccepted(targetPubkey: string, roomId: string): Promise<void> {
    await this.sendDM(targetPubkey, {
      type: "call_accepted",
      roomId,
      agentId: this.config.agentId,
      agentName: this.config.agentName ?? this.config.agentId,
    });
  }

  async sendCallRejected(
    targetPubkey: string,
    roomId: string,
    reason?: string,
  ): Promise<void> {
    await this.sendDM(targetPubkey, {
      type: "call_rejected",
      roomId,
      agentId: this.config.agentId,
      agentName: this.config.agentName ?? this.config.agentId,
      reason,
    });
  }

  async sendRoomMessage(
    targetPubkey: string,
    roomId: string,
    content: string,
  ): Promise<void> {
    await this.sendDM(targetPubkey, {
      type: "room_message",
      roomId,
      sender: this.config.agentName ?? this.config.agentId,
      content,
    });
    // Add our own message to the call state
    this.state.addMessage({
      roomId,
      sender: this.config.agentName ?? this.config.agentId,
      content,
      type: "text",
      timestamp: Date.now(),
    });
  }

  async sendRoomFile(
    targetPubkey: string,
    roomId: string,
    filename: string,
    content: string,
    mimeType: string,
  ): Promise<void> {
    if (content.length > MAX_MESSAGE_SIZE) {
      throw new Error(
        `File too large: ${content.length} bytes (max ${MAX_MESSAGE_SIZE})`,
      );
    }
    await this.sendDM(targetPubkey, {
      type: "room_file",
      roomId,
      sender: this.config.agentName ?? this.config.agentId,
      filename,
      content,
      mimeType,
    });
    this.state.addMessage({
      roomId,
      sender: this.config.agentName ?? this.config.agentId,
      content: `[file:${filename}]`,
      type: "file",
      timestamp: Date.now(),
    });
  }

  async sendEscalation(
    targetPubkey: string,
    roomId: string,
    message: string,
  ): Promise<void> {
    await this.sendDM(targetPubkey, {
      type: "escalate",
      roomId,
      fromAgent: this.config.agentId,
      message,
    });
  }

  async sendEndCall(targetPubkey: string, roomId: string): Promise<void> {
    await this.sendDM(targetPubkey, {
      type: "end_call",
      roomId,
      reason: "ended_by_peer",
    });
  }

  startCallTimeout(roomId: string): void {
    this.clearCallTimeout();
    this.callTimeoutTimer = setTimeout(() => {
      if (this.state.pendingOutgoing === roomId) {
        console.warn(`[p2p] Call request for room ${roomId} timed out`);
        this.state.clearOutgoing();
      }
      this.callTimeoutTimer = null;
    }, CALL_REQUEST_TIMEOUT_MS);
  }

  private clearCallTimeout(): void {
    if (this.callTimeoutTimer) {
      clearTimeout(this.callTimeoutTimer);
      this.callTimeoutTimer = null;
    }
  }

  lookupAgentPubkey(agentId: string): string | undefined {
    return this.discovery.getCachedAgent(agentId)?.pubkey;
  }

  // Key rotation — Suggested by @Ki-nautilus + @ReconLobster
  async rotateKeys(): Promise<{ oldPubkey: string; newPubkey: string }> {
    if (this.isRotatingKeys) {
      throw new Error("Key rotation already in progress");
    }
    this.isRotatingKeys = true;
    try {
      return await this._rotateKeysInternal();
    } finally {
      this.isRotatingKeys = false;
    }
  }

  private async _rotateKeysInternal(): Promise<{ oldPubkey: string; newPubkey: string }> {
    const { rotateIdentity } = await import("./identity.js");
    const oldPubkey = this.identity.publicKey;

    // Generate new identity, backup old one
    const { oldIdentity, newIdentity } = rotateIdentity(this.config.identityPath);

    // Keep previous identity for grace period
    this.previousIdentity = oldIdentity;
    const prevIdentity = this.identity;
    this.identity = newIdentity;

    // Subscribe to DMs on the old pubkey during grace period
    this.previousDmSub = this.pool.subscribeMany(
      this.relays,
      {
        kinds: [DM_KIND],
        "#p": [prevIdentity.publicKey],
        since: Math.floor(Date.now() / 1000) - 10,
      },
      {
        onevent: async (event) => {
          try {
            await this.handleIncomingDM(
              event as Parameters<typeof this.handleIncomingDM>[0],
            );
          } catch (err) {
            console.error("[p2p] Error handling DM (old key):", err);
          }
        },
      },
    );

    // Re-subscribe DMs on new pubkey
    if (this.dmSub) {
      this.dmSub.close();
    }
    this.subscribeToDMs();

    // Re-announce presence with new identity
    this.discovery.updateIdentity(newIdentity);
    await this.discovery.announce();

    // Clean up old subscription after grace period (5 minutes)
    const GRACE_PERIOD_MS = 300_000;
    setTimeout(() => {
      if (this.previousDmSub) {
        this.previousDmSub.close();
        this.previousDmSub = null;
      }
      this.previousIdentity = null;
      console.log("[p2p] Key rotation grace period ended. Old key decommissioned.");
    }, GRACE_PERIOD_MS).unref();

    console.log(
      `[p2p] Key rotated: ${oldPubkey.substring(0, 12)}... → ${newIdentity.publicKey.substring(0, 12)}...`,
    );
    return { oldPubkey, newPubkey: newIdentity.publicKey };
  }
}
