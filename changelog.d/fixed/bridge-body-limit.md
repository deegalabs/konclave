- **A body sent to the local bridge in chunks is held to the same 2 MiB limit as one that announces its length**
  (#1088). The limit read only the announced length, so a chunked body reached the bridge's handler whatever its
  size; now a larger one is refused with `413`. A request asking to upgrade the connection is refused, since the
  bridge has no use for one.
