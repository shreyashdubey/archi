/**
 * @mock/data — a deterministic, in-memory stand-in for the real "fund APIs".
 *
 * Why deterministic? The real site has ~6,000 fund pages. Instead of hardcoding
 * 6,000 records, we DERIVE every fund's data from its slug. The same slug always
 * produces the same numbers, so any dynamic URL renders consistently — exactly
 * what we need to mock "6,000 pages" without a backend.
 */

/** Everything the page template needs to render one fund. */
export interface Fund {
  slug: string
  name: string
  category: string
  oneYearReturnPct: number
  nav: number // Net Asset Value (price per unit)
  navDate: string
  minSipAmount: number
  aumInCrores: number // Assets Under Management
  fundAge: string
  lockInPeriod: string
  exitLoad: string
  expenseRatioPct: number
  riskLabel: string
  riskLevelIndex: number // 0 (Low) .. 5 (Very High)
  navHistory: number[] // recent NAV points, oldest → newest, for the chart
}

/** Result of a SIP (monthly investment) projection. */
export interface SipResult {
  totalValue: number
  totalInvested: number
  estimatedReturns: number
}

// ---------------------------------------------------------------------------
// Deterministic helpers — no Math.random(), so output is stable per slug.
// ---------------------------------------------------------------------------

/** FNV-1a hash: turns a slug string into a single 32-bit number (the seed). */
function hashStringToSeed(text: string): number {
  let hashAccumulator = 2166136261
  for (let charIndex = 0; charIndex < text.length; charIndex++) {
    hashAccumulator ^= text.charCodeAt(charIndex)
    hashAccumulator = Math.imul(hashAccumulator, 16777619)
  }
  return hashAccumulator >>> 0
}

/**
 * Mulberry32 PRNG: given a seed, returns a function that yields a new
 * pseudo-random number in [0, 1) on each call — deterministic for that seed.
 */
function createSeededRandom(seed: number): () => number {
  let randomState = seed
  return () => {
    randomState = (randomState + 0x6d2b79f5) | 0
    let mixedBits = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState)
    mixedBits = (mixedBits + Math.imul(mixedBits ^ (mixedBits >>> 7), 61 | mixedBits)) ^ mixedBits
    return ((mixedBits ^ (mixedBits >>> 14)) >>> 0) / 4294967296
  }
}

/** Pick one item from a list using a random value in [0, 1). */
function pickFrom<T>(options: T[], randomValue: number): T {
  return options[Math.floor(randomValue * options.length)]
}

/** Round a number to a fixed number of decimal places. */
function roundTo(value: number, decimalPlaces = 0): number {
  return Number(value.toFixed(decimalPlaces))
}

const FUND_CATEGORIES = [
  'Equity | Sectoral / Thematic', 'Equity | Large Cap', 'Equity | Mid Cap',
  'Equity | Small Cap', 'Hybrid | Aggressive', 'Debt | Short Duration',
]
const RISK_LABELS = ['Low', 'Low to Moderate', 'Moderate', 'Moderately High', 'High', 'Very High']

/** Turn a slug like "nippon-...-fund-g-growth" into "Nippon ... Fund (G)". */
function slugToFundName(slug: string): string {
  const wordsToDrop = new Set(['growth', 'plan'])
  return slug
    .split('-')
    .filter((slugWord) => !wordsToDrop.has(slugWord))
    .map((slugWord) => {
      if (slugWord === 'g') return '(G)'
      if (slugWord === 'idcw') return 'IDCW'
      // Short words (e.g. "us", "g") stay uppercase; otherwise capitalise.
      return slugWord.length <= 2 ? slugWord.toUpperCase() : slugWord[0].toUpperCase() + slugWord.slice(1)
    })
    .join(' ')
}

/**
 * Resolve any slug to stable mock fund data. This is the mock equivalent of
 * `GET /api/funds/{slug}` on the real site.
 */
export function getFundBySlug(slug: string): Fund {
  const nextRandom = createSeededRandom(hashStringToSeed(slug))

  const nav = roundTo(10 + nextRandom() * 390, 2)
  const ageInMonths = 6 + Math.floor(nextRandom() * 174)
  const riskLevelIndex = Math.floor(nextRandom() * RISK_LABELS.length)

  // Build a gently-rising NAV history that ends at the current NAV.
  const navHistory: number[] = []
  let runningNav = nav * 0.5
  for (let pointIndex = 0; pointIndex < 40; pointIndex++) {
    runningNav = runningNav * (1 + (nextRandom() - 0.42) * 0.07) // small up-biased step
    navHistory.push(roundTo(Math.max(runningNav, 1), 2))
  }
  navHistory[navHistory.length - 1] = nav

  return {
    slug,
    name: slugToFundName(slug),
    category: pickFrom(FUND_CATEGORIES, nextRandom()),
    oneYearReturnPct: roundTo(8 + nextRandom() * 210, 2),
    nav,
    navDate: '05 Jun 2026',
    minSipAmount: pickFrom([100, 500, 1000], nextRandom()),
    aumInCrores: roundTo(100 + nextRandom() * 14900),
    fundAge: `${Math.floor(ageInMonths / 12)} years ${ageInMonths % 12} months`,
    lockInPeriod: nextRandom() < 0.2 ? '3 years' : '0',
    exitLoad: '1.00% - If redeemed within 3 months of allotment. NIL - after 3 months.',
    expenseRatioPct: roundTo(0.2 + nextRandom() * 2.3, 2),
    riskLabel: RISK_LABELS[riskLevelIndex],
    riskLevelIndex,
    navHistory,
  }
}

/**
 * Project the future value of a monthly SIP.
 * Formula: FV = P · [((1 + i)^n − 1) / i] · (1 + i)
 *   P = monthly amount, i = monthly rate, n = number of months.
 */
export function sipCalculate(monthlyAmount: number, years: number, annualRatePct: number): SipResult {
  const monthlyRate = annualRatePct / 100 / 12
  const totalMonths = years * 12
  const totalInvested = monthlyAmount * totalMonths

  const futureValue =
    monthlyRate > 0
      ? monthlyAmount * ((Math.pow(1 + monthlyRate, totalMonths) - 1) / monthlyRate) * (1 + monthlyRate)
      : totalInvested

  return {
    totalValue: Math.round(futureValue),
    totalInvested,
    estimatedReturns: Math.round(futureValue - totalInvested),
  }
}

/**
 * Offline fallback for slug discovery — a representative handful used only when
 * the sitemap can't be reached (see `fetchSitemapSlugs`). The real list of
 * ~6,000 slugs comes from the live sitemap, not from here.
 */
export const KNOWN_SLUGS: string[] = [
  'nippon-india-taiwan-equity-fund-g-growth',
  'hsbc-brazil-fund-direct-growth',
  'motilal-oswal-nasdaq-100-fof-growth',
  'edelweiss-greater-china-equity-offshore-growth',
  'parag-parikh-flexi-cap-fund-direct-growth',
  'icici-pru-technology-fund-direct-growth',
  'quant-small-cap-fund-direct-growth',
  'sbi-contra-fund-direct-growth',
  'mirae-asset-large-cap-fund-direct-growth',
  'axis-bluechip-fund-direct-growth',
  'hdfc-balanced-advantage-fund-direct-growth',
  'kotak-emerging-equity-fund-direct-growth',
  'uti-nifty-50-index-fund-direct-growth',
  'tata-digital-india-fund-direct-growth',
  'canara-robeco-bluechip-equity-fund-direct-growth',
]

// ---------------------------------------------------------------------------
// Slug discovery — read the live sitemap instead of a hardcoded list.
//
// The real site publishes every fund-detail URL in a JSON sitemap. Discovery
// reads that, so the monitor always tracks the current ~6,000 pages with no
// list to maintain. Crawlers then sample a subset of these for a single run.
// ---------------------------------------------------------------------------

/**
 * The Bajaj Finserv sitemap: the authoritative JSON list of every fund-detail
 * URL (~6,000). Override with the SITEMAP_URL env var.
 */
export const SITEMAP_URL =
  process.env.SITEMAP_URL || 'https://www.bajajfinserv.in/api/amc-pdp/sitemap-details'

/**
 * The monitored template is the growth share class only: `/investments/{slug}-growth`.
 * Discovery keeps just these, so any other `/investments/*` URL the sitemap might
 * list (e.g. a category or landing page) is never crawled/monitored.
 */
const MONITORED_SLUG_SUFFIX = '-growth'

/** One entry in the sitemap response (other fields like lastModified are ignored). */
interface SitemapEntry {
  url?: string
}

/** Pull the fund slug out of an `/investments/{slug}` URL; null if it isn't one. */
export function slugFromInvestmentsUrl(url: string): string | null {
  try {
    const prefix = '/investments/'
    const { pathname } = new URL(url)
    if (!pathname.startsWith(prefix)) return null
    const segment = pathname.slice(prefix.length).replace(/\/$/, '')
    if (!segment || segment.includes('/')) return null // require a single top-level segment
    const slug = decodeURIComponent(segment)
    return slug.includes('/') ? null : slug // reject %2F-smuggled slashes
  } catch {
    return null // not a URL we recognise
  }
}

/**
 * Discover every fund-page slug from the sitemap. Keeps only the monitored
 * `/investments/{slug}-growth` template, dedupes, and falls back to KNOWN_SLUGS if
 * the sitemap can't be reached (so the mock still runs offline). `source` reports
 * which path was taken.
 */
export async function fetchSitemapSlugs(
  options: { sitemapUrl?: string; timeoutMs?: number } = {},
): Promise<{ slugs: string[]; source: 'sitemap' | 'fallback' }> {
  const sitemapUrl = options.sitemapUrl || SITEMAP_URL
  const timeoutMs = options.timeoutMs ?? 15_000
  const abortController = new AbortController()
  const abortTimer = setTimeout(() => abortController.abort(), timeoutMs)
  try {
    const response = await fetch(sitemapUrl, {
      signal: abortController.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`sitemap responded HTTP ${response.status}`)
    const entries = (await response.json()) as SitemapEntry[]
    const uniqueSlugs = Array.from(
      new Set(
        (Array.isArray(entries) ? entries : [])
          .map((entry) => (entry && typeof entry.url === 'string' ? slugFromInvestmentsUrl(entry.url) : null))
          .filter((slug): slug is string => slug !== null && slug.endsWith(MONITORED_SLUG_SUFFIX)),
      ),
    )
    if (uniqueSlugs.length === 0) throw new Error('sitemap contained no /investments/*-growth slugs')
    return { slugs: uniqueSlugs, source: 'sitemap' }
  } catch {
    return { slugs: KNOWN_SLUGS, source: 'fallback' }
  } finally {
    clearTimeout(abortTimer)
  }
}
