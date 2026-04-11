export const CINEMA_CONTROLS_KEY = 'bookshelf:cinema-controls:v1'

export const DEFAULT_CINEMA_CONTROLS = {
  holdMinSec: 45,
  holdMaxSec: 60,
  crossfadeSec: 2,
  kenBurnsScale: 1.05,
  fanartEnabled: true,
  fanartPerCover: 'random',
  debugMode: false,
  seriesRules: {},
  lastNonDebug: {
    holdMinSec: 45,
    holdMaxSec: 60,
    crossfadeSec: 2,
    kenBurnsScale: 1.05
  }
}

export const RULE_MODES = ['neutral', 'whitelist', 'blacklist']

export function normalizeRuleMode(value) {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'whitelist') return 'whitelist'
  if (normalized === 'blacklist') return 'blacklist'
  return 'neutral'
}

export function readCinemaControls() {
  try {
    const raw = localStorage.getItem(CINEMA_CONTROLS_KEY)
    if (!raw) return { ...DEFAULT_CINEMA_CONTROLS }
    const parsed = JSON.parse(raw)
    const holdMinSec = clampFloat(parsed.holdMinSec, 3, 90, DEFAULT_CINEMA_CONTROLS.holdMinSec)
    const holdMaxSec = clampFloat(parsed.holdMaxSec, 3, 90, DEFAULT_CINEMA_CONTROLS.holdMaxSec)
    const normalizedHold = sortRange(holdMinSec, holdMaxSec)
    return {
      holdMinSec: normalizedHold.min,
      holdMaxSec: normalizedHold.max,
      crossfadeSec: clampFloat(parsed.crossfadeSec, 0.5, 5, DEFAULT_CINEMA_CONTROLS.crossfadeSec),
      kenBurnsScale: clampFloat(parsed.kenBurnsScale, 1, 1.08, DEFAULT_CINEMA_CONTROLS.kenBurnsScale),
      fanartEnabled: Boolean(parsed.fanartEnabled ?? DEFAULT_CINEMA_CONTROLS.fanartEnabled),
      fanartPerCover: normalizeFanartPerCover(parsed.fanartPerCover),
      debugMode: Boolean(parsed.debugMode),
      seriesRules: normalizeRulesMap(parsed.seriesRules),
      lastNonDebug: normalizeLastNonDebug(parsed.lastNonDebug)
    }
  } catch {
    return { ...DEFAULT_CINEMA_CONTROLS }
  }
}

export function writeCinemaControls(controls) {
  const holdMinSec = clampFloat(controls?.holdMinSec, 3, 90, DEFAULT_CINEMA_CONTROLS.holdMinSec)
  const holdMaxSec = clampFloat(controls?.holdMaxSec, 3, 90, DEFAULT_CINEMA_CONTROLS.holdMaxSec)
  const normalizedHold = sortRange(holdMinSec, holdMaxSec)
  const normalized = {
    holdMinSec: normalizedHold.min,
    holdMaxSec: normalizedHold.max,
    crossfadeSec: clampFloat(controls?.crossfadeSec, 0.5, 5, DEFAULT_CINEMA_CONTROLS.crossfadeSec),
    kenBurnsScale: clampFloat(controls?.kenBurnsScale, 1, 1.08, DEFAULT_CINEMA_CONTROLS.kenBurnsScale),
    fanartEnabled: Boolean(controls?.fanartEnabled ?? DEFAULT_CINEMA_CONTROLS.fanartEnabled),
    fanartPerCover: normalizeFanartPerCover(controls?.fanartPerCover),
    debugMode: Boolean(controls?.debugMode),
    seriesRules: normalizeRulesMap(controls?.seriesRules),
    lastNonDebug: normalizeLastNonDebug(controls?.lastNonDebug)
  }
  localStorage.setItem(CINEMA_CONTROLS_KEY, JSON.stringify(normalized))
  return normalized
}

export function cycleRuleMode(value) {
  const idx = RULE_MODES.indexOf(normalizeRuleMode(value))
  return RULE_MODES[(idx + 1) % RULE_MODES.length]
}

function normalizeRulesMap(mapLike) {
  const input = mapLike && typeof mapLike === 'object' ? mapLike : {}
  const next = {}
  for (const [key, value] of Object.entries(input)) {
    const mode = normalizeRuleMode(value)
    if (mode !== 'neutral') next[String(key)] = mode
  }
  return next
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function sortRange(a, b) {
  return { min: Math.min(a, b), max: Math.max(a, b) }
}

function normalizeFanartPerCover(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'random' || raw === 'rand') return 'random'
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_CINEMA_CONTROLS.fanartPerCover
  return String(Math.max(0, Math.min(3, Math.round(n))))
}

function normalizeLastNonDebug(value) {
  const input = value && typeof value === 'object' ? value : {}
  const holdMinSec = clampFloat(input.holdMinSec, 3, 90, DEFAULT_CINEMA_CONTROLS.lastNonDebug.holdMinSec)
  const holdMaxSec = clampFloat(input.holdMaxSec, 3, 90, DEFAULT_CINEMA_CONTROLS.lastNonDebug.holdMaxSec)
  const hold = sortRange(holdMinSec, holdMaxSec)
  return {
    holdMinSec: hold.min,
    holdMaxSec: hold.max,
    crossfadeSec: clampFloat(input.crossfadeSec, 0.5, 5, DEFAULT_CINEMA_CONTROLS.lastNonDebug.crossfadeSec),
    kenBurnsScale: clampFloat(input.kenBurnsScale, 1, 1.08, DEFAULT_CINEMA_CONTROLS.lastNonDebug.kenBurnsScale)
  }
}
