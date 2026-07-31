import { describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { MultiProvider, type ProviderDefinition } from "../src/multiProvider.js";

interface FakeProviderOptions {
  ready?: Promise<void>;
  connect?: () => Promise<void>;
  sendResult?: boolean;
}

class FakeProvider {
  readonly sent: Array<{ peerId: string; payload: Uint8Array }> = [];
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly ready: Promise<void>;
  connectCalls = 0;
  disconnectCalls = 0;
  destroyCalls = 0;

  constructor(
    readonly peerId: string,
    readonly awareness: Awareness,
    private readonly options: FakeProviderOptions = {},
  ) {
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

function createDefinition(
  name: string,
  instances: FakeProvider[],
  options?: FakeProviderOptions,
): ProviderDefinition {
  return {
    name,
    create: ({ awareness }) => {
      const provider = new FakeProvider(`${name}-local`, awareness, options);
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
): () => void {
  const remoteDoc = new Y.Doc();
  const remoteAwareness = new Awareness(remoteDoc);
  const apply = (): void => {
    applyAwarenessUpdate(
      target,
      encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]),
      "test",
    );
  };
  remoteAwareness.setLocalState({ peerId, transportPeerId, transport });
  apply();

  return () => {
    remoteAwareness.setLocalState(null);
    apply();
    remoteAwareness.destroy();
    remoteDoc.destroy();
  };
}

function createTwoProviderSetup(
  firstOptions?: FakeProviderOptions,
  secondOptions?: FakeProviderOptions,
): { doc: Y.Doc; provider: MultiProvider; instances: FakeProvider[] } {
  const instances: FakeProvider[] = [];
  const doc = new Y.Doc();
  const provider = new MultiProvider("room", doc, {
    providers: [
      createDefinition("first", instances, firstOptions),
      createDefinition("second", instances, secondOptions),
    ],
  });
  return { doc, provider, instances };
}

describe("MultiProvider", () => {
  it("rejects empty and duplicate provider definitions", () => {
    const doc = new Y.Doc();
    expect(() => new MultiProvider("room", doc, { providers: [] })).toThrow(
      "requires at least one provider",
    );

    const instances: FakeProvider[] = [];
    expect(
      () =>
        new MultiProvider("room", doc, {
          providers: [createDefinition("same", instances), createDefinition("same", instances)],
        }),
    ).toThrow("provider names must be unique");
    doc.destroy();
  });

  it("becomes ready when the first provider is ready", async () => {
    let resolveFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const neverReady = new Promise<void>(() => {});
    const { doc, provider } = createTwoProviderSetup({ ready: firstReady }, { ready: neverReady });

    resolveFirst();
    await expect(provider.ready).resolves.toBeUndefined();

    provider.destroy();
    doc.destroy();
  });

  it("still becomes ready when one provider fails", async () => {
    const { doc, provider } = createTwoProviderSetup(
      { ready: Promise.reject(new Error("offline")) },
      { ready: Promise.resolve() },
    );

    await expect(provider.ready).resolves.toBeUndefined();

    provider.destroy();
    doc.destroy();
  });

  it("connects through the first successful provider and disconnects all providers", async () => {
    const { doc, provider, instances } = createTwoProviderSetup(
      { connect: () => Promise.reject(new Error("offline")) },
      { connect: () => Promise.resolve() },
    );

    await expect(provider.connect()).resolves.toBeUndefined();
    provider.disconnect();

    expect(instances.map(({ connectCalls }) => connectCalls)).toEqual([1, 1]);
    expect(instances.map(({ disconnectCalls }) => disconnectCalls)).toEqual([1, 1]);

    provider.destroy();
    doc.destroy();
  });

  it("publishes local awareness through every provider", () => {
    const { doc, provider, instances } = createTwoProviderSetup();

    provider.awareness.setLocalState({ peerId: "player-a" });

    expect(provider.awareness.clientID).toBe(doc.clientID);
    expect(provider.awareness.getStates().get(doc.clientID)).toEqual({ peerId: "player-a" });

    expect(instances[0]!.awareness.getLocalState()).toEqual({
      peerId: "player-a",
      transport: "first",
      transportPeerId: "first-local",
    });
    expect(instances[1]!.awareness.getLocalState()).toEqual({
      peerId: "player-a",
      transport: "second",
      transportPeerId: "second-local",
    });

    provider.destroy();
    doc.destroy();
  });

  it("keeps merged presence until every route disappears", () => {
    const { doc, provider, instances } = createTwoProviderSetup();
    const removeFirst = addRemoteAwareness(
      instances[0]!.awareness,
      "player-b",
      "first-remote",
      "first",
    );
    const removeSecond = addRemoteAwareness(
      instances[1]!.awareness,
      "player-b",
      "second-remote",
      "second",
    );
    const remoteStates = (): Record<string, unknown>[] =>
      [...provider.awareness.getStates().values()].filter(
        (state) => state["peerId"] === "player-b",
      );

    expect(remoteStates()).toHaveLength(1);
    removeFirst();
    expect(remoteStates()).toHaveLength(1);
    removeSecond();
    expect(remoteStates()).toHaveLength(0);

    provider.destroy();
    doc.destroy();
  });

  it("sends through all routes and succeeds when only one transport accepts the message", () => {
    const { doc, provider, instances } = createTwoProviderSetup(
      { sendResult: false },
      { sendResult: true },
    );
    const removeFirst = addRemoteAwareness(
      instances[0]!.awareness,
      "player-b",
      "first-remote",
      "first",
    );
    const removeSecond = addRemoteAwareness(
      instances[1]!.awareness,
      "player-b",
      "second-remote",
      "second",
    );

    expect(provider.sendToPeer("missing", new Uint8Array([1]))).toBe(false);
    expect(provider.sendToPeer("player-b", new Uint8Array([1, 2, 3]))).toBe(true);
    expect(instances[0]!.sent[0]!.peerId).toBe("first-remote");
    expect(instances[1]!.sent[0]!.peerId).toBe("second-remote");
    expect(instances[0]!.sent[0]!.payload).toEqual(instances[1]!.sent[0]!.payload);

    removeFirst();
    removeSecond();
    provider.destroy();
    doc.destroy();
  });

  it("deduplicates directed messages received through multiple providers", () => {
    const { doc, provider, instances } = createTwoProviderSetup();
    const removeFirst = addRemoteAwareness(
      instances[0]!.awareness,
      "player-b",
      "first-remote",
      "first",
    );
    const removeSecond = addRemoteAwareness(
      instances[1]!.awareness,
      "player-b",
      "second-remote",
      "second",
    );
    provider.sendToPeer("player-b", new Uint8Array([4, 5, 6]));
    const frame = instances[0]!.sent[0]!.payload;
    const handleMessage = vi.fn();
    provider.on("direct-message", handleMessage);

    instances[0]!.emit("direct-message", "first-remote", frame);
    instances[1]!.emit("direct-message", "second-remote", frame);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith("player-b", new Uint8Array([4, 5, 6]));

    removeFirst();
    removeSecond();
    provider.destroy();
    doc.destroy();
  });

  it("ignores malformed frames and messages from unknown transport peers", () => {
    const { doc, provider, instances } = createTwoProviderSetup();
    const removeRemote = addRemoteAwareness(
      instances[0]!.awareness,
      "player-b",
      "first-remote",
      "first",
    );
    provider.sendToPeer("player-b", new Uint8Array([7]));
    const validFrame = instances[0]!.sent[0]!.payload;
    const handleMessage = vi.fn();
    provider.on("direct-message", handleMessage);

    instances[0]!.emit("direct-message", "first-remote", new Uint8Array([1, 2, 3]));
    instances[0]!.emit("direct-message", "unknown", validFrame);

    expect(handleMessage).not.toHaveBeenCalled();

    removeRemote();
    provider.destroy();
    doc.destroy();
  });

  it("tags child events and destroys every provider once", () => {
    const { doc, provider, instances } = createTwoProviderSetup();
    const handleStatus = vi.fn();
    const handleError = vi.fn();
    provider.on("status", handleStatus);
    provider.on("connection-error", handleError);

    instances[0]!.emit("status", { status: "connected" });
    instances[1]!.emit("connection-error", new Error("failed"));

    expect(handleStatus).toHaveBeenCalledWith({
      provider: "first",
      event: { status: "connected" },
    });
    expect(handleError).toHaveBeenCalledWith({
      provider: "second",
      event: expect.any(Error),
    });

    provider.destroy();
    provider.destroy();
    expect(instances.map(({ destroyCalls }) => destroyCalls)).toEqual([1, 1]);
    doc.destroy();
  });
});
