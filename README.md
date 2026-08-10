# y-multiprovider

Runs multiple Yjs providers against one document. Each child provider gets its own
`Awareness` instance so losing one transport does not remove a peer that is still
reachable through another transport. The wrapper merges those awareness paths by
logical `peerId`, routes directed messages through every available transport, and
deduplicates duplicate deliveries.

```ts
import * as Y from "yjs";
import { MultiProvider } from "y-multiprovider";

const doc = new Y.Doc();
const provider = new MultiProvider("room", doc, {
  providers: [
    {
      name: "first",
      create: ({ doc, awareness }) => new FirstProvider("room", doc, { awareness }),
    },
    {
      name: "second",
      create: ({ doc, awareness }) => new SecondProvider("room", doc, { awareness }),
    },
  ],
});

provider.awareness.setLocalState({ peerId: "app-peer-id" });
provider.on("peer-change", ({ peerId, connected, transports }) => {
  console.log(peerId, connected, transports);
});
await provider.ready;
```

## Child provider contract

Child providers provide:

- `peerId`, `ready`, `connect()`, `disconnect()`, `destroy()`, and `sendToPeer()`.
- `status`, `synced`, `peers`, `debug`, `connection-error`, `peer-error`, and
  `direct-message` events.
- A standard `y-protocols/awareness` instance supplied through the provider context.

The child `peerId` is a transport identity. Applications advertise their stable
logical identity as `peerId` in the awareness state. The multiprovider adds
`transport` and `transportPeerId` to each child awareness state.

The wrapper forwards child lifecycle events with a `provider` name. `peers` remains
transport-specific; `peer-change` reports the merged logical peer lifecycle and
lists all currently available transport routes.

`MultiAwareness` exposes the consumer-facing awareness surface used by Yjs bindings:
`getStates()`, `getLocalState()`, `setLocalState()`, `setLocalStateField()`, and
`change`/`update` events with `{ added, updated, removed }` changes.

```sh
npm install
npm run check
npm run build
```
