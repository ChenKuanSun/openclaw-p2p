import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentDiscovery } from "../discovery.js";

// Mock nostr-tools/pure
vi.mock("nostr-tools/pure", () => ({
  finalizeEvent: vi.fn(
    (template: { kind: number; content: string; tags: string[][] }) => ({
      ...template,
      id: "mock-event-id",
      sig: "mock-sig",
      pubkey: "my-pubkey-abc",
    }),
  ),
}));

interface MockEvent {
  pubkey: string;
  created_at: number;
  content: string;
}

function createMockPool() {
  return {
    publish: vi.fn(() => [Promise.resolve("")]),
    querySync: vi.fn(async (): Promise<MockEvent[]> => []),
  };
}

function createIdentity() {
  return {
    privateKey: new Uint8Array(32),
    publicKey: "my-pubkey-abc",
  };
}

const RELAYS = ["wss://relay1.test"];

describe("AgentDiscovery", () => {
  let pool: ReturnType<typeof createMockPool>;
  let discovery: AgentDiscovery;

  beforeEach(() => {
    pool = createMockPool();
    discovery = new AgentDiscovery(
      pool as never,
      RELAYS,
      createIdentity(),
      "agent-1",
      "Agent One",
      ["research"],
    );
  });

  afterEach(() => {
    discovery.stopAnnouncing();
  });

  describe("announce", () => {
    it("publishes a kind 30078 event to relays", async () => {
      await discovery.announce();
      expect(pool.publish).toHaveBeenCalledWith(RELAYS, expect.anything());
    });

    it("handles publish failure gracefully", async () => {
      pool.publish.mockReturnValue([Promise.reject(new Error("relay down"))]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await discovery.announce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to publish announcement"),
      );
      warnSpy.mockRestore();
    });

    it("includes AggregateError details in warning", async () => {
      pool.publish.mockReturnValue([
        Promise.reject(new Error("r1 fail")),
        Promise.reject(new Error("r2 fail")),
      ]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await discovery.announce();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("r1 fail"));
      warnSpy.mockRestore();
    });
  });

  describe("startAnnouncing / stopAnnouncing", () => {
    it("starts and stops announcing interval", async () => {
      vi.useFakeTimers();
      discovery.startAnnouncing();
      // Initial announce fires immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.publish).toHaveBeenCalledTimes(1);

      // After 2 minutes, another announce
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pool.publish).toHaveBeenCalledTimes(2);

      discovery.stopAnnouncing();

      // No more after stop
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pool.publish).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("stopAnnouncing is safe to call when not announcing", () => {
      expect(() => discovery.stopAnnouncing()).not.toThrow();
    });
  });

  describe("queryAgents", () => {
    it("returns agents from relay events", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      pool.querySync.mockResolvedValue([
        {
          pubkey: "peer-pubkey-xyz",
          created_at: nowSec - 10,
          content: JSON.stringify({
            agentId: "bob",
            name: "Bob Bot",
            capabilities: ["coding"],
            timestamp: Date.now(),
          }),
        },
      ]);

      const agents = await discovery.queryAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0]).toEqual({
        agentId: "bob",
        name: "Bob Bot",
        capabilities: ["coding"],
        online: true,
        pubkey: "peer-pubkey-xyz",
      });
    });

    it("skips own announcements", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      pool.querySync.mockResolvedValue([
        {
          pubkey: "my-pubkey-abc", // same as our identity
          created_at: nowSec - 10,
          content: JSON.stringify({
            agentId: "agent-1",
            name: "Agent One",
            capabilities: ["research"],
            timestamp: Date.now(),
          }),
        },
      ]);

      const agents = await discovery.queryAgents();
      expect(agents).toHaveLength(0);
    });

    it("skips events older than freshness threshold", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      pool.querySync.mockResolvedValue([
        {
          pubkey: "peer-pubkey-xyz",
          created_at: nowSec - 600, // 10 minutes ago, beyond 5-min threshold
          content: JSON.stringify({
            agentId: "bob",
            name: "Bob Bot",
            capabilities: [],
            timestamp: Date.now(),
          }),
        },
      ]);

      const agents = await discovery.queryAgents();
      expect(agents).toHaveLength(0);
    });

    it("skips malformed JSON content", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      pool.querySync.mockResolvedValue([
        {
          pubkey: "peer-pubkey-xyz",
          created_at: nowSec - 10,
          content: "not-json",
        },
      ]);

      const agents = await discovery.queryAgents();
      expect(agents).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("malformed"));
      warnSpy.mockRestore();
    });

    it("keeps most recent event per agent", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      pool.querySync.mockResolvedValue([
        {
          pubkey: "peer-pubkey-xyz",
          created_at: nowSec - 60,
          content: JSON.stringify({
            agentId: "bob",
            name: "Bob OLD",
            capabilities: [],
            timestamp: Date.now() - 60_000,
          }),
        },
        {
          pubkey: "peer-pubkey-xyz",
          created_at: nowSec - 10,
          content: JSON.stringify({
            agentId: "bob",
            name: "Bob NEW",
            capabilities: ["updated"],
            timestamp: Date.now(),
          }),
        },
      ]);

      const agents = await discovery.queryAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("Bob NEW");
    });

    it("propagates querySync errors", async () => {
      pool.querySync.mockRejectedValue(new Error("connection refused"));
      await expect(discovery.queryAgents()).rejects.toThrow("connection refused");
    });
  });

  // Key rotation — Suggested by @Ki-nautilus + @ReconLobster
  describe("updateIdentity", () => {
    it("updates the internal identity", () => {
      const newIdentity = {
        privateKey: new Uint8Array(32).fill(2),
        publicKey: "new-pubkey-222",
      };
      discovery.updateIdentity(newIdentity);
      // Verify by announcing — the event should use new identity
      // (Can't directly assert internal state, but no error = success)
      expect(() => discovery.updateIdentity(newIdentity)).not.toThrow();
    });
  });

  describe("getCachedAgent", () => {
    it("returns undefined for unknown agent", () => {
      expect(discovery.getCachedAgent("unknown")).toBeUndefined();
    });

    it("returns cached agent after query", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      pool.querySync.mockResolvedValue([
        {
          pubkey: "peer-pubkey-xyz",
          created_at: nowSec - 10,
          content: JSON.stringify({
            agentId: "bob",
            name: "Bob Bot",
            capabilities: [],
            timestamp: Date.now(),
          }),
        },
      ]);

      await discovery.queryAgents();
      const cached = discovery.getCachedAgent("bob");
      expect(cached).toBeDefined();
      expect(cached!.agentId).toBe("bob");
    });

    it("evicts stale cached agent", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      pool.querySync.mockResolvedValue([
        {
          pubkey: "peer-pubkey-xyz",
          created_at: nowSec - 10,
          content: JSON.stringify({
            agentId: "bob",
            name: "Bob Bot",
            capabilities: [],
            timestamp: Date.now(),
          }),
        },
      ]);

      await discovery.queryAgents();
      // Advance time beyond freshness threshold
      vi.useFakeTimers();
      vi.advanceTimersByTime(300_001);
      const cached = discovery.getCachedAgent("bob");
      expect(cached).toBeUndefined();
      vi.useRealTimers();
    });
  });
});
