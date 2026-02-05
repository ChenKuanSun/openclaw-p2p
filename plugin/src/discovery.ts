import { finalizeEvent } from "nostr-tools/pure";
import type { SimplePool } from "nostr-tools/pool";
import type { NostrIdentity, AgentInfo } from "./types.js";

const ANNOUNCE_KIND = 30078;
const ANNOUNCE_TAG = "openclaw-p2p";
const ANNOUNCE_INTERVAL_MS = 120_000; // 2 minutes
const FRESHNESS_THRESHOLD_MS = 300_000; // 5 minutes
const QUERY_TIMEOUT_MS = 10_000;

interface AnnouncementContent {
  agentId: string;
  name: string;
  capabilities: string[];
  timestamp: number;
}

export class AgentDiscovery {
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private knownAgents = new Map<string, AgentInfo & { lastSeen: number }>();

  constructor(
    private pool: SimplePool,
    private relays: string[],
    private identity: NostrIdentity,
    private agentId: string,
    private agentName: string,
    private capabilities: string[],
  ) {}

  async announce(): Promise<void> {
    const content: AnnouncementContent = {
      agentId: this.agentId,
      name: this.agentName,
      capabilities: this.capabilities,
      timestamp: Date.now(),
    };

    const event = finalizeEvent(
      {
        kind: ANNOUNCE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["d", this.agentId],
          ["t", ANNOUNCE_TAG],
        ],
        content: JSON.stringify(content),
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
      console.warn(`[p2p] Failed to publish announcement to any relay: ${details}`);
    }
  }

  startAnnouncing(): void {
    this.announce().catch((err) => console.error("[p2p] Initial announce failed:", err));
    this.announceTimer = setInterval(
      () => this.announce().catch((err) => console.error("[p2p] Announce failed:", err)),
      ANNOUNCE_INTERVAL_MS,
    );
  }

  stopAnnouncing(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
  }

  async queryAgents(): Promise<AgentInfo[]> {
    let timer: ReturnType<typeof setTimeout>;
    const events = await Promise.race([
      this.pool.querySync(this.relays, {
        kinds: [ANNOUNCE_KIND],
        "#t": [ANNOUNCE_TAG],
        since: Math.floor((Date.now() - FRESHNESS_THRESHOLD_MS) / 1000),
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("querySync timeout")), QUERY_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer!));

    const now = Date.now();
    const agentMap = new Map<string, AgentInfo>();

    for (const event of events) {
      // Skip our own announcements
      if (event.pubkey === this.identity.publicKey) continue;

      let content: AnnouncementContent;
      try {
        content = JSON.parse(event.content);
      } catch {
        console.warn("[p2p] Skipping malformed announcement event");
        continue;
      }

      const eventAge = now - event.created_at * 1000;
      if (eventAge > FRESHNESS_THRESHOLD_MS) continue;

      // Keep only the most recent event per agent
      const existing = agentMap.get(content.agentId);
      if (existing) {
        const existingEntry = this.knownAgents.get(content.agentId);
        if (existingEntry && existingEntry.lastSeen >= event.created_at * 1000) {
          continue;
        }
      }

      const info: AgentInfo = {
        agentId: content.agentId,
        name: content.name,
        capabilities: content.capabilities,
        online: true,
        pubkey: event.pubkey,
      };
      agentMap.set(content.agentId, info);
      this.knownAgents.set(content.agentId, {
        ...info,
        lastSeen: event.created_at * 1000,
      });
    }

    return Array.from(agentMap.values());
  }

  getCachedAgent(agentId: string): (AgentInfo & { lastSeen: number }) | undefined {
    const agent = this.knownAgents.get(agentId);
    if (!agent) return undefined;
    if (Date.now() - agent.lastSeen > FRESHNESS_THRESHOLD_MS) {
      this.knownAgents.delete(agentId);
      return undefined;
    }
    return agent;
  }
}
