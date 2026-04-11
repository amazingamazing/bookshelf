export const CINEMA_CONTROLS_KEY = 'bookshelf:cinema-controls:v1'

export const DEFAULT_CINEMA_CONTROLS = {
  imageCount: 10,
  imageDurationSec: 8,
  viewMode: 'cinema',
  seriesRules: {},
  genreRules: {}
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
    return {
      imageCount: clampInt(parsed.imageCount, 3, 15, DEFAULT_CINEMA_CONTROLS.imageCount),
      imageDurationSec: clampInt(parsed.imageDurationSec, 3, 15, DEFAULT_CINEMA_CONTROLS.imageDurationSec),
      viewMode: normalizeViewMode(parsed.viewMode),
      seriesRules: normalizeRulesMap(parsed.seriesRules),
      genreRules: normalizeRulesMap(parsed.genreRules)
    }
  } catch {
    return { ...DEFAULT_CINEMA_CONTROLS }
  }
}

export function writeCinemaControls(controls) {
  const normalized = {
    imageCount: clampInt(controls?.imageCount, 3, 15, DEFAULT_CINEMA_CONTROLS.imageCount),
    imageDurationSec: clampInt(controls?.imageDurationSec, 3, 15, DEFAULT_CINEMA_CONTROLS.imageDurationSec),
    viewMode: normalizeViewMode(controls?.viewMode),
    seriesRules: normalizeRulesMap(controls?.seriesRules),
    genreRules: normalizeRulesMap(controls?.genreRules)
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

function normalizeViewMode(value) {
  const normalized = String(value || '').toLowerCase()
  if (['cinema', 'gallery', 'mosaic'].includes(normalized)) return normalized
  return DEFAULT_CINEMA_CONTROLS.viewMode
}
