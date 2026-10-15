import * as encoding from "lib0/encoding";
import { ObservableV2 } from "lib0/observable";
import type * as Y from "yjs";
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness";

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

export interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

interface Child {
  name: string;
  provider: ChildProvider;
  awareness: Awareness;
}

interface Candidate {
  clientId: number;
  clock: number;
  lastUpdated: number;
  state: Record<string, unknown>;
}

const FRAME_MAGIC = new Uint8Array([0x79, 0x6d, 0x70, 0x31]);
const MESSAGE_ID_LENGTH = 16;
const FRAME_HEADER_LENGTH = FRAME_MAGIC.length + MESSAGE_ID_LENGTH;
const SEEN_MESSAGE_LIMIT = 1000;

export class MultiProvider extends ObservableV2<MultiProviderEvents> {
  readonly awareness: Awareness;
  readonly ready: Promise<void>;
  private readonly children: Child[];
  private routes = new Map<string, Map<string, string>>();
  private readonly stateIds = new Map<string, number>();
  private nextStateId = 1;
  private localClock = 0;
  private readonly seenMessageIds = new Set<string>();
  private destroyed = false;

  private readonly handleChildAwarenessUpdate = (
    { added, updated, removed }: AwarenessChanges,
    origin: unknown,
  ): void => {
    const clientIds = [...added, ...updated, ...removed];
    if (clientIds.some((clientId) => clientId !== this.awareness.clientID)) {
      this.rebuildAwareness(origin);
    }
  };

  constructor(
    readonly doc: Y.Doc,
    options: MultiProviderOptions,
  ) {
    super();
    if (options.providers.length === 0) {
      throw new Error("MultiProvider requires at least one provider");
    }
    const names = new Set(options.providers.map(({ name }) => name));
    if (names.size !== options.providers.length) {
      throw new Error("MultiProvider provider names must be unique");
    }
    this.awareness = new Awareness(doc);
    this.awareness.setLocalState(null);
    this.children = options.providers.map((definition) => {
      const awareness = new Awareness(doc);
      const child = {
        name: definition.name,
        provider: definition.create({ doc, awareness }),
        awareness,
      };
      awareness.on("update", this.handleChildAwarenessUpdate);
      this.attachProvider(child);
      return child;
    });
    this.awareness.on("update", ({ added, updated, removed }: AwarenessChanges) => {
      if ([...added, ...updated, ...removed].includes(this.awareness.clientID)) {
        this.publishLocalAwareness();
      }
    });
    // A factory may populate its awareness synchronously, before the listener above is attached.
    this.rebuildAwareness("remote");
    this.ready = Promise.any(this.children.map(({ provider }) => provider.ready)).then(
      () => undefined,
    );
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

  override destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.awareness.destroy();
    for (const child of this.children) {
      child.awareness.off("update", this.handleChildAwarenessUpdate);
      child.provider.destroy();
      child.awareness.destroy();
    }
    this.routes.clear();
    super.destroy();
  }

  private attachProvider(child: Child): void {
    this.onChildProviderEvent(child, "status", (event) => {
      this.emit("status", [{ provider: child.name, event }]);
    });
    this.onChildProviderEvent(child, "synced", (synced) => {
      this.emit("synced", [{ provider: child.name, synced }]);
    });
    this.onChildProviderEvent(child, "peers", (peerIds) => {
      this.emit("peers", [{ provider: child.name, peerIds }]);
    });
    this.onChildProviderEvent(child, "debug", (event) => {
      this.emit("debug", [{ provider: child.name, event }]);
    });
    this.onChildProviderEvent(child, "connection-error", (event) => {
      this.emit("connection-error", [{ provider: child.name, event }]);
    });
    this.onChildProviderEvent(child, "peer-error", (event) => {
      this.emit("peer-error", [{ provider: child.name, event }]);
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
    if (!decoded) return;
    // Resolve the sender first: a copy from a route not yet in awareness must not mark the frame seen.
    const peerId = this.findLogicalPeerId(providerName, transportPeerId);
    if (!peerId || this.seenMessageIds.has(decoded.id)) return;
    this.rememberMessage(decoded.id);
    this.emit("direct-message", [peerId, decoded.payload]);
  }

  private rememberMessage(id: string): void {
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > SEEN_MESSAGE_LIMIT) {
      this.seenMessageIds.delete(this.seenMessageIds.values().next().value!);
    }
  }

  private findLogicalPeerId(providerName: string, transportPeerId: string): string | null {
    for (const [peerId, routes] of this.routes) {
      if (routes.get(providerName) === transportPeerId) return peerId;
    }
    return null;
  }

  private publishLocalAwareness(): void {
    const state = this.awareness.getLocalState();
    const clock = ++this.localClock;
    for (const child of this.children) {
      child.awareness.setLocalState(
        state && { ...state, transportPeerId: child.provider.peerId, multiproviderClock: clock },
      );
    }
  }

  private rebuildAwareness(origin: unknown): void {
    const routes = new Map<string, Map<string, string>>();
    const selected = new Map<string, Candidate>();

    for (const child of this.children) {
      for (const [clientId, rawState] of child.awareness.getStates()) {
        if (clientId === this.awareness.clientID) continue;
        const peerId = getLogicalPeerId(rawState);
        if (!peerId) continue;
        const { transportPeerId, multiproviderClock, ...state } = rawState;

        const peerRoutes = routes.get(peerId) ?? new Map<string, string>();
        peerRoutes.set(child.name, transportPeerId);
        routes.set(peerId, peerRoutes);

        const candidate = {
          clientId,
          clock: multiproviderClock,
          lastUpdated: child.awareness.meta.get(clientId)!.lastUpdated,
          state,
        };
        const current = selected.get(peerId);
        if (!current || isNewer(candidate, current)) selected.set(peerId, candidate);
      }
    }

    const previousRoutes = this.routes;
    this.routes = routes;
    for (const peerId of this.stateIds.keys()) {
      if (!routes.has(peerId)) this.stateIds.delete(peerId);
    }
    const states = new Map(
      [...selected].map(([peerId, { state }]) => [this.getStateId(peerId), state] as const),
    );
    replaceRemoteStates(this.awareness, states, origin);
    this.emitPeerChanges(previousRoutes, routes);
  }

  private getStateId(peerId: string): number {
    const existing = this.stateIds.get(peerId);
    if (existing !== undefined) return existing;

    let stateId = this.nextStateId;
    if (stateId === this.awareness.clientID) stateId++;
    this.nextStateId = stateId + 1;
    this.stateIds.set(peerId, stateId);
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
      this.emit("peer-change", [
        { peerId, connected: next !== undefined, transports: next ? [...next.keys()] : [] },
      ]);
    }
  }
}

function getLogicalPeerId(state: Record<string, unknown>): string | null {
  return typeof state["peerId"] === "string" &&
    typeof state["transportPeerId"] === "string" &&
    typeof state["multiproviderClock"] === "number"
    ? state["peerId"]
    : null;
}

// The same remote session has the same client ID on every transport, so its clocks are comparable.
function isNewer(candidate: Candidate, current: Candidate): boolean {
  return candidate.clientId === current.clientId
    ? candidate.clock > current.clock
    : candidate.lastUpdated > current.lastUpdated;
}

// Applying every merged state, not only changed ones, also renews their meta so the base
// Awareness timeout keeps peers whose routes are alive.
function replaceRemoteStates(
  awareness: Awareness,
  states: Map<number, Record<string, unknown>>,
  origin: unknown,
): void {
  const clientIds = new Set([...states.keys(), ...awareness.states.keys()]);
  clientIds.delete(awareness.clientID);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, clientIds.size);
  for (const clientId of clientIds) {
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, (awareness.meta.get(clientId)?.clock ?? 0) + 1);
    encoding.writeVarString(encoder, JSON.stringify(states.get(clientId) ?? null));
  }
  applyAwarenessUpdate(awareness, encoding.toUint8Array(encoder), origin);
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
