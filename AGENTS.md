# y-multiprovider agent guide

`MultiProvider` runs several redundant Yjs transport providers over one `Y.Doc` and presents them as one provider: one merged awareness, logical peer lifecycle events, and directed messages that survive losing a transport. It is a small library; favor simple solutions for that scope and do not add machinery for rare timing races unless a concrete recurring failure justifies it.

Keep this guide to durable, non-obvious decisions. `README.md` covers usage and the child provider contract.

## Transports and identity

- Each child receives its own `Awareness`. Do not share child Awareness instances: independent presence paths are what keep a peer visible through one transport after another drops it.
- All children use the same `Y.Doc`, so a remote session has **one awareness client ID on every transport**. That client ID is the session identity; do not add a separate session field.
- Applications advertise their stable logical identity as `peerId` in the local state. Each child's copy adds `transportPeerId` (its route for directed messages) and `multiproviderClock`. Remote states missing either are not MultiProvider peers and are ignored.
- Yjs document updates need no forwarding: every child observes the same document, and Yjs ignores duplicate updates.

## Merged awareness

`provider.awareness` is a plain y-protocols `Awareness`: the local state under `doc.clientID`, plus one state per logical remote peer under a stable synthetic ID. Keep it a standard instance that Yjs bindings can use unchanged, not a subclass with a parallel API.

- **Merged states strip `transportPeerId` and `multiproviderClock`.** Switching which transport supplies a peer's state must be invisible to consumers. Do not expose transport metadata there: it would turn every route switch into a `change` event and bring back the tie-breaking logic this removes. Transport details belong in `peer-change` and the per-child events.
- For a peer reported by several transports, clocks decide only when the reports come from the same client ID; across different client IDs (a reloaded peer whose old session has not timed out yet) the newest `lastUpdated` wins. Clocks from different sessions are unrelated and must not be compared.
- The clock increments on every local publish, renewals included. That is safe only because merged states hide the clock.
- Child renewals must refresh merged-state `meta`, or the base `Awareness` timeout drops merged peers after 30 seconds even though their routes are alive. Removed synthetic IDs keep their `meta`: bindings encode removed clients, and `encodeAwarenessUpdate` throws without it.
- Synthetic IDs are allocated monotonically, never reused, and skip `doc.clientID`.
- Emit `change`/`update` like y-protocols does for remote updates: `change` only for real changes, `update` also for renewals, and nothing when nothing happened.

## Events and messages

- `peer-change` reports only a logical peer's first route connecting and last route disconnecting. Child `peers` events stay transport-specific and are forwarded tagged with the provider name.
- Directed messages are sent through every available route in a frame with a random ID; receivers deduplicate by that ID over a bounded window.

## Testing

- `RemotePeer` models a real remote session: one client ID across transports. Separate remote docs model separate sessions, such as a reload; one session with a different client ID per transport cannot occur.
- Assert outcomes consumers can see: merged states, full `change`/`peer-change` event logs (`mock.calls`), and frames sent. Do not re-test y-protocols behavior of a plain `Awareness`.
- Fake timers do not affect awareness timestamps: lib0 captures `Date.now` at import. When an outcome depends on `lastUpdated` ordering, wait a couple of real milliseconds between updates.

## Commands

- After changes: `npm run format`, then `npm run check` (lint, typecheck, tests).
- Build: `npm run build`.
