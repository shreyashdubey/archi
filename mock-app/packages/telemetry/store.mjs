/**
 * @mock/telemetry — a tiny append-only event store. This is our stand-in for
 * "NRDB": the page instrumentation writes events here (via /api/telemetry), and
 * both the crawler and the daily-report script read from here.
 *
 * Storage is a newline-delimited JSON file (.data/events.ndjson) so that the
 * Next.js server, the crawler, and the report — three separate processes — can
 * all share the same data. Plain ESM (no TypeScript) so the node scripts can
 * import it directly.
 */
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.join(process.cwd(), '.data')
const EVENTS_FILE = path.join(DATA_DIR, 'events.ndjson')

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true })
}

/** Append a batch of events to the store. */
export async function appendEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return
  await ensureDataDir()
  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  await appendFile(EVENTS_FILE, lines, 'utf8')
}

/** Read every stored event back as an array of objects. */
export async function readEvents() {
  if (!existsSync(EVENTS_FILE)) return []
  const fileContents = await readFile(EVENTS_FILE, 'utf8')
  return fileContents
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null // skip any truncated/partial line
      }
    })
    .filter(Boolean)
}

/** Empty the store (used by the crawler before a fresh run). */
export async function clearEvents() {
  await ensureDataDir()
  await writeFile(EVENTS_FILE, '', 'utf8')
}

export { EVENTS_FILE }
