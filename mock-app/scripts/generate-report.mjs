/**
 * scripts/generate-report.mjs — the one-command LOCAL pipeline.
 *
 * Each run: discover every fund page from the sitemap (via the slug API), pick a
 * random SAMPLE_SIZE of them (default 25), crawl just those on localhost, then
 * build and open the report. This is the local stand-in for the prod nightly
 * Lambda that crawls ALL ~6,000 pages (there you'd set SAMPLE_SIZE=0).
 *
 * Run:  npm run generate-report     (needs `npm run dev` running)
 * Env:  SAMPLE_SIZE  (random pages to monitor; default 25, 0 = all ~6,000)
 *       SAMPLE_SEED  (fix the random sample for a reproducible run)
 *       CRAWLER      (fetch [default, fast] | browser [real render times, slow])
 *       KEEP_STORE   (set to append to prior events; default: fresh store each run)
 *       BASE_URL     (default http://localhost:3000)
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearEvents } from '@mock/telemetry'
import { getSampleConfig } from './lib/discover.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const useBrowserCrawler = process.env.CRAWLER === 'browser'
const crawlerScript = useBrowserCrawler ? 'crawl-browser.mjs' : 'crawl.mjs'

/**
 * Run a child script, inheriting our stdio; reject on a non-zero exit. We force
 * RESET_STORE off in the child: THIS orchestrator owns the clear decision (below),
 * so the browser crawler must never independently wipe the store (which would
 * defeat KEEP_STORE).
 */
function runScript(scriptName, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, scriptName), ...scriptArgs], {
      stdio: 'inherit',
      env: { ...process.env, RESET_STORE: '' },
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${scriptName} exited with code ${code}`))))
  })
}

async function main() {
  const { size } = getSampleConfig()

  // Fresh store by default so the report reflects only THIS run's sample. (The
  // crawler never clears on its own — runScript forces RESET_STORE off.)
  if (!process.env.KEEP_STORE) {
    await clearEvents()
    console.log('Cleared the event store — this report reflects only this run.')
  }
  console.log(`Monitoring up to ${size > 0 ? size : 'ALL'} random pages with the ${useBrowserCrawler ? 'browser' : 'fetch'} crawler (the crawler logs the exact count).\n`)

  await runScript(crawlerScript)
  console.log('')
  await runScript('report.mjs', ['--open'])
}

main().catch((error) => {
  console.error('\ngenerate-report failed:', error.message)
  console.error('Is the dev server running?  npm run dev')
  console.error('(If port 3000 is busy, the crawler probes 3000–3003; pin one with PORT=<port> or set BASE_URL.)')
  process.exit(1)
})
