import { describe, it, expect, beforeEach } from "vitest";
import { CallState } from "../call-state.js";
import type { IncomingCall, RoomMessage, Escalation } from "../types.js";

describe("CallState", () => {
  let state: CallState;

  beforeEach(() => {
    state = new CallState();
  });

  it("starts with no active call or pending state", () => {
    expect(state.activeCall).toBeNull();
    expect(state.pendingIncoming).toBeNull();
    expect(state.pendingOutgoing).toBeNull();
    expect(state.lastTranscript).toBeNull();
    expect(state.lastEscalation).toBeNull();
  });

  describe("setPendingOutgoing", () => {
    it("sets pending outgoing room ID", () => {
      state.setPendingOutgoing("room-1");
      expect(state.pendingOutgoing).toBe("room-1");
    });
  });

  describe("setIncomingCall", () => {
    it("sets pending incoming call", () => {
      const call: IncomingCall = {
        roomId: "room-1",
        callerId: "bob",
        callerName: "Bob",
        topic: "test topic",
        callerPubkey: "abc123",
      };
      state.setIncomingCall(call);
      expect(state.pendingIncoming).toEqual(call);
    });
  });

  describe("acceptCall", () => {
    it("creates an active call and clears pending states", () => {
      state.setPendingOutgoing("room-1");
      state.setIncomingCall({
        roomId: "room-2",
        callerId: "bob",
        callerName: "Bob",
        topic: "",
        callerPubkey: "pk-bob",
      });

      const result = state.acceptCall("room-1", "bob", "Bob", "pk-bob", "caller");

      expect(result).toBe(true);
      expect(state.activeCall).not.toBeNull();
      expect(state.activeCall!.roomId).toBe("room-1");
      expect(state.activeCall!.peerId).toBe("bob");
      expect(state.activeCall!.peerName).toBe("Bob");
      expect(state.activeCall!.peerPubkey).toBe("pk-bob");
      expect(state.activeCall!.role).toBe("caller");
      expect(state.activeCall!.messages).toEqual([]);
      expect(state.activeCall!.startedAt).toBeGreaterThan(0);
      expect(state.pendingIncoming).toBeNull();
      expect(state.pendingOutgoing).toBeNull();
    });

    it("rejects acceptCall when caller role and roomId mismatch", () => {
      state.setPendingOutgoing("room-1");

      const result = state.acceptCall("room-WRONG", "bob", "Bob", "pk-bob", "caller");

      expect(result).toBe(false);
      expect(state.activeCall).toBeNull();
      expect(state.pendingOutgoing).toBe("room-1");
    });

    it("accepts call as callee regardless of pendingOutgoing", () => {
      state.setPendingOutgoing("room-1");

      const result = state.acceptCall("room-2", "bob", "Bob", "pk-bob", "callee");

      expect(result).toBe(true);
      expect(state.activeCall).not.toBeNull();
      expect(state.activeCall!.roomId).toBe("room-2");
    });
  });

  describe("rejectCall", () => {
    it("clears pending incoming", () => {
      state.setIncomingCall({
        roomId: "room-1",
        callerId: "bob",
        callerName: "Bob",
        topic: "",
        callerPubkey: "pk-bob",
      });
      state.rejectCall();
      expect(state.pendingIncoming).toBeNull();
    });
  });

  describe("clearOutgoing", () => {
    it("clears pending outgoing", () => {
      state.setPendingOutgoing("room-1");
      state.clearOutgoing();
      expect(state.pendingOutgoing).toBeNull();
    });
  });

  describe("addMessage", () => {
    it("adds message to active call when roomId matches", () => {
      state.acceptCall("room-1", "bob", "Bob", "pk-bob", "caller");

      const msg: RoomMessage = {
        roomId: "room-1",
        sender: "Bob",
        content: "hello",
        type: "text",
        timestamp: 1700000000000,
      };
      state.addMessage(msg);

      expect(state.activeCall!.messages).toHaveLength(1);
      expect(state.activeCall!.messages[0]).toEqual(msg);
    });

    it("ignores messages for different roomId", () => {
      state.acceptCall("room-1", "bob", "Bob", "pk-bob", "caller");

      state.addMessage({
        roomId: "room-OTHER",
        sender: "Bob",
        content: "hello",
        type: "text",
        timestamp: 1700000000000,
      });

      expect(state.activeCall!.messages).toHaveLength(0);
    });

    it("ignores messages when no active call", () => {
      // Should not throw
      state.addMessage({
        roomId: "room-1",
        sender: "Bob",
        content: "hello",
        type: "text",
        timestamp: 1700000000000,
      });
    });
  });

  describe("setEscalation", () => {
    it("stores the last escalation", () => {
      const esc: Escalation = {
        roomId: "room-1",
        fromAgent: "bob",
        message: "need help",
      };
      state.setEscalation(esc);
      expect(state.lastEscalation).toEqual(esc);
    });
  });

  describe("endCall", () => {
    it("stores transcript and clears all call state", () => {
      state.acceptCall("room-1", "bob", "Bob", "pk-bob", "caller");
      state.addMessage({
        roomId: "room-1",
        sender: "Bob",
        content: "hi",
        type: "text",
        timestamp: 1700000000000,
      });

      const transcript = state.buildTranscript("alice");

      state.endCall({
        roomId: "room-1",
        reason: "ended_by_self",
        transcript: transcript!,
      });

      expect(state.activeCall).toBeNull();
      expect(state.pendingIncoming).toBeNull();
      expect(state.pendingOutgoing).toBeNull();
      expect(state.lastTranscript).toEqual(transcript);
    });
  });

  describe("buildTranscript", () => {
    it("builds transcript from active call as caller", () => {
      state.acceptCall("room-1", "bob", "Bob", "pk-bob", "caller");
      state.addMessage({
        roomId: "room-1",
        sender: "Alice",
        content: "hello",
        type: "text",
        timestamp: 1700000001000,
      });
      state.addMessage({
        roomId: "room-1",
        sender: "Bob",
        content: "hi back",
        type: "text",
        timestamp: 1700000002000,
      });

      const transcript = state.buildTranscript("alice");

      expect(transcript).not.toBeNull();
      expect(transcript!.roomId).toBe("room-1");
      expect(transcript!.caller).toBe("alice");
      expect(transcript!.callee).toBe("bob");
      expect(transcript!.messageCount).toBe(2);
      expect(transcript!.messages).toHaveLength(2);
      expect(transcript!.duration).toBeGreaterThanOrEqual(0);
      // Verify timestamps are from stored messages, not Date.now()
      expect(transcript!.messages[0].timestamp).toBe(1700000001000);
      expect(transcript!.messages[1].timestamp).toBe(1700000002000);
    });

    it("builds transcript from active call as callee", () => {
      state.acceptCall("room-1", "alice", "Alice", "pk-alice", "callee");

      const transcript = state.buildTranscript("bob");

      expect(transcript).not.toBeNull();
      expect(transcript!.caller).toBe("alice");
      expect(transcript!.callee).toBe("bob");
    });

    it("returns null when no active call", () => {
      const transcript = state.buildTranscript("alice");
      expect(transcript).toBeNull();
    });
  });

  describe("clearCall", () => {
    it("clears all call-related state", () => {
      state.acceptCall("room-1", "bob", "Bob", "pk-bob", "caller");
      state.setPendingOutgoing("room-2");
      state.setIncomingCall({
        roomId: "room-3",
        callerId: "charlie",
        callerName: "Charlie",
        topic: "",
        callerPubkey: "pk-charlie",
      });

      state.clearCall();

      expect(state.activeCall).toBeNull();
      expect(state.pendingIncoming).toBeNull();
      expect(state.pendingOutgoing).toBeNull();
    });
  });

  describe("toJSON", () => {
    it("serializes empty state", () => {
      const json = state.toJSON();
      expect(json.connected).toBe(false);
      expect(json.activeCall).toBeNull();
      expect(json.pendingIncoming).toBeNull();
      expect(json.pendingOutgoing).toBeNull();
      expect(json.lastEscalation).toBeNull();
    });

    it("serializes active call without full messages array", () => {
      state.acceptCall("room-1", "bob", "Bob", "pk-bob", "caller");
      state.addMessage({
        roomId: "room-1",
        sender: "Bob",
        content: "hi",
        type: "text",
        timestamp: 1700000000000,
      });

      const json = state.toJSON();
      const call = json.activeCall as Record<string, unknown>;
      expect(call.roomId).toBe("room-1");
      expect(call.peerId).toBe("bob");
      expect(call.peerName).toBe("Bob");
      expect(call.role).toBe("caller");
      expect(call.messageCount).toBe(1);
      // Should not expose full messages or peerPubkey in serialized form
      expect(call.messages).toBeUndefined();
    });
  });
});
