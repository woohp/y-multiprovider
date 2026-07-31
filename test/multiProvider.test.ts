import { describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { MultiProvider, type ProviderDefinition } from "../src/multiProvider.js";

class FakeProvider {
  readonly ready = Promise.resolve();
  readonly sent: Array<{ peerId: string; payload: Uint8Array }> = [];
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  destroyed = false;

  constructor(
    readonly peerId: string,
    readonly awareness: Awareness,
  ) {}

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.handlers.set(event, listeners);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) listener(...args);
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {}

  sendToPeer(peerId: string, payload: Uint8Array): boolean {
    this.sent.push({ peerId, payload });
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function createDefinition(name: string, instances: FakeProvider[]): ProviderDefinition {
  return {
    name,
    create: ({ awareness }) => {
      const provider = new FakeProvider(`${name}-local`, awareness);
      instances.push(provider);
      return provider;
    },
  };
}

function addRemoteAwareness(
  target: Awareness,
  peerId: string,
  transportPeerId: string,
  transport: string,
): void {
  const remoteDoc = new Y.Doc();
  const remoteAwareness = new Awareness(remoteDoc);
  remoteAwareness.setLocalState({ peerId, transportPeerId, transport });
  applyAwarenessUpdate(
    target,
    encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
    "test",
  );
  remoteAwareness.destroy();
  remoteDoc.destroy();
}

describe("MultiProvider", () => {
  it("publishes local awareness through every provider", () => {
    const instances: FakeProvider[] = [];
    const doc = new Y.Doc();
    const provider = new MultiProvider("room", doc, {
      providers: [createDefinition("nostr", instances), createDefinition("webtorrent", instances)],
    });

    provider.awareness.setLocalState({ peerId: "player-a" });

    expect(instances[0]!.awareness.getLocalState()).toEqual({
      peerId: "player-a",
      transport: "nostr",
      transportPeerId: "nostr-local",
    });
    expect(instances[1]!.awareness.getLocalState()).toEqual({
      peerId: "player-a",
      transport: "webtorrent",
      transportPeerId: "webtorrent-local",
    });

    provider.destroy();
    doc.destroy();
  });

  it("merges presence and sends directed messages over every available route", () => {
    const instances: FakeProvider[] = [];
    const doc = new Y.Doc();
    const provider = new MultiProvider("room", doc, {
      providers: [createDefinition("nostr", instances), createDefinition("webtorrent", instances)],
    });
    const handleChange = vi.fn();
    provider.awareness.on("change", handleChange);

    addRemoteAwareness(instances[0]!.awareness, "player-b", "nostr-remote", "nostr");
    addRemoteAwareness(instances[1]!.awareness, "player-b", "webtorrent-remote", "webtorrent");

    expect(
      [...provider.awareness.getStates().values()].filter(
        (state) => state["peerId"] === "player-b",
      ),
    ).toHaveLength(1);
    expect(handleChange).toHaveBeenCalled();
    expect(provider.sendToPeer("player-b", new Uint8Array([1, 2, 3]))).toBe(true);
    expect(instances[0]!.sent[0]!.peerId).toBe("nostr-remote");
    expect(instances[1]!.sent[0]!.peerId).toBe("webtorrent-remote");
    expect(instances[0]!.sent[0]!.payload).toEqual(instances[1]!.sent[0]!.payload);

    provider.destroy();
    doc.destroy();
  });

  it("deduplicates directed messages received through multiple providers", () => {
    const instances: FakeProvider[] = [];
    const doc = new Y.Doc();
    const provider = new MultiProvider("room", doc, {
      providers: [createDefinition("nostr", instances), createDefinition("webtorrent", instances)],
    });
    addRemoteAwareness(instances[0]!.awareness, "player-b", "nostr-remote", "nostr");
    addRemoteAwareness(instances[1]!.awareness, "player-b", "webtorrent-remote", "webtorrent");
    provider.sendToPeer("player-b", new Uint8Array([4, 5, 6]));
    const frame = instances[0]!.sent[0]!.payload;
    const handleMessage = vi.fn();
    provider.on("direct-message", handleMessage);

    instances[0]!.emit("direct-message", "nostr-remote", frame);
    instances[1]!.emit("direct-message", "webtorrent-remote", frame);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith("player-b", new Uint8Array([4, 5, 6]));

    provider.destroy();
    doc.destroy();
  });
});
