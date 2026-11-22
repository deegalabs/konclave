- **A body sent to the local bridge in chunks is held to the same 2 MiB limit as one that announces its length**
  (#1088). The limit read only the announced length, so the data of a chunked body was read whatever its size; now it
  is read up to the limit and a larger body is refused with `413`. A request asking to upgrade the connection is
  refused, since the bridge has no use for one.
