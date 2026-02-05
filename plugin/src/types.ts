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

export interface RoomFile {
  roomId: string;
  sender: string;
  filename: string;
  content: string;
  mimeType: string;
}

export interface Escalation {
  roomId: string;
  fromAgent: string;
  message: string;
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
