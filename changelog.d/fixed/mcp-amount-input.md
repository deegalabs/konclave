- **The local MCP server sends the amount the assistant meant, and says why one is refused.** A
  number written with an exponent (such as `1e-7`) or one that is not finite was sent to the app as
  `"1e-7"` or `"Infinity"`; the tool now refuses it and asks for a decimal string. When the app
  refuses an amount or a payroll line, the assistant now gets the reason and the line number, not
  only "invalid amount". The rule for what counts as an amount stays in the app (#973).
