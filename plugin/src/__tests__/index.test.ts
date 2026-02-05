import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCommand, parseCLIArgs, requireEnv, intEnv, loadConfig } from "../index.js";
import { CallState } from "../call-state.js";
import type { NostrClient } from "../nostr-client.js";
import type { P2PConfig } from "../types.js";

function createMockClient(overrides: Partial<NostrClient> = {}): NostrClient {
  const state = new CallState();
  return {
    connected: true,
    publicKey: "abcdef1234567890abcdef1234567890",
    state,
    listAgents: vi.fn(async () => []),
    lookupAgentPubkey: vi.fn(() => undefined),
    generateRoomId: vi.fn(() => "room-uuid-123"),
    sendCallRequest: vi.fn(async () => {}),
    sendCallAccepted: vi.fn(async () => {}),
    sendCallRejected: vi.fn(async () => {}),
    sendRoomMessage: vi.fn(async () => {}),
    sendRoomFile: vi.fn(async () => {}),
    sendEscalation: vi.fn(async () => {}),
    sendEndCall: vi.fn(async () => {}),
    startCallTimeout: vi.fn(),
    ...overrides,
  } as unknown as NostrClient;
}

const config: P2PConfig = {
  agentId: "test-agent",
  agentName: "Test Agent",
};

describe("handleCommand", () => {
  let client: NostrClient;

  beforeEach(() => {
    client = createMockClient();
  });

  describe("status", () => {
    it("returns connection status", async () => {
      const result = await handleCommand(client, config, "status", {});
      expect(result.content).toContain("Connected: true");
      expect(result.content).toContain("Pubkey: abcdef1234567890...");
      expect(result.content).toContain("Active call: none");
    });
  });

  describe("list", () => {
    it("throws when not connected", async () => {
      client = createMockClient({ connected: false } as Partial<NostrClient>);
      await expect(handleCommand(client, config, "list", {})).rejects.toThrow(
        "Not connected",
      );
    });

    it("returns no agents message", async () => {
      const result = await handleCommand(client, config, "list", {});
      expect(result.content).toBe("No agents currently online.");
    });

    it("returns agent list", async () => {
      client = createMockClient({
        listAgents: vi.fn(async () => [
          {
            agentId: "bob",
            name: "Bob",
            capabilities: ["research"],
            online: true,
            pubkey: "bob-pubkey-123456789012",
          },
        ]),
      } as Partial<NostrClient>);
      const result = await handleCommand(client, config, "list", {});
      expect(result.content).toContain("Bob (bob)");
      expect(result.content).toContain("research");
    });
  });

  describe("call", () => {
    it("throws when not connected", async () => {
      client = createMockClient({ connected: false } as Partial<NostrClient>);
      await expect(
        handleCommand(client, config, "call", { targetAgentId: "bob" }),
      ).rejects.toThrow("Not connected");
    });

    it("throws when no targetAgentId", async () => {
      await expect(handleCommand(client, config, "call", {})).rejects.toThrow(
        "targetAgentId required",
      );
    });

    it("throws when agent not found", async () => {
      await expect(
        handleCommand(client, config, "call", { targetAgentId: "unknown" }),
      ).rejects.toThrow('Agent "unknown" not found');
    });

    it("sends call request when agent found", async () => {
      client = createMockClient({
        lookupAgentPubkey: vi.fn(() => "bob-pubkey"),
      } as Partial<NostrClient>);
      const result = await handleCommand(client, config, "call", {
        targetAgentId: "bob",
        topic: "test",
      });
      expect(result.content).toContain("Call request sent to bob");
      expect(client.sendCallRequest).toHaveBeenCalled();
      expect(client.startCallTimeout).toHaveBeenCalled();
    });

    it("retries lookup after listAgents", async () => {
      let callCount = 0;
      client = createMockClient({
        lookupAgentPubkey: vi.fn(() => {
          callCount++;
          return callCount > 1 ? "bob-pubkey" : undefined;
        }),
      } as Partial<NostrClient>);
      const result = await handleCommand(client, config, "call", {
        targetAgentId: "bob",
      });
      expect(result.content).toContain("Call request sent to bob");
      expect(client.listAgents).toHaveBeenCalled();
    });
  });

  describe("answer", () => {
    it("returns no pending call message", async () => {
      const result = await handleCommand(client, config, "answer", {
        accept: true,
      });
      expect(result.content).toContain("No pending incoming call");
    });

    it("accepts incoming call", async () => {
      client.state.setIncomingCall({
        roomId: "room-1",
        callerId: "bob",
        callerName: "Bob",
        topic: "test",
        callerPubkey: "bob-pubkey",
      });
      const result = await handleCommand(client, config, "answer", {
        accept: true,
      });
      expect(result.content).toContain("Call accepted");
      expect(client.sendCallAccepted).toHaveBeenCalled();
    });

    it("rejects incoming call", async () => {
      client.state.setIncomingCall({
        roomId: "room-1",
        callerId: "bob",
        callerName: "Bob",
        topic: "test",
        callerPubkey: "bob-pubkey",
      });
      const result = await handleCommand(client, config, "answer", {
        accept: false,
        reason: "busy",
      });
      expect(result.content).toContain("rejected");
      expect(client.sendCallRejected).toHaveBeenCalled();
    });
  });

  describe("send", () => {
    it("throws when no active call", async () => {
      await expect(
        handleCommand(client, config, "send", { content: "hi" }),
      ).rejects.toThrow("No active call");
    });

    it("throws when no content", async () => {
      client.state.acceptCall("room-1", "bob", "Bob", "bob-pub", "caller");
      await expect(handleCommand(client, config, "send", {})).rejects.toThrow(
        "Message content required",
      );
    });

    it("sends message", async () => {
      client.state.acceptCall("room-1", "bob", "Bob", "bob-pub", "caller");
      const result = await handleCommand(client, config, "send", {
        content: "hello",
      });
      expect(result.content).toContain("Message sent to Bob");
    });
  });

  describe("sendfile", () => {
    it("throws when no active call", async () => {
      await expect(
        handleCommand(client, config, "sendfile", {
          filename: "f.txt",
          content: "data",
        }),
      ).rejects.toThrow("No active call");
    });

    it("throws when missing args", async () => {
      client.state.acceptCall("room-1", "bob", "Bob", "bob-pub", "caller");
      await expect(
        handleCommand(client, config, "sendfile", { filename: "f.txt" }),
      ).rejects.toThrow("filename and content required");
    });

    it("sends file", async () => {
      client.state.acceptCall("room-1", "bob", "Bob", "bob-pub", "caller");
      const result = await handleCommand(client, config, "sendfile", {
        filename: "test.txt",
        content: "data",
      });
      expect(result.content).toContain('File "test.txt" sent to Bob');
    });
  });

  describe("escalate", () => {
    it("throws when no active call", async () => {
      await expect(
        handleCommand(client, config, "escalate", { message: "help" }),
      ).rejects.toThrow("No active call");
    });

    it("throws when no message", async () => {
      client.state.acceptCall("room-1", "bob", "Bob", "bob-pub", "caller");
      await expect(handleCommand(client, config, "escalate", {})).rejects.toThrow(
        "message required",
      );
    });

    it("sends escalation", async () => {
      client.state.acceptCall("room-1", "bob", "Bob", "bob-pub", "caller");
      const result = await handleCommand(client, config, "escalate", {
        message: "need help",
      });
      expect(result.content).toContain("Escalation sent");
    });
  });

  describe("end", () => {
    it("returns no active call message", async () => {
      const result = await handleCommand(client, config, "end", {});
      expect(result.content).toBe("No active call to end.");
    });

    it("ends call and returns transcript info", async () => {
      client.state.acceptCall("room-1", "bob", "Bob", "bob-pub", "caller");
      const result = await handleCommand(client, config, "end", {});
      expect(result.content).toContain("Call ended");
      expect(result.content).toContain("0 messages exchanged");
      expect(client.sendEndCall).toHaveBeenCalled();
    });
  });

  describe("unknown command", () => {
    it("throws for unknown command", async () => {
      await expect(handleCommand(client, config, "bogus", {})).rejects.toThrow(
        "Unknown command: bogus",
      );
    });
  });
});

describe("parseCLIArgs", () => {
  it("parses call command", () => {
    const result = parseCLIArgs(["call", "bob", "test topic"]);
    expect(result).toEqual({
      command: "call",
      args: { targetAgentId: "bob", topic: "test topic" },
    });
  });

  it("parses answer accept", () => {
    const result = parseCLIArgs(["answer", "accept"]);
    expect(result).toEqual({
      command: "answer",
      args: { accept: true, reason: undefined },
    });
  });

  it("parses answer reject with reason", () => {
    const result = parseCLIArgs(["answer", "reject", "busy"]);
    expect(result).toEqual({
      command: "answer",
      args: { accept: false, reason: "busy" },
    });
  });

  it("parses send command with multi-word message", () => {
    const result = parseCLIArgs(["send", "hello", "world"]);
    expect(result).toEqual({
      command: "send",
      args: { content: "hello world" },
    });
  });

  it("parses sendfile command", () => {
    const result = parseCLIArgs(["sendfile", "test.txt", "base64data", "text/plain"]);
    expect(result).toEqual({
      command: "sendfile",
      args: { filename: "test.txt", content: "base64data", mimeType: "text/plain" },
    });
  });

  it("parses escalate command", () => {
    const result = parseCLIArgs(["escalate", "need", "help"]);
    expect(result).toEqual({
      command: "escalate",
      args: { message: "need help" },
    });
  });

  it("defaults to status for unknown command", () => {
    const result = parseCLIArgs(["status"]);
    expect(result).toEqual({ command: "status", args: {} });
  });

  it("defaults to status for empty argv", () => {
    const result = parseCLIArgs([]);
    expect(result).toEqual({ command: "status", args: {} });
  });
});

describe("requireEnv", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("returns environment variable value", () => {
    process.env.TEST_REQUIRE_ENV = "hello";
    expect(requireEnv("TEST_REQUIRE_ENV")).toBe("hello");
    delete process.env.TEST_REQUIRE_ENV;
  });

  it("calls process.exit when variable is missing", () => {
    delete process.env.MISSING_VAR;
    requireEnv("MISSING_VAR");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe("intEnv", () => {
  const originalExit = process.exit;

  beforeEach(() => {
    process.exit = vi.fn() as never;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("returns fallback when not set", () => {
    delete process.env.TEST_INT_ENV;
    expect(intEnv("TEST_INT_ENV", 42)).toBe(42);
  });

  it("parses valid integer", () => {
    process.env.TEST_INT_ENV = "123";
    expect(intEnv("TEST_INT_ENV", 0)).toBe(123);
    delete process.env.TEST_INT_ENV;
  });

  it("calls process.exit for invalid integer", () => {
    process.env.TEST_INT_ENV = "not-a-number";
    intEnv("TEST_INT_ENV", 0);
    expect(process.exit).toHaveBeenCalledWith(1);
    delete process.env.TEST_INT_ENV;
  });
});

describe("loadConfig", () => {
  const originalExit = process.exit;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    process.exit = vi.fn() as never;
    // Save and set required env vars
    const keys = [
      "P2P_AGENT_ID",
      "P2P_AGENT_NAME",
      "P2P_CAPABILITIES",
      "P2P_OWNER_CHANNEL",
      "P2P_IPC_PORT",
      "P2P_NOSTR_RELAYS",
      "P2P_IDENTITY_PATH",
    ];
    for (const k of keys) {
      savedEnv[k] = process.env[k];
    }
  });

  afterEach(() => {
    process.exit = originalExit;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("loads minimal config", () => {
    process.env.P2P_AGENT_ID = "test-bot";
    delete process.env.P2P_AGENT_NAME;
    delete process.env.P2P_CAPABILITIES;
    delete process.env.P2P_NOSTR_RELAYS;
    delete process.env.P2P_IPC_PORT;
    const cfg = loadConfig();
    expect(cfg.agentId).toBe("test-bot");
    expect(cfg.ipcPort).toBe(18799);
  });

  it("loads full config", () => {
    process.env.P2P_AGENT_ID = "test-bot";
    process.env.P2P_AGENT_NAME = "Test Bot";
    process.env.P2P_CAPABILITIES = "research, coding";
    process.env.P2P_NOSTR_RELAYS = "wss://r1.test, wss://r2.test";
    process.env.P2P_IPC_PORT = "9999";
    const cfg = loadConfig();
    expect(cfg.agentId).toBe("test-bot");
    expect(cfg.agentName).toBe("Test Bot");
    expect(cfg.capabilities).toEqual(["research", "coding"]);
    expect(cfg.nostrRelays).toEqual(["wss://r1.test", "wss://r2.test"]);
    expect(cfg.ipcPort).toBe(9999);
  });
});
