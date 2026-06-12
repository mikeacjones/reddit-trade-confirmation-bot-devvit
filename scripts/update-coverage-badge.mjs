import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const summaryPath = new URL('../coverage/coverage-summary.json', import.meta.url)
const badgePath = new URL('../.github/badges/coverage.json', import.meta.url)

const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
const pct = summary.total?.lines?.pct

if (typeof pct !== 'number' || !Number.isFinite(pct)) {
  throw new Error('Could not find total line coverage in coverage/coverage-summary.json')
}

const badge = {
  schemaVersion: 1,
  label: 'coverage',
  message: `${pct.toFixed(2)}%`,
  color: coverageColor(pct),
}

await mkdir(dirname(fileURLToPath(badgePath)), { recursive: true })
await writeFile(badgePath, `${JSON.stringify(badge, null, 2)}\n`)

console.log(`Coverage badge updated: ${badge.message}`)

function coverageColor(pct) {
  if (pct >= 90) return 'brightgreen'
  if (pct >= 80) return 'yellowgreen'
  if (pct >= 70) return 'yellow'
  if (pct >= 60) return 'orange'
  return 'red'
}
