import type * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

interface ProviderEvents {
  status: unknown;
  debug: unknown;
  "connection-error": unknown;
  "peer-error": unknown;
  "direct-message": [string, Uint8Array];
}

export interface ChildProvider {
  readonly peerId: string;
  readonly ready: Promise<void>;
  on(event: string, listener: (...args: never[]) => void): void;
  connect(): Promise<void>;
  disconnect(): void;
  sendToPeer(peerId: string, payload: Uint8Array): boolean;
  destroy(): void;
}

export interface ProviderContext {
  doc: Y.Doc;
  awareness: Awareness;
}

export interface ProviderDefinition {
  name: string;
  create(context: ProviderContext): ChildProvider;
}

export interface MultiProviderOptions {
  providers: ProviderDefinition[];
}

type Listener = (...args: unknown[]) => void;
export interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}
type AwarenessListener = (changes: AwarenessChanges, origin: MultiAwareness) => void;

interface Child {
  name: string;
  provider: ChildProvider;
  awareness: Awareness;
  handleAwarenessChange: AwarenessListener;
}

const FRAME_MAGIC = new Uint8Array([0x79, 0x6d, 0x70, 0x31]);
const MESSAGE_ID_LENGTH = 16;
const FRAME_HEADER_LENGTH = FRAME_MAGIC.length + MESSAGE_ID_LENGTH;
const SEEN_MESSAGE_LIMIT = 1000;

export class MultiProvider {
  readonly awareness: MultiAwareness;
  readonly ready: Promise<void>;
  private readonly children: Child[];
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly routes = new Map<string, Map<string, string>>();
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageQueue: string[] = [];
  private destroyed = false;

  constructor(
    readonly roomName: string,
    readonly doc: Y.Doc,
    options: MultiProviderOptions,
  ) {
    if (options.providers.length === 0) {
      throw new Error("MultiProvider requires at least one provider");
    }
    const names = new Set(options.providers.map(({ name }) => name));
    if (names.size !== options.providers.length) {
      throw new Error("MultiProvider provider names must be unique");
    }
    this.awareness = new MultiAwareness(doc.clientID, (state) => this.publishLocalAwareness(state));
    this.children = options.providers.map((definition) => {
      const awareness = new Awareness(doc);
      const provider = definition.create({ doc, awareness });
      const child: Child = {
        name: definition.name,
        provider,
        awareness,
        handleAwarenessChange: () => this.handleAwarenessChange(),
      };
      awareness.on("change", child.handleAwarenessChange);
      this.attachProvider(child);
      return child;
    });
    this.ready = Promise.any(this.children.map(({ provider }) => provider.ready)).then(
      () => undefined,
    );
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  async connect(): Promise<void> {
    await Promise.any(this.children.map(({ provider }) => provider.connect()));
  }

  disconnect(): void {
    for (const child of this.children) child.provider.disconnect();
  }

  sendToPeer(peerId: string, payload: Uint8Array): boolean {
    const routes = this.routes.get(peerId);
    if (!routes) return false;

    const frame = createFrame(payload);
    let sent = false;
    for (const child of this.children) {
      const transportPeerId = routes.get(child.name);
      if (transportPeerId) sent = child.provider.sendToPeer(transportPeerId, frame) || sent;
    }
    return sent;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.awareness.setLocalState(null);
    for (const child of this.children) {
      child.awareness.off("change", child.handleAwarenessChange);
      child.provider.destroy();
      child.awareness.destroy();
    }
    this.awareness.destroy();
    this.listeners.clear();
    this.routes.clear();
  }

  private attachProvider(child: Child): void {
    child.provider.on("status", ((event: ProviderEvents["status"]) => {
      this.emit("status", { provider: child.name, event });
    }) as (...args: never[]) => void);
    child.provider.on("debug", ((event: ProviderEvents["debug"]) => {
      this.emit("debug", { provider: child.name, event });
    }) as (...args: never[]) => void);
    child.provider.on("connection-error", ((event: ProviderEvents["connection-error"]) => {
      this.emit("connection-error", { provider: child.name, event });
    }) as (...args: never[]) => void);
    child.provider.on("peer-error", ((event: ProviderEvents["peer-error"]) => {
      this.emit("peer-error", { provider: child.name, event });
    }) as (...args: never[]) => void);
    child.provider.on("direct-message", ((transportPeerId: string, frame: Uint8Array) => {
      this.handleDirectMessage(child.name, transportPeerId, frame);
    }) as (...args: never[]) => void);
  }

  private handleDirectMessage(
    providerName: string,
    transportPeerId: string,
    frame: Uint8Array,
  ): void {
    const decoded = decodeFrame(frame);
    if (!decoded || this.seenMessageIds.has(decoded.id)) return;
    this.rememberMessage(decoded.id);

    const peerId = this.findLogicalPeerId(providerName, transportPeerId);
    if (peerId) this.emit("direct-message", peerId, decoded.payload);
  }

  private rememberMessage(id: string): void {
    this.seenMessageIds.add(id);
    this.seenMessageQueue.push(id);
    if (this.seenMessageQueue.length <= SEEN_MESSAGE_LIMIT) return;
    this.seenMessageIds.delete(this.seenMessageQueue.shift()!);
  }

  private findLogicalPeerId(providerName: string, transportPeerId: string): string | null {
    for (const [peerId, routes] of this.routes) {
      if (routes.get(providerName) === transportPeerId) return peerId;
    }
    return null;
  }

  private publishLocalAwareness(state: Record<string, unknown> | null): void {
    for (const child of this.children ?? []) {
      child.awareness.setLocalState(
        state
          ? {
              ...state,
              transportPeerId: child.provider.peerId,
              transport: child.name,
            }
          : null,
      );
    }
  }

  private handleAwarenessChange(): void {
    const states = new Map<number, Record<string, unknown>>();
    const routes = new Map<string, Map<string, string>>();
    let stateId = 1;
    const nextStateId = (): number => {
      while (stateId === this.doc.clientID || states.has(stateId)) stateId++;
      return stateId++;
    };

    for (const child of this.children) {
      for (const [clientId, state] of child.awareness.getStates()) {
        if (clientId === this.doc.clientID) continue;
        const peerId = state["peerId"];
        const transportPeerId = state["transportPeerId"];
        if (typeof peerId !== "string" || typeof transportPeerId !== "string") continue;
        const peerRoutes = routes.get(peerId) ?? new Map<string, string>();
        peerRoutes.set(child.name, transportPeerId);
        routes.set(peerId, peerRoutes);
        if (![...states.values()].some((candidate) => candidate["peerId"] === peerId)) {
          states.set(nextStateId(), { ...state, peerId });
        }
      }
    }

    this.routes.clear();
    for (const [peerId, peerRoutes] of routes) this.routes.set(peerId, peerRoutes);
    this.awareness.replaceRemoteStates(states);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

export class MultiAwareness {
  private localState: Record<string, unknown> | null = null;
  private remoteStates = new Map<number, Record<string, unknown>>();
  private readonly listeners = new Set<AwarenessListener>();

  constructor(
    readonly clientID: number,
    private readonly publishLocalState: (state: Record<string, unknown> | null) => void,
  ) {}

  getStates(): Map<number, Record<string, unknown>> {
    const states = new Map(this.remoteStates);
    if (this.localState) states.set(this.clientID, this.localState);
    return states;
  }

  getLocalState(): Record<string, unknown> | null {
    return this.localState;
  }

  setLocalState(state: Record<string, unknown> | null): void {
    const hadLocalState = this.localState !== null;
    this.localState = state;
    this.publishLocalState(state);
    this.emitChange({
      added: !hadLocalState && state ? [this.clientID] : [],
      updated: hadLocalState && state ? [this.clientID] : [],
      removed: hadLocalState && !state ? [this.clientID] : [],
    });
  }

  setLocalStateField(field: string, value: unknown): void {
    this.setLocalState({ ...this.localState, [field]: value });
  }

  on(event: "change", listener: AwarenessListener): void {
    if (event === "change") this.listeners.add(listener);
  }

  off(event: "change", listener: AwarenessListener): void {
    if (event === "change") this.listeners.delete(listener);
  }

  replaceRemoteStates(states: Map<number, Record<string, unknown>>): void {
    const previousIds = new Set(this.remoteStates.keys());
    const nextIds = new Set(states.keys());
    const added = [...nextIds].filter((id) => !previousIds.has(id));
    const updated = [...nextIds].filter((id) => previousIds.has(id));
    const removed = [...previousIds].filter((id) => !nextIds.has(id));
    this.remoteStates = states;
    if (added.length || updated.length || removed.length) {
      this.emitChange({ added, updated, removed });
    }
  }

  destroy(): void {
    this.listeners.clear();
    this.remoteStates.clear();
  }

  private emitChange(changes: AwarenessChanges): void {
    for (const listener of this.listeners) listener(changes, this);
  }
}

function createFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_LENGTH + payload.length);
  frame.set(FRAME_MAGIC);
  crypto.getRandomValues(frame.subarray(FRAME_MAGIC.length, FRAME_HEADER_LENGTH));
  frame.set(payload, FRAME_HEADER_LENGTH);
  return frame;
}

function decodeFrame(frame: Uint8Array): { id: string; payload: Uint8Array } | null {
  if (
    frame.length < FRAME_HEADER_LENGTH ||
    FRAME_MAGIC.some((byte, index) => frame[index] !== byte)
  ) {
    return null;
  }
  const id = Array.from(frame.subarray(FRAME_MAGIC.length, FRAME_HEADER_LENGTH), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { id, payload: frame.subarray(FRAME_HEADER_LENGTH) };
}
