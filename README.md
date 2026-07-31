# y-multiprovider

Runs multiple Yjs providers against one doc. Merges awareness and deduplicates direct messages.

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
await provider.ready;
```

Child providers need `peerId`, `ready`, `connect`, `disconnect`, `destroy`, `sendToPeer`, and the expected events.

```sh
npm install
npm run check
npm run build
```
