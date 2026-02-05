import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NostrClient } from "../nostr-client.js";
import type { P2PConfig } from "../types.js";
import * as nip04Module from "nostr-tools/nip04";

// Mock nostr-tools
vi.mock("nostr-tools/pure", () => ({
  finalizeEvent: vi.fn((template: Record<string, unknown>) => ({
    ...template,
    id: "mock-event-id",
    sig: "mock-sig",
    pubkey: "mock-pubkey",
  })),
}));

vi.mock("nostr-tools/nip04", () => ({
  encrypt: vi.fn(async () => "encrypted-content"),
  decrypt: vi.fn(async () => "{}"),
}));

const mockSubCloser = { close: vi.fn() };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let capturedOnevent: ((event: any) => void) | null = null;

vi.mock("nostr-tools/pool", () => {
  class MockSimplePool {
    publish = vi.fn(() => [Promise.resolve("")]);
    subscribeMany = vi.fn(
      (
        _relays: string[],
        _filter: unknown,
        opts: { onevent: (event: unknown) => void },
      ) => {
        capturedOnevent = opts.onevent;
        return mockSubCloser;
      },
    );
    querySync = vi.fn(async () => []);
    close = vi.fn();
  }
  return { SimplePool: MockSimplePool };
});

vi.mock("../discovery.js", () => {
  class MockAgentDiscovery {
    startAnnouncing = vi.fn();
    stopAnnouncing = vi.fn();
    queryAgents = vi.fn(async () => []);
    getCachedAgent = vi.fn();
  }
  return { AgentDiscovery: MockAgentDiscovery };
});

vi.mock("../identity.js", () => ({
  loadOrCreateIdentity: vi.fn(() => ({
    privateKey: new Uint8Array(32),
    publicKey: "test-pubkey-abcdef123456",
  })),
}));

const mockDecrypt = nip04Module.decrypt as ReturnType<typeof vi.fn>;

const baseConfig: P2PConfig = {
  agentId: "test-agent",
  agentName: "Test Agent",
  capabilities: ["testing"],
};

describe("NostrClient", () => {
  let client: NostrClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new NostrClient(baseConfig);
  });

  afterEach(() => {
    if (client.connected) client.disconnect();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("initializes with config", () => {
      expect(client.connected).toBe(false);
      expect(client.publicKey).toBe("test-pubkey-abcdef123456");
    });

    it("uses default relays when none provided", () => {
      const c = new NostrClient({ agentId: "a" });
      expect(c).toBeDefined();
    });
  });

  describe("connect / disconnect", () => {
    it("sets connected to true", () => {
      client.connect();
      expect(client.connected).toBe(true);
    });

    it("disconnect sets connected to false", () => {
      client.connect();
      client.disconnect();
      expect(client.connected).toBe(false);
    });

    it("disconnect clears call state", () => {
      client.connect();
      client.state.setPendingOutgoing("room-1");
      client.disconnect();
      expect(client.state.pendingOutgoing).toBeNull();
    });
  });

  describe("generateRoomId", () => {
    it("returns a UUID string", () => {
      vi.useRealTimers(); // crypto.randomUUID needs real timers
      const id = client.generateRoomId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe("sendDM", () => {
    it("encrypts and publishes a DM", async () => {
      vi.useRealTimers();
      await client.sendDM("recipient-pub", {
        type: "room_message",
        roomId: "room-1",
        content: "hello",
      });
      // If no error thrown, DM was sent successfully
    });
  });

  describe("sendCallRequest", () => {
    it("sends call_request DM", async () => {
      vi.useRealTimers();
      const spy = vi.spyOn(client, "sendDM").mockResolvedValue();
      await client.sendCallRequest("target-pub", "room-1", "test topic");
      expect(spy).toHaveBeenCalledWith(
        "target-pub",
        expect.objectContaining({
          type: "call_request",
          roomId: "room-1",
          topic: "test topic",
        }),
      );
    });
  });

  describe("sendCallAccepted", () => {
    it("sends call_accepted DM", async () => {
      vi.useRealTimers();
      const spy = vi.spyOn(client, "sendDM").mockResolvedValue();
      await client.sendCallAccepted("target-pub", "room-1");
      expect(spy).toHaveBeenCalledWith(
        "target-pub",
        expect.objectContaining({
          type: "call_accepted",
          roomId: "room-1",
        }),
      );
    });
  });

  describe("sendCallRejected", () => {
    it("sends call_rejected DM with reason", async () => {
      vi.useRealTimers();
      const spy = vi.spyOn(client, "sendDM").mockResolvedValue();
      await client.sendCallRejected("target-pub", "room-1", "busy");
      expect(spy).toHaveBeenCalledWith(
        "target-pub",
        expect.objectContaining({
          type: "call_rejected",
          roomId: "room-1",
          reason: "busy",
        }),
      );
    });
  });

  describe("sendRoomMessage", () => {
    it("sends message and adds to local state", async () => {
      vi.useRealTimers();
      const spy = vi.spyOn(client, "sendDM").mockResolvedValue();
      // Set up active call
      client.state.acceptCall("room-1", "peer", "Peer", "peer-pub", "caller");
      await client.sendRoomMessage("peer-pub", "room-1", "hello");
      expect(spy).toHaveBeenCalled();
      expect(client.state.activeCall!.messages).toHaveLength(1);
      expect(client.state.activeCall!.messages[0].content).toBe("hello");
    });
  });

  describe("sendRoomFile", () => {
    it("sends file and adds to local state", async () => {
      vi.useRealTimers();
      const spy = vi.spyOn(client, "sendDM").mockResolvedValue();
      client.state.acceptCall("room-1", "peer", "Peer", "peer-pub", "caller");
      await client.sendRoomFile(
        "peer-pub",
        "room-1",
        "test.txt",
        "content",
        "text/plain",
      );
      expect(spy).toHaveBeenCalled();
      expect(client.state.activeCall!.messages).toHaveLength(1);
      expect(client.state.activeCall!.messages[0].content).toBe("[file:test.txt]");
    });
  });

  describe("sendEscalation", () => {
    it("sends escalation DM", async () => {
      vi.useRealTimers();
      const spy = vi.spyOn(client, "sendDM").mockResolvedValue();
      await client.sendEscalation("peer-pub", "room-1", "need help");
      expect(spy).toHaveBeenCalledWith(
        "peer-pub",
        expect.objectContaining({
          type: "escalate",
          roomId: "room-1",
          message: "need help",
        }),
      );
    });
  });

  describe("sendEndCall", () => {
    it("sends end_call DM", async () => {
      vi.useRealTimers();
      const spy = vi.spyOn(client, "sendDM").mockResolvedValue();
      await client.sendEndCall("peer-pub", "room-1");
      expect(spy).toHaveBeenCalledWith(
        "peer-pub",
        expect.objectContaining({
          type: "end_call",
          roomId: "room-1",
        }),
      );
    });
  });

  describe("listAgents", () => {
    it("delegates to discovery", async () => {
      vi.useRealTimers();
      const agents = await client.listAgents();
      expect(agents).toEqual([]);
    });
  });

  describe("lookupAgentPubkey", () => {
    it("returns undefined for unknown agent", () => {
      expect(client.lookupAgentPubkey("unknown")).toBeUndefined();
    });
  });

  describe("incoming DM handling", () => {
    function simulateDM(pubkey: string, plaintext: string): Promise<void> {
      mockDecrypt.mockResolvedValueOnce(plaintext);
      capturedOnevent!({
        pubkey,
        content: "encrypted",
        created_at: Math.floor(Date.now() / 1000),
      });
      // Wait for async handler
      return new Promise((r) => setTimeout(r, 10));
    }

    beforeEach(() => {
      vi.useRealTimers();
      client.connect();
    });

    it("handles call_request and sets pending incoming", async () => {
      await simulateDM(
        "caller-pub",
        JSON.stringify({
          type: "call_request",
          roomId: "room-1",
          agentId: "caller-agent",
          agentName: "Caller",
          topic: "test",
        }),
      );
      expect(client.state.pendingIncoming).not.toBeNull();
      expect(client.state.pendingIncoming!.callerId).toBe("caller-agent");
    });

    it("handles call_accepted and transitions to active call", async () => {
      client.state.setPendingOutgoing("room-1");
      await simulateDM(
        "callee-pub",
        JSON.stringify({
          type: "call_accepted",
          roomId: "room-1",
          agentId: "callee-agent",
          agentName: "Callee",
        }),
      );
      expect(client.state.activeCall).not.toBeNull();
      expect(client.state.activeCall!.peerId).toBe("callee-agent");
    });

    it("handles call_rejected and clears outgoing", async () => {
      client.state.setPendingOutgoing("room-1");
      await simulateDM(
        "callee-pub",
        JSON.stringify({
          type: "call_rejected",
          roomId: "room-1",
          reason: "busy",
        }),
      );
      expect(client.state.pendingOutgoing).toBeNull();
    });

    it("handles room_message from verified peer", async () => {
      client.state.acceptCall("room-1", "peer", "Peer", "peer-pub", "caller");
      await simulateDM(
        "peer-pub",
        JSON.stringify({
          type: "room_message",
          roomId: "room-1",
          sender: "Peer",
          content: "hello from peer",
        }),
      );
      expect(client.state.activeCall!.messages).toHaveLength(1);
      expect(client.state.activeCall!.messages[0].content).toBe("hello from peer");
    });

    it("rejects room_message from unknown pubkey", async () => {
      client.state.acceptCall("room-1", "peer", "Peer", "peer-pub", "caller");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await simulateDM(
        "stranger-pub",
        JSON.stringify({
          type: "room_message",
          roomId: "room-1",
          sender: "Stranger",
          content: "hi",
        }),
      );
      expect(client.state.activeCall!.messages).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown pubkey"));
      warnSpy.mockRestore();
    });

    it("handles room_file from verified peer", async () => {
      client.state.acceptCall("room-1", "peer", "Peer", "peer-pub", "caller");
      await simulateDM(
        "peer-pub",
        JSON.stringify({
          type: "room_file",
          roomId: "room-1",
          sender: "Peer",
          filename: "doc.pdf",
        }),
      );
      expect(client.state.activeCall!.messages).toHaveLength(1);
      expect(client.state.activeCall!.messages[0].content).toBe("[file:doc.pdf]");
    });

    it("handles escalation from verified peer", async () => {
      client.state.acceptCall("room-1", "peer", "Peer", "peer-pub", "caller");
      await simulateDM(
        "peer-pub",
        JSON.stringify({
          type: "escalate",
          roomId: "room-1",
          fromAgent: "peer",
          message: "need human",
        }),
      );
      expect(client.state.lastEscalation).not.toBeNull();
      expect(client.state.lastEscalation!.message).toBe("need human");
    });

    it("handles end_call from verified peer", async () => {
      client.state.acceptCall("room-1", "peer", "Peer", "peer-pub", "caller");
      await simulateDM(
        "peer-pub",
        JSON.stringify({
          type: "end_call",
          roomId: "room-1",
          reason: "done",
        }),
      );
      expect(client.state.activeCall).toBeNull();
      expect(client.state.lastTranscript).not.toBeNull();
    });

    it("ignores end_call with no active call", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await simulateDM(
        "some-pub",
        JSON.stringify({
          type: "end_call",
          roomId: "room-1",
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no active call"));
      warnSpy.mockRestore();
    });

    it("ignores DMs that fail to decrypt", async () => {
      mockDecrypt.mockRejectedValueOnce(new Error("decrypt failed"));
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      capturedOnevent!({
        pubkey: "some-pub",
        content: "bad-encrypted",
        created_at: Math.floor(Date.now() / 1000),
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to decrypt"),
        expect.anything(),
      );
      debugSpy.mockRestore();
    });

    it("ignores non-JSON DMs", async () => {
      mockDecrypt.mockResolvedValueOnce("not-json-at-all");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      capturedOnevent!({
        pubkey: "some-pub",
        content: "encrypted",
        created_at: Math.floor(Date.now() / 1000),
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("non-JSON"));
      warnSpy.mockRestore();
    });

    it("ignores DMs with missing type or roomId", async () => {
      await simulateDM(
        "some-pub",
        JSON.stringify({ type: "room_message" }), // missing roomId
      );
      // Should not throw, just silently ignore
      expect(client.state.activeCall).toBeNull();
    });

    it("ignores call_accepted for unknown room", async () => {
      client.state.setPendingOutgoing("room-1");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await simulateDM(
        "callee-pub",
        JSON.stringify({
          type: "call_accepted",
          roomId: "room-WRONG",
          agentId: "callee",
          agentName: "Callee",
        }),
      );
      expect(client.state.activeCall).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown room"));
      warnSpy.mockRestore();
    });
  });

  describe("startCallTimeout / clearCallTimeout", () => {
    it("clears pending outgoing after timeout", () => {
      client.state.setPendingOutgoing("room-1");
      client.startCallTimeout("room-1");

      vi.advanceTimersByTime(60_000);
      expect(client.state.pendingOutgoing).toBeNull();
    });

    it("does not clear if roomId changed", () => {
      client.state.setPendingOutgoing("room-2");
      client.startCallTimeout("room-1");

      vi.advanceTimersByTime(60_000);
      // room-2 is still pending because timeout was for room-1
      expect(client.state.pendingOutgoing).toBe("room-2");
    });

    it("replaces previous timeout on re-call", () => {
      client.state.setPendingOutgoing("room-1");
      client.startCallTimeout("room-1");

      // Start a new timeout for room-2
      client.state.setPendingOutgoing("room-2");
      client.startCallTimeout("room-2");

      vi.advanceTimersByTime(60_000);
      expect(client.state.pendingOutgoing).toBeNull();
    });
  });
});
