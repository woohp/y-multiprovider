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

type ChildAwarenessListener = (changes: AwarenessChanges, origin: unknown) => void;

interface Child {
  name: string;
  provider: ChildProvider;
  awareness: Awareness;
  handleAwarenessUpdate: ChildAwarenessListener;
  remotePeerIds: Map<number, string>;
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
  private logicalAwarenessClock = 0;
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
    this.awareness = new MultiAwareness(doc, (state) => this.publishLocalAwareness(state));
    this.children = options.providers.map((definition) => {
      const awareness = new Awareness(doc);
      const provider = definition.create({ doc, awareness });
      const child: Child = {
        name: definition.name,
        provider,
        awareness,
        handleAwarenessUpdate: (changes, origin) =>
          this.handleAwarenessUpdate(child, changes, origin),
        remotePeerIds: new Map(),
      };
      this.syncChildPeerIds(child);
      awareness.on("update", child.handleAwarenessUpdate);
      this.attachProvider(child);
      return child;
    });
    this.rebuildAwareness(new Set());
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
    this.awareness.destroy();
    for (const child of this.children) {
      child.awareness.off("update", child.handleAwarenessUpdate);
      child.provider.destroy();
      child.awareness.destroy();
    }
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
    const logicalClock = state ? ++this.logicalAwarenessClock : this.logicalAwarenessClock;
    for (const child of this.children ?? []) {
      child.awareness.setLocalState(
        state
          ? {
              ...state,
              transportPeerId: child.provider.peerId,
              transport: child.name,
              multiproviderSession: this.doc.clientID,
              multiproviderClock: logicalClock,
            }
          : null,
      );
    }
  }

  private syncChildPeerIds(child: Child): void {
    child.remotePeerIds.clear();
    for (const [clientId, state] of child.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const peerId = this.getLogicalPeerId(state);
      if (peerId) child.remotePeerIds.set(clientId, peerId);
    }
  }

  private handleAwarenessUpdate(child: Child, changes: AwarenessChanges, origin: unknown): void {
    const affectedPeerIds = new Set<string>();
    let hasRemoteChange = false;
    const updatedClientIds = new Set([...changes.added, ...changes.updated]);

    for (const clientId of updatedClientIds) {
      if (clientId === this.doc.clientID) continue;
      hasRemoteChange = true;
      const previousPeerId = child.remotePeerIds.get(clientId);
      if (previousPeerId) affectedPeerIds.add(previousPeerId);

      const state = child.awareness.getStates().get(clientId);
      const peerId = state ? this.getLogicalPeerId(state) : null;
      if (peerId) {
        child.remotePeerIds.set(clientId, peerId);
        affectedPeerIds.add(peerId);
      } else {
        child.remotePeerIds.delete(clientId);
      }
    }

    for (const clientId of changes.removed) {
      if (clientId === this.doc.clientID) continue;
      hasRemoteChange = true;
      const peerId = child.remotePeerIds.get(clientId);
      if (peerId) affectedPeerIds.add(peerId);
      child.remotePeerIds.delete(clientId);
    }

    if (hasRemoteChange) {
      this.rebuildAwareness(affectedPeerIds, child.name, origin);
    }
  }

  private getLogicalPeerId(state: Record<string, unknown>): string | null {
    const peerId = state["peerId"];
    const transportPeerId = state["transportPeerId"];
    return typeof peerId === "string" && typeof transportPeerId === "string" ? peerId : null;
  }

  private rebuildAwareness(
    affectedPeerIds: ReadonlySet<string>,
    preferredProvider: string | undefined = undefined,
    origin: unknown = "remote",
  ): void {
    const previousRoutes = cloneRoutes(this.routes);
    const states = new Map<number, Record<string, unknown>>();
    const routes = new Map<string, Map<string, string>>();
    const selected = new Map<
      string,
      {
        state: Record<string, unknown>;
        logicalSession: number | undefined;
        logicalClock: number | undefined;
        lastUpdated: number;
        provider: string;
      }
    >();

    for (const child of this.children) {
      for (const [clientId, rawState] of child.awareness.getStates()) {
        if (clientId === this.doc.clientID) continue;
        const state = rawState as Record<string, unknown>;
        const peerId = this.getLogicalPeerId(state);
        if (!peerId) continue;

        const peerRoutes = routes.get(peerId) ?? new Map<string, string>();
        peerRoutes.set(child.name, state["transportPeerId"] as string);
        routes.set(peerId, peerRoutes);

        const meta = child.awareness.meta.get(clientId);
        const candidate = {
          state: { ...state, peerId },
          logicalSession:
            typeof state["multiproviderSession"] === "number"
              ? state["multiproviderSession"]
              : undefined,
          logicalClock:
            typeof state["multiproviderClock"] === "number"
              ? state["multiproviderClock"]
              : undefined,
          lastUpdated: meta?.lastUpdated ?? 0,
          provider: child.name,
        };
        const current = selected.get(peerId);
        const candidateIsNewer =
          current !== undefined &&
          candidate.logicalSession !== undefined &&
          current.logicalSession === candidate.logicalSession &&
          candidate.logicalClock !== undefined &&
          current.logicalClock !== undefined
            ? candidate.logicalClock > current.logicalClock ||
              (candidate.logicalClock === current.logicalClock &&
                (candidate.lastUpdated > current.lastUpdated ||
                  (candidate.lastUpdated === current.lastUpdated &&
                    candidate.provider === preferredProvider &&
                    current.provider !== preferredProvider)))
            : current !== undefined &&
              (candidate.lastUpdated > current.lastUpdated ||
                (candidate.lastUpdated === current.lastUpdated &&
                  candidate.provider === preferredProvider &&
                  current.provider !== preferredProvider));
        if (current === undefined || candidateIsNewer) {
          selected.set(peerId, candidate);
        }
      }
    }

    this.routes.clear();
    for (const [peerId, peerRoutes] of routes) this.routes.set(peerId, peerRoutes);
    this.retireStateIds(new Set(routes.keys()));
    for (const [peerId, candidate] of selected) {
      states.set(this.getStateId(peerId), candidate.state);
    }
    this.awareness.replaceRemoteStates(states, affectedPeerIds, origin);
    this.emitPeerChanges(previousRoutes, routes);
  }

  private retireStateIds(activePeerIds: ReadonlySet<string>): void {
    for (const [peerId, stateId] of this.stateIds) {
      if (!activePeerIds.has(peerId)) {
        this.stateIds.delete(peerId);
        this.allocatedStateIds.delete(stateId);
      }
    }
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

export class MultiAwareness extends Awareness {
  private publishLocalState: ((state: Record<string, unknown> | null) => void) | undefined;
  private destroyed = false;

  constructor(doc: Y.Doc, publishLocalState: (state: Record<string, unknown> | null) => void) {
    super(doc);
    this.publishLocalState = publishLocalState;
    super.setLocalState(null);
    this.states.clear();
    this.meta.clear();
  }

  getLocalState(): Record<string, unknown> | null {
    return (this.states.get(this.clientID) as Record<string, unknown> | undefined) ?? null;
  }

  setLocalState(state: Record<string, unknown> | null): void {
    if (this.publishLocalState === undefined) {
      super.setLocalState(state);
      return;
    }
    if (this.destroyed) return;

    const previousState = this.getLocalState();
    if (state === null) this.states.delete(this.clientID);
    else this.states.set(this.clientID, state);
    this.updateMeta(this.clientID);
    this.publishLocalState(state);

    const changes: AwarenessChanges = {
      added: previousState === null && state !== null ? [this.clientID] : [],
      updated:
        previousState !== null && state !== null && !equalityDeep(previousState, state)
          ? [this.clientID]
          : [],
      removed: state === null ? [this.clientID] : [],
    };
    const updates: AwarenessChanges = {
      added: changes.added,
      updated: previousState !== null && state !== null ? [this.clientID] : [],
      removed: changes.removed,
    };
    this.emitAwarenessChanges(changes, updates, "local");
  }

  replaceRemoteStates(
    states: Map<number, Record<string, unknown>>,
    updatedPeerIds: ReadonlySet<string> = new Set(),
    origin: unknown = "remote",
  ): void {
    const previousLocalState = this.getLocalState();
    const previousRemoteStates = new Map(this.states);
    previousRemoteStates.delete(this.clientID);
    const added: number[] = [];
    const updated: number[] = [];
    const updateIds: number[] = [];
    const removed: number[] = [];

    for (const [clientId, state] of states) {
      const previousState = previousRemoteStates.get(clientId);
      if (previousState === undefined) {
        added.push(clientId);
        if (!this.meta.has(clientId)) {
          this.meta.set(clientId, { clock: 1, lastUpdated: currentAwarenessTime() });
        }
      } else {
        const changed = !equalityDeep(previousState, state);
        const peerId = state["peerId"];
        if (changed) updated.push(clientId);
        if (changed || (typeof peerId === "string" && updatedPeerIds.has(peerId))) {
          updateIds.push(clientId);
          this.updateMeta(clientId);
        }
      }
    }
    for (const clientId of previousRemoteStates.keys()) {
      if (!states.has(clientId)) removed.push(clientId);
    }

    this.states.clear();
    for (const [clientId, state] of states) this.states.set(clientId, state);
    if (previousLocalState !== null) this.states.set(this.clientID, previousLocalState);

    this.emitAwarenessChanges(
      { added, updated, removed },
      { added, updated: updateIds, removed },
      origin,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.setLocalState(null);
    this.destroyed = true;
    this.states.clear();
    this.meta.clear();
    super.destroy();
  }

  private updateMeta(clientId: number): void {
    const previous = this.meta.get(clientId);
    this.meta.set(clientId, {
      clock: previous === undefined ? 1 : previous.clock + 1,
      lastUpdated: currentAwarenessTime(),
    });
  }

  private emitAwarenessChanges(
    changes: AwarenessChanges,
    updates: AwarenessChanges,
    origin: unknown,
  ): void {
    if (changes.added.length || changes.updated.length || changes.removed.length) {
      this.emit("change", [changes, origin]);
    }
    this.emit("update", [updates, origin]);
  }
}

function currentAwarenessTime(): number {
  return Date.now();
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
