export interface NostrIdentity {
  privateKey: Uint8Array;
  publicKey: string;
}

export interface P2PConfig {
  agentId: string;
  agentName?: string;
  capabilities?: string[];
  ownerChannel?: string;
  ipcPort?: number;
  nostrRelays?: string[];
  identityPath?: string;
  auditMode?: boolean; // Suggested by @ShinyTamatoa
  auditLogPath?: string; // Suggested by @ShinyTamatoa
}

export interface AgentInfo {
  agentId: string;
  name: string;
  capabilities: string[];
  online: boolean;
  pubkey: string;
}

export interface IncomingCall {
  roomId: string;
  callerId: string;
  callerName: string;
  topic: string;
  callerPubkey: string;
}

export interface RoomMessage {
  roomId: string;
  sender: string;
  content: string;
  type: "text" | "file";
  timestamp: number;
}

export interface Escalation {
  roomId: string;
  fromAgent: string;
  message: string;
}

// Suggested by @ShinyTamatoa
export interface AuditLogEntry {
  ts: number;
  dir: "in" | "out";
  peer: string;
  room: string;
  type: string;
  content: string;
}

export interface CallEndedEvent {
  roomId: string;
  reason: string;
  transcript: TranscriptData;
}

export interface TranscriptData {
  roomId: string;
  caller: string;
  callee: string;
  duration: number;
  messageCount: number;
  messages: TranscriptMessage[];
}

export interface TranscriptMessage {
  sender: string;
  content: string;
  timestamp: number;
  type: string;
}
