import type {
  IncomingCall,
  RoomMessage,
  CallEndedEvent,
  Escalation,
  TranscriptData,
} from "./types.js";

export interface ActiveCall {
  roomId: string;
  peerId: string;
  peerName: string;
  peerPubkey: string;
  role: "caller" | "callee";
  messages: RoomMessage[];
  startedAt: number;
}

export class CallState {
  private _activeCall: ActiveCall | null = null;
  private _pendingIncoming: IncomingCall | null = null;
  private _pendingOutgoing: string | null = null;
  private _lastTranscript: TranscriptData | null = null;
  private _lastEscalation: Escalation | null = null;

  get activeCall(): ActiveCall | null {
    return this._activeCall;
  }

  get pendingIncoming(): IncomingCall | null {
    return this._pendingIncoming;
  }

  get pendingOutgoing(): string | null {
    return this._pendingOutgoing;
  }

  get lastTranscript(): TranscriptData | null {
    return this._lastTranscript;
  }

  get lastEscalation(): Escalation | null {
    return this._lastEscalation;
  }

  setPendingOutgoing(roomId: string): void {
    this._pendingOutgoing = roomId;
  }

  setIncomingCall(call: IncomingCall): void {
    this._pendingIncoming = call;
  }

  acceptCall(
    roomId: string,
    peerId: string,
    peerName: string,
    peerPubkey: string,
    role: "caller" | "callee",
  ): boolean {
    // When caller, verify this acceptance matches our pending outgoing call
    if (role === "caller" && this._pendingOutgoing && roomId !== this._pendingOutgoing) {
      console.warn(
        `[p2p] Ignoring acceptCall: roomId ${roomId} does not match pending ${this._pendingOutgoing}`,
      );
      return false;
    }
    this._activeCall = {
      roomId,
      peerId,
      peerName,
      peerPubkey,
      role,
      messages: [],
      startedAt: Date.now(),
    };
    this._pendingIncoming = null;
    this._pendingOutgoing = null;
    return true;
  }

  rejectCall(): void {
    this._pendingIncoming = null;
  }

  clearOutgoing(): void {
    this._pendingOutgoing = null;
  }

  addMessage(msg: RoomMessage): void {
    if (!this._activeCall) return;
    if (this._activeCall.roomId === msg.roomId) {
      this._activeCall.messages.push(msg);
    } else {
      console.warn(
        `[p2p] Dropping message for room ${msg.roomId} (active: ${this._activeCall.roomId})`,
      );
    }
  }

  setEscalation(esc: Escalation): void {
    this._lastEscalation = esc;
  }

  endCall(event: CallEndedEvent): void {
    this._lastTranscript = event.transcript;
    this._activeCall = null;
    this._pendingIncoming = null;
    this._pendingOutgoing = null;
  }

  buildTranscript(myAgentId: string): TranscriptData | null {
    const call = this._activeCall;
    if (!call) return null;
    const duration = Date.now() - call.startedAt;
    const caller = call.role === "caller" ? myAgentId : call.peerId;
    const callee = call.role === "callee" ? myAgentId : call.peerId;
    return {
      roomId: call.roomId,
      caller,
      callee,
      duration,
      messageCount: call.messages.length,
      messages: call.messages.map((m) => ({
        sender: m.sender,
        content: m.content,
        timestamp: m.timestamp,
        type: m.type,
      })),
    };
  }

  clearCall(): void {
    this._activeCall = null;
    this._pendingIncoming = null;
    this._pendingOutgoing = null;
  }

  toJSON(): Record<string, unknown> {
    return {
      connected: false, // Filled by caller
      activeCall: this._activeCall
        ? {
            roomId: this._activeCall.roomId,
            peerId: this._activeCall.peerId,
            peerName: this._activeCall.peerName,
            role: this._activeCall.role,
            messageCount: this._activeCall.messages.length,
          }
        : null,
      pendingIncoming: this._pendingIncoming,
      pendingOutgoing: this._pendingOutgoing,
      lastEscalation: this._lastEscalation,
    };
  }
}
