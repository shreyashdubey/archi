/**
 * scripts/lib/discover.mjs — shared slug discovery + sampling for the crawlers.
 *
 *   - discoverSlugs(baseUrl): GET the slug API (which serves the live sitemap,
 *     ~6,000 slugs) and return { slugs, total, source }.
 *   - sampleSlugs(slugs, size): pick a random subset so a LOCAL run monitors a
 *     manageable slice. size <= 0 or >= total means "the whole fleet" — that's
 *     the prod setting (SAMPLE_SIZE=0), where the Lambda crawls all ~6,000.
 *
 * Sampling is random per run by default; set SAMPLE_SEED for a reproducible run.
 */

/**
 * Resolve the mock app's base URL. Honors BASE_URL, then PORT; otherwise probes
 * the ports Next falls back to (3000–3003) and returns the first that actually
 * serves the mock's slug API. This means a busy port 3000 — where `next dev`
 * silently bumps to 3001 — doesn't break the crawl with a 404 against the wrong app.
 */
export async function resolveBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL
  const candidatePorts = process.env.PORT ? [Number(process.env.PORT)] : [3000, 3001, 3002, 3003]
  for (const port of candidatePorts) {
    const base = `http://localhost:${port}`
    try {
      const response = await fetch(`${base}/api/funds/slugs`, { signal: AbortSignal.timeout(2000) })
      if (response.ok && Array.isArray((await response.json())?.slugs)) return base // the mock lives here
    } catch {
      // not reachable / not our app — try the next port
    }
  }
  return `http://localhost:${candidatePorts[0]}` // nothing found; let the caller surface the error
}

/** Fetch the full slug list from the running app's slug API. */
export async function discoverSlugs(baseUrl) {
  const response = await fetch(`${baseUrl}/api/funds/slugs`)
  if (!response.ok) throw new Error(`slug API responded HTTP ${response.status}`)
  const body = await response.json()
  const slugs = Array.isArray(body?.slugs) ? body.slugs : []
  return { slugs, total: body?.total ?? slugs.length, source: body?.source ?? 'unknown' }
}

/** Mulberry32 PRNG — deterministic stream from a 32-bit seed (for SAMPLE_SEED). */
function createSeededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Random sample of `size` slugs (partial Fisher–Yates — unbiased, O(size)).
 * Any non-positive / non-finite / >= length `size` returns every slug (the prod
 * "all" setting). `size` is truncated to an integer. Pass a finite { seed } for a
 * stable sample; a non-finite seed falls back to non-deterministic sampling.
 */
export function sampleSlugs(allSlugs, size, { seed } = {}) {
  if (!Array.isArray(allSlugs) || allSlugs.length === 0) return []
  const count = Math.trunc(Number(size))
  if (!Number.isFinite(count) || count <= 0 || count >= allSlugs.length) return [...allSlugs]

  const nextRandom = Number.isFinite(seed) ? createSeededRandom(Number(seed)) : Math.random
  const pool = [...allSlugs]
  for (let index = 0; index < count; index++) {
    const swapWith = index + Math.floor(nextRandom() * (pool.length - index))
    ;[pool[index], pool[swapWith]] = [pool[swapWith], pool[index]]
  }
  return pool.slice(0, count)
}

/**
 * Resolve the sample knobs from the environment (one source of truth). Treats an
 * empty string like "unset" (default 25) and a non-numeric value as invalid, so a
 * blank/typo'd SAMPLE_SIZE can't silently flip a local run into a full ~6,000 crawl
 * and a typo'd SAMPLE_SEED can't silently pin a fixed sample.
 */
export function getSampleConfig() {
  const rawSize = process.env.SAMPLE_SIZE
  const parsedSize = rawSize == null || rawSize === '' ? 25 : Number(rawSize)
  const size = Number.isFinite(parsedSize) ? Math.trunc(parsedSize) : 25

  const rawSeed = process.env.SAMPLE_SEED
  const parsedSeed = rawSeed == null || rawSeed === '' ? NaN : Number(rawSeed)
  const seed = Number.isFinite(parsedSeed) ? parsedSeed : undefined

  return { size, seed }
}
