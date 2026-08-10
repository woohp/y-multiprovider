import { equalityDeep } from "lib0/function";
import type * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

export interface ChildProviderEvents {
  status: (event: unknown) => void;
  synced: (synced: boolean) => void;
  peers: (peerIds: readonly string[]) => void;
  debug: (event: unknown) => void;
  "connection-error": (event: unknown) => void;
  "peer-error": (event: unknown) => void;
  "direct-message": (peerId: string, payload: Uint8Array) => void;
}

type ChildProviderEventName = keyof ChildProviderEvents & string;

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

export interface MultiProviderEvents {
  status: (event: { provider: string; event: unknown }) => void;
  synced: (event: { provider: string; synced: boolean }) => void;
  peers: (event: { provider: string; peerIds: readonly string[] }) => void;
  debug: (event: { provider: string; event: unknown }) => void;
  "connection-error": (event: { provider: string; event: unknown }) => void;
  "peer-error": (event: { provider: string; event: unknown }) => void;
  "direct-message": (peerId: string, payload: Uint8Array) => void;
  "peer-change": (event: LogicalPeerChange) => void;
}

export interface LogicalPeerChange {
  peerId: string;
  connected: boolean;
  transports: readonly string[];
}

type MultiProviderEventName = keyof MultiProviderEvents & string;
type Listener = (...args: unknown[]) => void;

export interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

type AwarenessListener = (changes: AwarenessChanges, origin: MultiAwareness) => void;

type AwarenessEventName = "change" | "update";

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
  private readonly stateIds = new Map<string, number>();
  private readonly allocatedStateIds = new Set<number>();
  private nextStateId = 1;
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

  on<Name extends MultiProviderEventName>(event: Name, listener: MultiProviderEvents[Name]): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener as unknown as Listener);
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
    this.stateIds.clear();
    this.allocatedStateIds.clear();
  }

  private attachProvider(child: Child): void {
    this.onChildProviderEvent(child, "status", (event) => {
      this.emit("status", { provider: child.name, event });
    });
    this.onChildProviderEvent(child, "synced", (synced) => {
      this.emit("synced", { provider: child.name, synced });
    });
    this.onChildProviderEvent(child, "peers", (peerIds) => {
      this.emit("peers", { provider: child.name, peerIds });
    });
    this.onChildProviderEvent(child, "debug", (event) => {
      this.emit("debug", { provider: child.name, event });
    });
    this.onChildProviderEvent(child, "connection-error", (event) => {
      this.emit("connection-error", { provider: child.name, event });
    });
    this.onChildProviderEvent(child, "peer-error", (event) => {
      this.emit("peer-error", { provider: child.name, event });
    });
    this.onChildProviderEvent(child, "direct-message", (transportPeerId, frame) => {
      this.handleDirectMessage(child.name, transportPeerId, frame);
    });
  }

  private onChildProviderEvent<Name extends ChildProviderEventName>(
    child: Child,
    event: Name,
    listener: ChildProviderEvents[Name],
  ): void {
    child.provider.on(event, listener as (...args: never[]) => void);
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
    const previousRoutes = cloneRoutes(this.routes);
    const states = new Map<number, Record<string, unknown>>();
    const routes = new Map<string, Map<string, string>>();
    const seenPeerIds = new Set<string>();

    for (const child of this.children) {
      for (const [clientId, state] of child.awareness.getStates()) {
        if (clientId === this.doc.clientID) continue;
        const peerId = state["peerId"];
        const transportPeerId = state["transportPeerId"];
        if (typeof peerId !== "string" || typeof transportPeerId !== "string") continue;

        const peerRoutes = routes.get(peerId) ?? new Map<string, string>();
        peerRoutes.set(child.name, transportPeerId);
        routes.set(peerId, peerRoutes);

        if (!seenPeerIds.has(peerId)) {
          seenPeerIds.add(peerId);
          states.set(this.getStateId(peerId), { ...state, peerId });
        }
      }
    }

    this.routes.clear();
    for (const [peerId, peerRoutes] of routes) this.routes.set(peerId, peerRoutes);
    this.awareness.replaceRemoteStates(states);
    this.emitPeerChanges(previousRoutes, routes);
  }

  private getStateId(peerId: string): number {
    const existing = this.stateIds.get(peerId);
    if (existing !== undefined) return existing;

    let stateId = this.nextStateId;
    while (stateId === this.doc.clientID || this.allocatedStateIds.has(stateId)) stateId++;
    this.nextStateId = stateId + 1;
    this.stateIds.set(peerId, stateId);
    this.allocatedStateIds.add(stateId);
    return stateId;
  }

  private emitPeerChanges(
    previousRoutes: Map<string, Map<string, string>>,
    nextRoutes: Map<string, Map<string, string>>,
  ): void {
    const peerIds = new Set([...previousRoutes.keys(), ...nextRoutes.keys()]);
    for (const peerId of peerIds) {
      const previous = previousRoutes.get(peerId);
      const next = nextRoutes.get(peerId);
      if ((previous !== undefined) === (next !== undefined)) continue;
      this.emit("peer-change", {
        peerId,
        connected: next !== undefined,
        transports: next ? [...next.keys()] : [],
      });
    }
  }

  private emit<Name extends MultiProviderEventName>(
    event: Name,
    ...args: Parameters<MultiProviderEvents[Name]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

export class MultiAwareness {
  private localState: Record<string, unknown> | null = null;
  private remoteStates = new Map<number, Record<string, unknown>>();
  private readonly listeners = new Map<AwarenessEventName, Set<AwarenessListener>>([
    ["change", new Set()],
    ["update", new Set()],
  ]);

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
    const previousState = this.localState;
    this.localState = state;
    this.publishLocalState(state);

    const changes: AwarenessChanges = {
      added: previousState === null && state !== null ? [this.clientID] : [],
      updated:
        previousState !== null && state !== null && !equalityDeep(previousState, state)
          ? [this.clientID]
          : [],
      removed: previousState !== null && state === null ? [this.clientID] : [],
    };
    this.emitChanges(changes);
  }

  setLocalStateField(field: string, value: unknown): void {
    if (this.localState === null) return;
    this.setLocalState({ ...this.localState, [field]: value });
  }

  on(event: AwarenessEventName, listener: AwarenessListener): void {
    this.listeners.get(event)?.add(listener);
  }

  off(event: AwarenessEventName, listener: AwarenessListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  replaceRemoteStates(states: Map<number, Record<string, unknown>>): void {
    const added: number[] = [];
    const updated: number[] = [];
    const removed: number[] = [];

    for (const [clientId, state] of states) {
      const previousState = this.remoteStates.get(clientId);
      if (previousState === undefined) added.push(clientId);
      else if (!equalityDeep(previousState, state)) updated.push(clientId);
    }
    for (const clientId of this.remoteStates.keys()) {
      if (!states.has(clientId)) removed.push(clientId);
    }

    this.remoteStates = new Map(states);
    this.emitChanges({ added, updated, removed });
  }

  destroy(): void {
    this.listeners.forEach((listeners) => listeners.clear());
    this.remoteStates.clear();
  }

  private emitChanges(changes: AwarenessChanges): void {
    if (changes.added.length || changes.updated.length || changes.removed.length) {
      for (const listener of this.listeners.get("change") ?? []) listener(changes, this);
    }
    for (const listener of this.listeners.get("update") ?? []) listener(changes, this);
  }
}

function cloneRoutes(routes: Map<string, Map<string, string>>): Map<string, Map<string, string>> {
  return new Map([...routes].map(([peerId, peerRoutes]) => [peerId, new Map(peerRoutes)] as const));
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
