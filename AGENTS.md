# y-multiprovider agent notes

- `MultiProvider` coordinates multiple Yjs transport providers over one `Y.Doc`.
- Each child receives its own Awareness instance. Do not share child Awareness instances: independent presence paths are required so losing one transport does not remove a peer still visible through another.
- Logical peer IDs are advertised as `peerId`; child transport IDs are added as `transportPeerId` and `transport`.
- Directed messages are redundantly sent through all available routes and deduplicated by the wrapper frame ID.
- Yjs document updates need no wrapper forwarding; every child observes the same document and Yjs handles duplicate updates.
- Run `npm run format` and `npm run check` after changes.
