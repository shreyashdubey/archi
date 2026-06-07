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
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Mulberry32 PRNG: given a seed, returns a function that yields a new
 * pseudo-random number in [0, 1) on each call — deterministic for that seed.
 */
function createSeededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

/** Pick one item from a list using a random value in [0, 1). */
function pickFrom<T>(options: T[], random: number): T {
  return options[Math.floor(random * options.length)]
}

/** Round a number to a fixed number of decimal places. */
function roundTo(value: number, decimals = 0): number {
  return Number(value.toFixed(decimals))
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
    .filter((word) => !wordsToDrop.has(word))
    .map((word) => {
      if (word === 'g') return '(G)'
      if (word === 'idcw') return 'IDCW'
      // Short words (e.g. "us", "g") stay uppercase; otherwise capitalise.
      return word.length <= 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)
    })
    .join(' ')
}

/**
 * Resolve any slug to stable mock fund data. This is the mock equivalent of
 * `GET /api/funds/{slug}` on the real site.
 */
export function getFundBySlug(slug: string): Fund {
  const random = createSeededRandom(hashStringToSeed(slug))

  const nav = roundTo(10 + random() * 390, 2)
  const ageInMonths = 6 + Math.floor(random() * 174)
  const riskLevelIndex = Math.floor(random() * RISK_LABELS.length)

  // Build a gently-rising NAV history that ends at the current NAV.
  const navHistory: number[] = []
  let price = nav * 0.5
  for (let point = 0; point < 40; point++) {
    price = price * (1 + (random() - 0.42) * 0.07) // small up-biased step
    navHistory.push(roundTo(Math.max(price, 1), 2))
  }
  navHistory[navHistory.length - 1] = nav

  return {
    slug,
    name: slugToFundName(slug),
    category: pickFrom(FUND_CATEGORIES, random()),
    oneYearReturnPct: roundTo(8 + random() * 210, 2),
    nav,
    navDate: '05 Jun 2026',
    minSipAmount: pickFrom([100, 500, 1000], random()),
    aumInCrores: roundTo(100 + random() * 14900),
    fundAge: `${Math.floor(ageInMonths / 12)} years ${ageInMonths % 12} months`,
    lockInPeriod: random() < 0.2 ? '3 years' : '0',
    exitLoad: '1.00% - If redeemed within 3 months of allotment. NIL - after 3 months.',
    expenseRatioPct: roundTo(0.2 + random() * 2.3, 2),
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

/** The "slug API": a representative list standing in for all 6,000 slugs. */
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
