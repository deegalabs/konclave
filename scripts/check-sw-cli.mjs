// The command the workflows run: node scripts/check-sw-cli.mjs <desktop|web> <path/to/sw.js>
//
// A file of its own, with no "am I the main module?" test. The usual one compares import.meta.url
// with `file://${process.argv[1]}`, which never matches on Windows (argv[1] is `D:\a\...`), so the
// check would skip itself and exit 0 on windows-latest, the runner that builds the installer the
// blank-window report came from. Here there is nothing to skip: running the file is running the
// check. The rule is in check-sw.mjs, with tests.
import { readFileSync } from 'node:fs'
import { checkSw } from './check-sw.mjs'

const [expected, file] = process.argv.slice(2)
let src
try {
  src = readFileSync(file, 'utf8')
} catch (e) {
  console.error(`Cannot read ${file}: ${e.message}`)
  process.exit(1)
}
const problem = checkSw(expected, src)
if (problem) {
  console.error(problem)
  process.exit(1)
}
console.log(`${file}: the ${expected} service worker, as it must be.`)
