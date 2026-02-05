import { finalizeEvent } from "nostr-tools/pure";
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
  [key: string]: unknown;
}

const CALL_REQUEST_TIMEOUT_MS = 60_000;

export class NostrClient {
  private pool: SimplePool;
  private identity: NostrIdentity;
  private discovery: AgentDiscovery;
  private relays: string[];
  private config: P2PConfig;
  private _connected = false;
  private dmSub: SubCloser | null = null;
  private callTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.pool.close(this.relays);
    this._connected = false;
    this.state.clearCall();
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
  }): Promise<void> {
    let plaintext: string;
    try {
      plaintext = await nip04.decrypt(
        this.identity.privateKey,
        event.pubkey,
        event.content,
      );
    } catch (err) {
      // Expected for DMs not addressed to us — log at debug level
      console.debug(
        `[p2p] Failed to decrypt DM from ${event.pubkey.substring(0, 12)}...:`,
        err instanceof Error ? err.message : err,
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
    const plaintext = JSON.stringify(payload);
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
}
