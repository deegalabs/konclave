- **A coordinator or relay that lost its request workers now stops with a failure code, so the platform can restart
  it.** Each server answers requests on a fixed set of worker threads. A worker that failed outside the guard around
  each request ended alone, the server went on with fewer, and when none were left it exited as if it had been
  stopped on purpose (code 0), which a restart-on-failure policy does not restart. Now the first worker to end takes
  the process with it, with code 70, and the log says which server stopped. Requests in flight on the other workers
  end too; a send already holds its record on the volume and the coordinator reports it as held when it starts
  again. The local bridge exits the same way when its loop ends.
