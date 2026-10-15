import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { MultiProvider, type ProviderDefinition } from "../src/multiProvider.js";

interface FakeProviderOptions {
  ready?: Promise<void>;
  connect?: () => Promise<void>;
  sendResult?: boolean;
}

class FakeProvider {
  readonly peerId: string;
  readonly sent: Array<{ peerId: string; payload: Uint8Array }> = [];
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly ready: Promise<void>;
  connectCalls = 0;
  disconnectCalls = 0;
  destroyCalls = 0;

  constructor(
    readonly name: string,
    readonly awareness: Awareness,
    private readonly options: FakeProviderOptions = {},
  ) {
    this.peerId = `${name}-local`;
    this.ready = options.ready ?? Promise.resolve();
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.handlers.set(event, listeners);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) listener(...args);
  }

  connect(): Promise<void> {
    this.connectCalls++;
    return this.options.connect?.() ?? Promise.resolve();
  }

  disconnect(): void {
    this.disconnectCalls++;
  }

  sendToPeer(peerId: string, payload: Uint8Array): boolean {
    this.sent.push({ peerId, payload });
    return this.options.sendResult ?? true;
  }

  destroy(): void {
    this.destroyCalls++;
  }
}

/** A remote MultiProvider session: one awareness client ID shared by all of its transports. */
class RemotePeer {
  private readonly awareness = new Awareness(createDoc());

  constructor(readonly peerId: string) {}

  publish(target: FakeProvider, fields: Record<string, unknown> = {}, clock = 1): void {
    this.send(target, {
      peerId: this.peerId,
      transportPeerId: `${target.name}-remote`,
      multiproviderClock: clock,
      ...fields,
    });
  }

  leave(target: FakeProvider): void {
    this.send(target, null);
  }

  private send(target: FakeProvider, state: Record<string, unknown> | null): void {
    // Setting the state advances the awareness clock, so the target always accepts the update.
    this.awareness.setLocalState(state);
    applyAwarenessUpdate(
      target.awareness,
      encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
      "test",
    );
  }
}

const docs: Y.Doc[] = [];

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

function createDoc(): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  return doc;
}

function createDefinition(
  name: string,
  instances: FakeProvider[],
  options?: FakeProviderOptions,
): ProviderDefinition {
  return {
    name,
    create: ({ awareness }) => {
      const provider = new FakeProvider(name, awareness, options);
      instances.push(provider);
      return provider;
    },
  };
}

function createTwoProviderSetup(
  firstOptions?: FakeProviderOptions,
  secondOptions?: FakeProviderOptions,
): { provider: MultiProvider; first: FakeProvider; second: FakeProvider } {
  const instances: FakeProvider[] = [];
  const provider = new MultiProvider(createDoc(), {
    providers: [
      createDefinition("first", instances, firstOptions),
      createDefinition("second", instances, secondOptions),
    ],
  });
  return { provider, first: instances[0]!, second: instances[1]! };
}

function waitForClockTick(): Promise<void> {
  // lib0 captures Date.now at import, so fake timers cannot advance awareness timestamps.
  return new Promise((resolve) => setTimeout(resolve, 2));
}

function peerState(
  provider: MultiProvider,
  peerId: string,
): [number, Record<string, unknown>] | undefined {
  return [...provider.awareness.getStates()].find(([, state]) => state["peerId"] === peerId);
}

describe("MultiProvider", () => {
  it("rejects empty and duplicate provider definitions", () => {
    const doc = createDoc();
    expect(() => new MultiProvider(doc, { providers: [] })).toThrow(
      "requires at least one provider",
    );

    const instances: FakeProvider[] = [];
    expect(
      () =>
        new MultiProvider(doc, {
          providers: [createDefinition("same", instances), createDefinition("same", instances)],
        }),
    ).toThrow("provider names must be unique");
  });

  it("becomes ready when the first provider is ready", async () => {
    const { provider } = createTwoProviderSetup(
      { ready: Promise.resolve() },
      { ready: new Promise(() => {}) },
    );

    await expect(provider.ready).resolves.toBeUndefined();
  });

  it("still becomes ready when one provider fails", async () => {
    const { provider } = createTwoProviderSetup(
      { ready: Promise.reject(new Error("offline")) },
      { ready: Promise.resolve() },
    );

    await expect(provider.ready).resolves.toBeUndefined();
  });

  it("connects through the first successful provider and disconnects and destroys all", async () => {
    const { provider, first, second } = createTwoProviderSetup({
      connect: () => Promise.reject(new Error("offline")),
    });

    new RemotePeer("player-b").publish(first);

    await expect(provider.connect()).resolves.toBeUndefined();
    provider.disconnect();
    provider.destroy();
    provider.destroy();

    expect(provider.sendToPeer("player-b", new Uint8Array([1]))).toBe(false);
    for (const instance of [first, second]) {
      expect(instance).toMatchObject({
        connectCalls: 1,
        disconnectCalls: 1,
        destroyCalls: 1,
        sent: [],
      });
    }
  });

  it("publishes local awareness through every provider", () => {
    const { provider, first, second } = createTwoProviderSetup();

    provider.awareness.setLocalState({ peerId: "player-a" });

    const firstState = first.awareness.getLocalState();
    expect(firstState).toEqual({
      peerId: "player-a",
      transportPeerId: "first-local",
      multiproviderClock: expect.any(Number),
    });
    expect(second.awareness.getLocalState()).toEqual({
      ...firstState,
      transportPeerId: "second-local",
    });

    provider.awareness.setLocalState(null);
    expect(first.awareness.getLocalState()).toBeNull();
    expect(second.awareness.getLocalState()).toBeNull();
  });

  it("keeps one stable logical peer until every route disappears", () => {
    const { provider, first, second } = createTwoProviderSetup();
    provider.awareness.setLocalState({ peerId: "player-a" });
    const awarenessChanges = vi.fn();
    const peerChanges = vi.fn();
    provider.awareness.on("change", awarenessChanges);
    provider.on("peer-change", peerChanges);
    const remote = new RemotePeer("player-b");

    remote.publish(first);
    const [stateId, state] = peerState(provider, "player-b")!;
    expect(state).toEqual({ peerId: "player-b" });

    remote.publish(second);
    remote.leave(first);
    expect(peerState(provider, "player-b")).toEqual([stateId, state]);

    remote.leave(second);
    expect(peerState(provider, "player-b")).toBeUndefined();
    expect(peerChanges.mock.calls).toEqual([
      [{ peerId: "player-b", connected: true, transports: ["first"] }],
      [{ peerId: "player-b", connected: false, transports: [] }],
    ]);

    // A later rebuild neither re-removes the departed peer nor touches the local state.
    new RemotePeer("player-c").publish(first);
    const [otherStateId] = peerState(provider, "player-c")!;
    expect(awarenessChanges.mock.calls).toEqual([
      [{ added: [stateId], updated: [], removed: [] }, "test"],
      [{ added: [], updated: [], removed: [stateId] }, "test"],
      [{ added: [otherStateId], updated: [], removed: [] }, "test"],
    ]);
  });

  it("selects the newest revision regardless of delivery order", () => {
    const { provider, first, second } = createTwoProviderSetup();
    const changes = vi.fn();
    const updates = vi.fn();
    provider.awareness.on("change", changes);
    provider.awareness.on("update", updates);
    const remote = new RemotePeer("player-c");

    remote.publish(second, { cursor: "new" }, 2);
    const [stateId] = peerState(provider, "player-c")!;
    remote.publish(first, { cursor: "old" }, 1);
    expect(peerState(provider, "player-c")?.[1]).toEqual({ peerId: "player-c", cursor: "new" });
    expect(changes).toHaveBeenCalledTimes(1);

    remote.publish(first, { cursor: "new" }, 2);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenLastCalledWith(
      { added: [], updated: [stateId], removed: [] },
      "test",
    );

    remote.publish(first, { cursor: "newest" }, 3);
    expect(peerState(provider, "player-c")?.[1]).toEqual({ peerId: "player-c", cursor: "newest" });
    expect(changes).toHaveBeenLastCalledWith(
      { added: [], updated: [stateId], removed: [] },
      "test",
    );
  });

  it("prefers the most recently updated session when a peer reloads", async () => {
    const { provider, first, second } = createTwoProviderSetup();

    // The old session lingers on the first transport until it times out.
    new RemotePeer("player-d").publish(first, { session: "old" }, 5);
    await waitForClockTick();
    new RemotePeer("player-d").publish(second, { session: "new" }, 1);

    expect(peerState(provider, "player-d")?.[1]).toEqual({ peerId: "player-d", session: "new" });
  });

  it("renews merged peers while any route renews", async () => {
    const { provider, first } = createTwoProviderSetup();
    const remote = new RemotePeer("player-b");
    remote.publish(first);
    const [stateId] = peerState(provider, "player-b")!;
    const { lastUpdated } = provider.awareness.meta.get(stateId)!;

    await waitForClockTick();
    remote.publish(first);

    expect(provider.awareness.meta.get(stateId)!.lastUpdated).toBeGreaterThan(lastUpdated);
  });

  it("sends through all routes and succeeds when only one transport accepts the message", () => {
    const { provider, first, second } = createTwoProviderSetup(
      { sendResult: false },
      { sendResult: true },
    );
    const remote = new RemotePeer("player-b");
    remote.publish(first);
    remote.publish(second);

    expect(provider.sendToPeer("missing", new Uint8Array([1]))).toBe(false);
    expect(provider.sendToPeer("player-b", new Uint8Array([1, 2, 3]))).toBe(true);
    expect(first.sent.map(({ peerId }) => peerId)).toEqual(["first-remote"]);
    expect(second.sent.map(({ peerId }) => peerId)).toEqual(["second-remote"]);
    expect(first.sent[0]!.payload).toEqual(second.sent[0]!.payload);
  });

  it("deduplicates directed messages received through multiple providers", () => {
    const { provider, first, second } = createTwoProviderSetup();
    const remote = new RemotePeer("player-b");
    remote.publish(first);
    remote.publish(second);
    provider.sendToPeer("player-b", new Uint8Array([4, 5, 6]));
    const frame = first.sent[0]!.payload;
    const handleMessage = vi.fn();
    provider.on("direct-message", handleMessage);

    first.emit("direct-message", "first-remote", frame);
    second.emit("direct-message", "second-remote", frame);

    expect(handleMessage.mock.calls).toEqual([["player-b", new Uint8Array([4, 5, 6])]]);
  });

  it("ignores malformed frames and unknown senders without dropping a known copy", () => {
    const { provider, first } = createTwoProviderSetup();
    new RemotePeer("player-b").publish(first);
    provider.sendToPeer("player-b", new Uint8Array([7]));
    const validFrame = first.sent[0]!.payload;
    const handleMessage = vi.fn();
    provider.on("direct-message", handleMessage);

    first.emit("direct-message", "first-remote", new Uint8Array([1, 2, 3]));
    first.emit("direct-message", "unknown", validFrame);
    first.emit("direct-message", "first-remote", validFrame);

    expect(handleMessage.mock.calls).toEqual([["player-b", new Uint8Array([7])]]);
  });

  it("forwards child events tagged with the provider name", () => {
    const { provider, first, second } = createTwoProviderSetup();
    const events = vi.fn();
    provider.on("status", events);
    provider.on("synced", events);
    provider.on("peers", events);
    provider.on("connection-error", events);
    const error = new Error("failed");

    first.emit("status", { status: "connected" });
    first.emit("synced", true);
    second.emit("peers", ["remote-peer"]);
    second.emit("connection-error", error);

    expect(events.mock.calls).toEqual([
      [{ provider: "first", event: { status: "connected" } }],
      [{ provider: "first", synced: true }],
      [{ provider: "second", peerIds: ["remote-peer"] }],
      [{ provider: "second", event: error }],
    ]);
  });
});
