- **The local bridge holds every request body to its 2 MiB limit** (#1088). The limit read only the length a request
  announced, so a body sent in chunks was read whatever its size; now every body is read up to the limit and a larger
  one is refused with `413`. A request asking to upgrade the connection is refused, since the bridge has no use for one.
