- **The coordinator can be given several light-client servers** and keeps working when one stops answering: it uses
  the one it is on while that one answers and stays near the others, and moves to another only when it stops
  answering or falls well behind and at least three others agree. One configured server behaves as before.
