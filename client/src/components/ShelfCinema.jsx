import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readCinemaControls } from '../lib/cinemaControls'

const FANART_PREFS_KEY = 'bookshelf:fanart-prefs:v1'
const TIERS = ['S', 'A', 'B', 'C', 'D']
const TIER_WEIGHTS = { S: 10, A: 6, B: 3, C: 1, D: 0.3 }
const TIER_COLORS = { S: '#f4c542', A: '#6ea8fe', B: '#5cb85c', C: '#e67e22', D: '#e74c3c' }
const FADE_MS = 1500
const OVERLAY_HIDE_MS = 3000
const RIGHT_LANE_START_DELAY_MS = 1000
const MOSAIC_SHIFT_MS = 3200

function readFanartPrefs() {
  try {
    const raw = localStorage.getItem(FANART_PREFS_KEY)
    if (!raw) return { allowMature: false, minEdge: 700 }
    const parsed = JSON.parse(raw)
    return {
      allowMature: Boolean(parsed.allowMature),
      minEdge: Number(parsed.minEdge) || 700
    }
  } catch {
    return { allowMature: false, minEdge: 700 }
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function weightedPickSeries(seriesList, excludedSeriesId, avoidIds) {
  const candidates = seriesList.filter(series => (
    series.id !== excludedSeriesId &&
    !avoidIds.has(series.id) &&
    Number(TIER_WEIGHTS[series.tier] || 0) > 0
  ))
  if (!candidates.length) return null

  const totalWeight = candidates.reduce((sum, series) => sum + Number(TIER_WEIGHTS[series.tier] || 0), 0)
  if (totalWeight <= 0) return candidates[randomInt(0, candidates.length - 1)]

  let roll = Math.random() * totalWeight
  for (const series of candidates) {
    roll -= Number(TIER_WEIGHTS[series.tier] || 0)
    if (roll <= 0) return series
  }
  return candidates[candidates.length - 1]
}

function createVisual(image, seed, baseDurationSec) {
  const durationMin = Math.max(3000, (baseDurationSec - 2) * 1000)
  const durationMax = Math.max(durationMin, (baseDurationSec + 2) * 1000)
  const isFanart = image?.kind === 'fanart' || image?.source === 'fanart'
  const endScale = isFanart ? 1.05 : 1.02
  return {
    key: `${image.url}::${seed}::${Date.now()}`,
    image,
    durationMs: randomInt(durationMin, durationMax),
    driftX: `${(Math.random() * 6 - 3).toFixed(2)}%`,
    driftY: `${(Math.random() * 6 - 3).toFixed(2)}%`,
    endScale,
    fadingOut: false
  }
}

function filterSeriesByControlRules(allSeries, controls) {
  const safeSeries = Array.isArray(allSeries) ? allSeries : []
  const safeControls = controls || {}
  const seriesRules = safeControls.seriesRules || {}
  const genreRules = safeControls.genreRules || {}
  const whitelistedSeriesIds = new Set(
    Object.entries(seriesRules)
      .filter(([, mode]) => mode === 'whitelist')
      .map(([id]) => String(id))
  )
  const blacklistedSeriesIds = new Set(
    Object.entries(seriesRules)
      .filter(([, mode]) => mode === 'blacklist')
      .map(([id]) => String(id))
  )
  const whitelistedGenres = new Set(
    Object.entries(genreRules)
      .filter(([, mode]) => mode === 'whitelist')
      .map(([name]) => String(name).toLowerCase())
  )
  const blacklistedGenres = new Set(
    Object.entries(genreRules)
      .filter(([, mode]) => mode === 'blacklist')
      .map(([name]) => String(name).toLowerCase())
  )

  return safeSeries.filter(series => {
    const id = String(series.id)
    const seriesGenres = (series.genres || []).map(g => String(g).toLowerCase())
    if (blacklistedSeriesIds.has(id)) return false
    if (seriesGenres.some(g => blacklistedGenres.has(g))) return false
    if (whitelistedSeriesIds.size > 0 && !whitelistedSeriesIds.has(id)) return false
    if (whitelistedGenres.size > 0 && !seriesGenres.some(g => whitelistedGenres.has(g))) return false
    return true
  })
}

export default function ShelfCinema({ onExit }) {
  const rootRef = useRef(null)
  const mountedRef = useRef(false)
  const requestControllersRef = useRef(new Set())
  const hideTimerRef = useRef(null)
  const leftTimerRef = useRef(null)
  const rightTimerRef = useRef(null)
  const rightStartRef = useRef(null)
  const mosaicTimerRef = useRef(null)
  const mosaicSwitchTickRef = useRef(0)
  const leftFadeRef = useRef(null)
  const rightFadeRef = useRef(null)
  const prefetchingRef = useRef(false)
  const switchingPackRef = useRef(false)
  const nextPackRef = useRef(null)
  const currentPackRef = useRef(null)
  const cursorRef = useRef(0)

  const [seriesPool, setSeriesPool] = useState([])
  const [cinemaControls, setCinemaControls] = useState(() => readCinemaControls())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  })
  const [currentPack, setCurrentPack] = useState(null)
  const [nextPack, setNextPack] = useState(null)
  const [leftCurrent, setLeftCurrent] = useState(null)
  const [leftPrevious, setLeftPrevious] = useState(null)
  const [rightCurrent, setRightCurrent] = useState(null)
  const [rightPrevious, setRightPrevious] = useState(null)
  const [leftIndex, setLeftIndex] = useState(0)
  const [rightIndex, setRightIndex] = useState(-1)
  const [mosaicOffset, setMosaicOffset] = useState(0)

  nextPackRef.current = nextPack
  currentPackRef.current = currentPack
  const viewMode = cinemaControls.viewMode || 'cinema'
  const useDualLane = viewMode === 'cinema' && viewport.width >= 1180 && viewport.width > viewport.height

  const clearTimer = (timerRef) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const clearAllTimers = useCallback(() => {
    clearTimer(hideTimerRef)
    clearTimer(leftTimerRef)
    clearTimer(rightTimerRef)
    clearTimer(rightStartRef)
    clearTimer(mosaicTimerRef)
    clearTimer(leftFadeRef)
    clearTimer(rightFadeRef)
  }, [])

  const setOverlayVisibleWithTimeout = useCallback(() => {
    setOverlayVisible(true)
    clearTimer(hideTimerRef)
    hideTimerRef.current = setTimeout(() => setOverlayVisible(false), OVERLAY_HIDE_MS)
  }, [])

  const fetchPackForSeries = useCallback(async (series) => {
    const prefs = readFanartPrefs()
    const controller = new AbortController()
    const targetImageCount = Math.max(3, Math.min(15, Number(cinemaControls.imageCount) || 10))
    requestControllersRef.current.add(controller)
    try {
      const params = new URLSearchParams({
        allow_mature: prefs.allowMature ? 'true' : 'false',
        min_edge: String(prefs.minEdge),
        sort_mode: 'popular',
        time_window: 'all',
        exclude_ai: 'true',
        per_creator_cap: '2',
        image_limit: String(targetImageCount)
      })
      const res = await fetch(`/api/cinema/series-images/${series.id}?${params.toString()}`, {
        signal: controller.signal
      })
      const data = await res.json()
      if (!res.ok) return null

      const deduped = []
      const seen = new Set()
      for (const image of (data.images || [])) {
        const url = String(image?.url || '').trim()
        if (!url || seen.has(url)) continue
        seen.add(url)
        deduped.push({
          url,
          kind: image.kind || (image.source === 'fanart' ? 'fanart' : 'cover'),
          source: image.source || 'unknown',
          title: image.title || series.name,
          creator: image.creator || null,
          creator_url: image.creator_url || null,
          external_link: image.external_link || null
        })
      }
      if (deduped.length < 3) return null
      const selected = deduped.slice(0, targetImageCount)
      return { series, images: selected.slice(0, Math.max(3, Math.min(targetImageCount, selected.length))) }
    } catch {
      return null
    } finally {
      requestControllersRef.current.delete(controller)
    }
  }, [cinemaControls.imageCount])

  const loadPackByWeightedPick = useCallback(async (excludedSeriesId) => {
    if (!seriesPool.length) return null
    const avoidIds = new Set()
    for (let i = 0; i < seriesPool.length; i += 1) {
      const picked = weightedPickSeries(seriesPool, excludedSeriesId, avoidIds)
      if (!picked) break
      avoidIds.add(picked.id)
      const pack = await fetchPackForSeries(picked)
      if (pack) return pack
    }
    return null
  }, [fetchPackForSeries, seriesPool])

  const pullNextImage = useCallback(() => {
    const pack = currentPackRef.current
    if (!pack || !Array.isArray(pack.images) || !pack.images.length) return null
    const idx = cursorRef.current
    if (idx >= pack.images.length) return null
    cursorRef.current += 1
    return { image: pack.images[idx], index: idx }
  }, [])

  const updateLaneVisual = useCallback((lane, next, seed) => {
    if (lane === 'left') {
      setLeftCurrent((prev) => {
        if (prev) {
          setLeftPrevious({ ...prev, fadingOut: false, key: `${prev.key}-prev` })
          setTimeout(() => {
            if (!mountedRef.current) return
            setLeftPrevious((value) => (value ? { ...value, fadingOut: true } : value))
          }, 30)
          clearTimer(leftFadeRef)
          leftFadeRef.current = setTimeout(() => setLeftPrevious(null), FADE_MS + 80)
        }
        return createVisual(next, seed, cinemaControls.imageDurationSec || 8)
      })
      setLeftIndex(seed)
      return
    }

    setRightCurrent((prev) => {
      if (prev) {
        setRightPrevious({ ...prev, fadingOut: false, key: `${prev.key}-prev` })
        setTimeout(() => {
          if (!mountedRef.current) return
          setRightPrevious((value) => (value ? { ...value, fadingOut: true } : value))
        }, 30)
        clearTimer(rightFadeRef)
        rightFadeRef.current = setTimeout(() => setRightPrevious(null), FADE_MS + 80)
      }
      return createVisual(next, seed, cinemaControls.imageDurationSec || 8)
    })
    setRightIndex(seed)
  }, [cinemaControls.imageDurationSec])

  const switchToNextPack = useCallback(async () => {
    if (switchingPackRef.current) return
    switchingPackRef.current = true
    try {
      const currentSeriesId = currentPackRef.current?.series?.id || null
      let pack = nextPackRef.current
      if (!pack) pack = await loadPackByWeightedPick(currentSeriesId)
      if (!mountedRef.current || !pack) return

      setNextPack(null)
      setCurrentPack(pack)
      setLeftPrevious(null)
      setRightPrevious(null)
      setLeftCurrent(null)
      setRightCurrent(null)
      setLeftIndex(0)
      setRightIndex(-1)
      setMosaicOffset(0)
      mosaicSwitchTickRef.current = 0
      cursorRef.current = 0

      const left = pullNextImage() || { image: pack.images[0], index: 0 }
      updateLaneVisual('left', left.image, left.index)

      if (useDualLane && pack.images.length > 1) {
        clearTimer(rightStartRef)
        rightStartRef.current = setTimeout(() => {
          const right = pullNextImage()
          if (!mountedRef.current || !right) return
          updateLaneVisual('right', right.image, right.index)
        }, RIGHT_LANE_START_DELAY_MS)
      } else {
        setRightCurrent(null)
        setRightIndex(-1)
      }
    } finally {
      switchingPackRef.current = false
    }
  }, [loadPackByWeightedPick, pullNextImage, updateLaneVisual, useDualLane])

  const advanceLane = useCallback(async (lane) => {
    const next = pullNextImage()
    if (next) {
      updateLaneVisual(lane, next.image, next.index)
      return
    }
    await switchToNextPack()
  }, [pullNextImage, switchToNextPack, updateLaneVisual])

  const handleExit = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {})
    }
    onExit()
  }, [onExit])

  useEffect(() => {
    mountedRef.current = true
    setOverlayVisibleWithTimeout()

    const onKeyDown = (event) => {
      if (event.key === 'Escape') handleExit()
    }
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)

    if (rootRef.current && !document.fullscreenElement && rootRef.current.requestFullscreen) {
      rootRef.current.requestFullscreen().catch(() => {})
    }

    ;(async () => {
      try {
        const res = await fetch('/api/series')
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to load series')
        const ranked = filterSeriesByControlRules((data || [])
          .filter(series => TIERS.includes(series.tier))
          .map(series => ({
            id: Number(series.id),
            name: series.name,
            author_name: series.author_name,
            tier: series.tier,
            genres: series.genres || []
          })), cinemaControls)
        setSeriesPool(ranked)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    })()

    return () => {
      mountedRef.current = false
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      clearAllTimers()
      for (const controller of requestControllersRef.current) controller.abort()
      requestControllersRef.current.clear()
    }
  }, [cinemaControls, clearAllTimers, handleExit, setOverlayVisibleWithTimeout])

  useEffect(() => {
    if (!seriesPool.length || currentPack) return
    ;(async () => {
      const pack = await loadPackByWeightedPick(null)
      if (!mountedRef.current || !pack) return
      setCurrentPack(pack)
      cursorRef.current = 0
      const left = { image: pack.images[0], index: 0 }
      cursorRef.current = 1
      updateLaneVisual('left', left.image, left.index)
      if (useDualLane && pack.images.length > 1) {
        clearTimer(rightStartRef)
        rightStartRef.current = setTimeout(() => {
          if (!mountedRef.current) return
          const right = pullNextImage()
          if (!right) return
          updateLaneVisual('right', right.image, right.index)
        }, RIGHT_LANE_START_DELAY_MS)
      }
      setError(null)
    })()
  }, [currentPack, loadPackByWeightedPick, pullNextImage, seriesPool, updateLaneVisual, useDualLane])

  useEffect(() => {
    if (!currentPack || nextPack || prefetchingRef.current) return
    prefetchingRef.current = true
    ;(async () => {
      const pack = await loadPackByWeightedPick(currentPack.series.id)
      if (mountedRef.current && pack) setNextPack(pack)
      prefetchingRef.current = false
    })()
  }, [currentPack, loadPackByWeightedPick, nextPack])

  useEffect(() => {
    if (!leftCurrent) return
    if (viewMode === 'mosaic') return
    clearTimer(leftTimerRef)
    leftTimerRef.current = setTimeout(() => advanceLane('left'), leftCurrent.durationMs)
    return () => clearTimer(leftTimerRef)
  }, [advanceLane, leftCurrent, viewMode])

  useEffect(() => {
    if (!useDualLane || !rightCurrent) return
    if (viewMode === 'mosaic') return
    clearTimer(rightTimerRef)
    rightTimerRef.current = setTimeout(() => advanceLane('right'), rightCurrent.durationMs)
    return () => clearTimer(rightTimerRef)
  }, [advanceLane, rightCurrent, useDualLane, viewMode])

  useEffect(() => {
    if (!currentPack) return
    // If layout mode changes during playback, restart cleanly in the same series pack.
    setLeftPrevious(null)
    setRightPrevious(null)
    setLeftCurrent(null)
    setRightCurrent(null)
    setLeftIndex(0)
    setRightIndex(-1)
    cursorRef.current = 0
    const left = pullNextImage()
    if (left) updateLaneVisual('left', left.image, left.index)
    if (useDualLane && currentPack.images.length > 1) {
      clearTimer(rightStartRef)
      rightStartRef.current = setTimeout(() => {
        const right = pullNextImage()
        if (!mountedRef.current || !right) return
        updateLaneVisual('right', right.image, right.index)
      }, RIGHT_LANE_START_DELAY_MS)
    }
  }, [useDualLane, viewMode]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewMode !== 'mosaic') return
    if (!currentPack?.images?.length) return
    clearTimer(mosaicTimerRef)
    mosaicTimerRef.current = setTimeout(async () => {
      setMosaicOffset(prev => prev + 1)
      mosaicSwitchTickRef.current += 1
      if (mosaicSwitchTickRef.current >= Math.max(6, currentPack.images.length)) {
        mosaicSwitchTickRef.current = 0
        await switchToNextPack()
      }
    }, MOSAIC_SHIFT_MS)
    return () => clearTimer(mosaicTimerRef)
  }, [currentPack, mosaicOffset, switchToNextPack, viewMode])

  const activeImage = useMemo(() => {
    if (viewMode === 'mosaic') {
      const images = currentPack?.images || []
      if (!images.length) return null
      const index = mosaicOffset % images.length
      return images[index]
    }
    if (!useDualLane) return leftCurrent?.image || null
    return rightCurrent?.image || leftCurrent?.image || null
  }, [currentPack, leftCurrent, mosaicOffset, rightCurrent, useDualLane, viewMode])

  const dotActiveIndexes = useMemo(() => {
    if (viewMode === 'mosaic') {
      const images = currentPack?.images || []
      if (!images.length) return []
      return [mosaicOffset % images.length]
    }
    if (!useDualLane) return [leftIndex]
    return [leftIndex, rightIndex].filter(v => v >= 0)
  }, [currentPack, leftIndex, mosaicOffset, rightIndex, useDualLane, viewMode])

  const mosaicTiles = useMemo(() => {
    if (viewMode !== 'mosaic') return []
    const images = currentPack?.images || []
    if (!images.length) return []
    const isWide = viewport.width > viewport.height
    const cols = isWide ? 6 : 4
    const rows = isWide ? 3 : 5
    const count = cols * rows
    const tiles = []
    for (let i = 0; i < count; i += 1) {
      const idx = (mosaicOffset + i) % images.length
      const image = images[idx]
      tiles.push({
        image,
        idx,
        key: `${image.url}-${i}-${mosaicOffset}`
      })
    }
    return { tiles, cols }
  }, [currentPack, mosaicOffset, viewMode, viewport.height, viewport.width])

  const renderVisualLayer = (visual, isFadingLayer, fitMode = 'cover') => {
    if (!visual) return null
    return (
      <div
        key={visual.key}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: isFadingLayer ? (visual.fadingOut ? 0 : 1) : 1,
          transition: `opacity ${FADE_MS}ms ease`,
          zIndex: isFadingLayer ? 1 : 2,
          overflow: 'hidden'
        }}
      >
        <img
          src={visual.image.url}
          alt={visual.image.title || 'Shelf cinema image'}
          style={{
            width: '100%',
            height: '100%',
            objectFit: fitMode,
            filter: 'saturate(1.04)',
            animation: `shelfCinemaKenBurns ${visual.durationMs}ms linear forwards`,
            transformOrigin: 'center center',
            '--drift-x': visual.driftX,
            '--drift-y': visual.driftY,
            '--end-scale': String(visual.endScale || 1.03)
          }}
        />
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      style={styles.root}
      onClick={handleExit}
      onMouseMove={setOverlayVisibleWithTimeout}
      role="presentation"
    >
      <style>{`
        @keyframes shelfCinemaKenBurns {
          from { transform: translate3d(0, 0, 0) scale(1); }
          to { transform: translate3d(var(--drift-x), var(--drift-y), 0) scale(var(--end-scale)); }
        }
        @keyframes shelfGalleryDrift {
          from { transform: translateX(-1.2%); }
          to { transform: translateX(1.2%); }
        }
        @keyframes shelfMosaicShift {
          from { transform: translate3d(0, 0, 0); }
          to { transform: translate3d(-1.2%, 0, 0); }
        }
      `}</style>

      {viewMode === 'mosaic' ? (
        <div style={styles.mosaicWrap}>
          <div
            style={{
              ...styles.mosaicGrid,
              gridTemplateColumns: `repeat(${mosaicTiles.cols || 1}, 1fr)`
            }}
          >
            {(mosaicTiles.tiles || []).map((tile, idx) => (
              <div
                key={tile.key}
                style={{
                  ...styles.mosaicTile,
                  opacity: idx % 5 === 0 ? 0.92 : 0.82
                }}
              >
                <img
                  src={tile.image.url}
                  alt={tile.image.title || 'Mosaic tile'}
                  style={styles.mosaicImage}
                />
              </div>
            ))}
          </div>
        </div>
      ) : viewMode === 'gallery' ? (
        <div style={styles.galleryBackdrop}>
          <div style={styles.galleryFrame}>
            {renderVisualLayer(leftPrevious, true, 'contain')}
            {renderVisualLayer(leftCurrent, false, 'contain')}
          </div>
        </div>
      ) : !useDualLane ? (
        <>
          {renderVisualLayer(leftPrevious, true, 'contain')}
          {renderVisualLayer(leftCurrent, false, 'contain')}
        </>
      ) : (
        <div style={styles.dualWrap}>
          <div style={styles.dualPane}>
            {renderVisualLayer(leftPrevious, true, 'contain')}
            {renderVisualLayer(leftCurrent, false, 'contain')}
          </div>
          <div style={styles.dualPane}>
            {renderVisualLayer(rightPrevious, true, 'contain')}
            {renderVisualLayer(rightCurrent, false, 'contain')}
          </div>
        </div>
      )}

      <div style={styles.vignette} />

      {loading && !currentPack && (
        <div style={styles.centerMessage}>Loading Shelf Cinema...</div>
      )}
      {!loading && error && !currentPack && (
        <div style={styles.centerMessage}>Unable to start Shelf Cinema: {error}</div>
      )}

      <div style={{ ...styles.overlay, opacity: overlayVisible ? 1 : 0 }}>
        <button
          onClick={(event) => {
            event.stopPropagation()
            handleExit()
          }}
          style={styles.closeBtn}
          title="Exit experience"
        >
          ✕
        </button>

        <div style={styles.bottomLeft}>
          <div style={styles.seriesName}>{currentPack?.series?.name || ''}</div>
          <div style={styles.authorName}>{currentPack?.series?.author_name || ''}</div>
          {viewMode === 'cinema' && useDualLane && (
            <div style={styles.modeHint}>Dual-lane mode</div>
          )}
          {viewMode === 'gallery' && <div style={styles.modeHint}>Gallery mode</div>}
          {viewMode === 'mosaic' && <div style={styles.modeHint}>Mosaic mode</div>}
        </div>

        <div style={styles.bottomCenter}>
          {(currentPack?.images || []).map((image, idx) => (
            <span
              key={`${image.url}-${idx}`}
              style={{
                ...styles.dot,
                opacity: dotActiveIndexes.includes(idx) ? 0.95 : 0.3,
                transform: dotActiveIndexes.includes(idx) ? 'scale(1.05)' : 'scale(0.9)'
              }}
            />
          ))}
        </div>

        <div style={styles.bottomRight}>
          {currentPack?.series?.tier && (
            <span style={{
              ...styles.tierBadge,
              background: TIER_COLORS[currentPack.series.tier] || '#555',
              color: '#0f0e0c'
            }}>
              {currentPack.series.tier}
            </span>
          )}
          {activeImage?.source === 'fanart' && (
            <div style={styles.creditRow} onClick={event => event.stopPropagation()}>
              <span style={styles.creditLabel}>fan art by </span>
              {activeImage.creator_url ? (
                <a href={activeImage.creator_url} target="_blank" rel="noopener noreferrer" style={styles.creditLink}>
                  {activeImage.creator || 'artist'}
                </a>
              ) : (
                <span style={styles.creditLabel}>{activeImage.creator || 'artist'}</span>
              )}
              {activeImage.external_link && (
                <>
                  <span style={styles.creditLabel}> · </span>
                  <a href={activeImage.external_link} target="_blank" rel="noopener noreferrer" style={styles.creditLink}>
                    source
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  root: {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    zIndex: 9999,
    background: '#000',
    overflow: 'hidden',
    cursor: 'default'
  },
  dualWrap: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 0
  },
  dualPane: {
    position: 'relative',
    overflow: 'hidden',
    background: '#000'
  },
  galleryBackdrop: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle, #1b1712 0%, #0f0e0c 65%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    animation: 'shelfGalleryDrift 18s ease-in-out infinite alternate'
  },
  galleryFrame: {
    position: 'relative',
    width: 'min(78vw, 980px)',
    height: 'min(82vh, 1180px)',
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.22)',
    background: 'rgba(0,0,0,0.72)',
    boxShadow: '0 24px 72px rgba(0,0,0,0.62), inset 0 0 0 12px rgba(220,190,150,0.08)',
    overflow: 'hidden'
  },
  mosaicWrap: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    background: '#080808'
  },
  mosaicGrid: {
    position: 'absolute',
    inset: '-2%',
    display: 'grid',
    gridAutoRows: '1fr',
    gap: 8,
    padding: 8,
    animation: 'shelfMosaicShift 12s linear infinite alternate'
  },
  mosaicTile: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.08)',
    background: '#101010',
    transition: 'opacity 900ms ease'
  },
  mosaicImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
    filter: 'saturate(1.03)'
  },
  vignette: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle, rgba(0,0,0,0.0) 40%, rgba(0,0,0,0.26) 100%)',
    zIndex: 3,
    pointerEvents: 'none'
  },
  centerMessage: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    color: '#e8e4dc',
    fontSize: 16,
    zIndex: 5,
    textShadow: '0 2px 8px rgba(0,0,0,0.65)'
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 6,
    transition: 'opacity 280ms ease',
    pointerEvents: 'auto'
  },
  closeBtn: {
    position: 'absolute',
    top: 16,
    right: 18,
    border: '1px solid rgba(255,255,255,0.35)',
    background: 'rgba(0,0,0,0.38)',
    color: '#fff',
    width: 30,
    height: 30,
    borderRadius: 16,
    cursor: 'pointer',
    fontSize: 15,
    textShadow: '0 2px 6px rgba(0,0,0,0.7)'
  },
  bottomLeft: {
    position: 'absolute',
    left: 28,
    bottom: 26
  },
  seriesName: {
    color: '#fff',
    fontSize: 32,
    fontWeight: 600,
    letterSpacing: '0.2px',
    textShadow: '0 2px 12px rgba(0,0,0,0.8)'
  },
  authorName: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 16,
    marginTop: 4,
    textShadow: '0 2px 10px rgba(0,0,0,0.75)'
  },
  modeHint: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    marginTop: 6,
    textShadow: '0 2px 10px rgba(0,0,0,0.75)'
  },
  bottomCenter: {
    position: 'absolute',
    left: '50%',
    bottom: 28,
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 7
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.92)',
    transition: 'all 220ms ease'
  },
  bottomRight: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 9
  },
  tierBadge: {
    borderRadius: 999,
    fontWeight: 700,
    fontSize: 14,
    minWidth: 34,
    textAlign: 'center',
    padding: '6px 12px',
    textShadow: 'none'
  },
  creditRow: {
    color: '#fff',
    fontSize: 12,
    textShadow: '0 2px 10px rgba(0,0,0,0.8)'
  },
  creditLabel: {
    color: 'rgba(255,255,255,0.9)'
  },
  creditLink: {
    color: '#fff',
    textDecoration: 'underline',
    textUnderlineOffset: '2px'
  }
}
