import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const FANART_PREFS_KEY = 'bookshelf:fanart-prefs:v1'
const TIERS = ['S', 'A', 'B', 'C', 'D']
const TIER_WEIGHTS = { S: 10, A: 6, B: 3, C: 1, D: 0.3 }
const TIER_COLORS = { S: '#f4c542', A: '#6ea8fe', B: '#5cb85c', C: '#e67e22', D: '#e74c3c' }
const FADE_MS = 1500
const OVERLAY_HIDE_MS = 3000

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

function shuffleTail(items) {
  if (items.length <= 1) return items
  const [first, ...rest] = items
  const copy = [...rest]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return [first, ...copy]
}

function createVisual(image, index) {
  return {
    key: `${image.url}::${index}::${Date.now()}`,
    image,
    durationMs: randomInt(6000, 10000),
    driftX: `${(Math.random() * 7 - 3.5).toFixed(2)}%`,
    driftY: `${(Math.random() * 7 - 3.5).toFixed(2)}%`
  }
}

export default function ShelfCinema({ onExit }) {
  const [seriesPool, setSeriesPool] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [currentPack, setCurrentPack] = useState(null)
  const [nextPack, setNextPack] = useState(null)
  const [imageIndex, setImageIndex] = useState(0)
  const [currentVisual, setCurrentVisual] = useState(null)
  const [previousVisual, setPreviousVisual] = useState(null)

  const hideTimerRef = useRef(null)
  const slideTimerRef = useRef(null)
  const previousFadeTimerRef = useRef(null)
  const mountedRef = useRef(false)
  const nextPackRef = useRef(null)
  const prefetchingRef = useRef(false)
  const requestControllersRef = useRef(new Set())

  useEffect(() => {
    nextPackRef.current = nextPack
  }, [nextPack])

  const clearTimer = (timerRef) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const setOverlayVisibleWithTimeout = useCallback(() => {
    setOverlayVisible(true)
    clearTimer(hideTimerRef)
    hideTimerRef.current = setTimeout(() => setOverlayVisible(false), OVERLAY_HIDE_MS)
  }, [])

  const fetchPackForSeries = useCallback(async (series) => {
    const prefs = readFanartPrefs()
    const controller = new AbortController()
    requestControllersRef.current.add(controller)
    try {
      const params = new URLSearchParams({
        allow_mature: prefs.allowMature ? 'true' : 'false',
        min_edge: String(prefs.minEdge),
        sort_mode: 'popular',
        time_window: 'all',
        exclude_ai: 'true',
        per_creator_cap: '2'
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
          source: image.source || 'unknown',
          title: image.title || series.name,
          creator: image.creator || null,
          creator_url: image.creator_url || null,
          external_link: image.external_link || null
        })
      }
      if (deduped.length < 3) return null
      const selected = shuffleTail(deduped).slice(0, 15)
      return { series, images: selected.slice(0, Math.max(6, Math.min(15, selected.length))) }
    } catch {
      return null
    } finally {
      requestControllersRef.current.delete(controller)
    }
  }, [])

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

  const advanceImage = useCallback(async () => {
    if (!currentPack) return
    const nextIndex = imageIndex + 1
    if (nextIndex < currentPack.images.length) {
      const nextImage = currentPack.images[nextIndex]
      setImageIndex(nextIndex)
      setCurrentVisual((prev) => {
        if (prev) {
          clearTimer(previousFadeTimerRef)
          const prevLayer = { ...prev, fadingOut: false, key: `${prev.key}-prev` }
          setPreviousVisual(prevLayer)
          setTimeout(() => {
            if (!mountedRef.current) return
            setPreviousVisual((value) => (value ? { ...value, fadingOut: true } : value))
          }, 40)
          previousFadeTimerRef.current = setTimeout(() => setPreviousVisual(null), FADE_MS + 80)
        }
        return createVisual(nextImage, nextIndex)
      })
      return
    }

    let pack = nextPackRef.current
    if (!pack) pack = await loadPackByWeightedPick(currentPack.series.id)
    if (!pack) return

    setNextPack(null)
    setCurrentPack(pack)
    setImageIndex(0)
    setPreviousVisual(null)
    setCurrentVisual(createVisual(pack.images[0], 0))
  }, [currentPack, imageIndex, loadPackByWeightedPick])

  useEffect(() => {
    mountedRef.current = true
    setOverlayVisibleWithTimeout()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKeyDown)

    ;(async () => {
      try {
        const res = await fetch('/api/series')
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to load series')
        const ranked = (data || [])
          .filter(series => TIERS.includes(series.tier))
          .map(series => ({
            id: Number(series.id),
            name: series.name,
            author_name: series.author_name,
            tier: series.tier
          }))
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
      clearTimer(hideTimerRef)
      clearTimer(slideTimerRef)
      clearTimer(previousFadeTimerRef)
      for (const controller of requestControllersRef.current) controller.abort()
      requestControllersRef.current.clear()
    }
  }, [onExit, setOverlayVisibleWithTimeout])

  useEffect(() => {
    if (!seriesPool.length || currentPack) return
    ;(async () => {
      const pack = await loadPackByWeightedPick(null)
      if (!mountedRef.current || !pack) return
      setCurrentPack(pack)
      setImageIndex(0)
      setCurrentVisual(createVisual(pack.images[0], 0))
      setError(null)
    })()
  }, [currentPack, loadPackByWeightedPick, seriesPool])

  useEffect(() => {
    if (!currentPack || nextPack || prefetchingRef.current) return
    prefetchingRef.current = true
    ;(async () => {
      const pack = await loadPackByWeightedPick(currentPack.series.id)
      if (!mountedRef.current) return
      if (pack) setNextPack(pack)
      prefetchingRef.current = false
    })()
  }, [currentPack, nextPack, loadPackByWeightedPick])

  useEffect(() => {
    if (!currentVisual) return
    clearTimer(slideTimerRef)
    slideTimerRef.current = setTimeout(() => {
      advanceImage()
    }, currentVisual.durationMs)
    return () => clearTimer(slideTimerRef)
  }, [advanceImage, currentVisual])

  const activeImage = useMemo(() => {
    if (!currentPack) return null
    return currentPack.images[imageIndex] || null
  }, [currentPack, imageIndex])

  const renderLayer = (visual, isFadingLayer) => {
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
            objectFit: 'cover',
            filter: 'saturate(1.04)',
            animation: `shelfCinemaKenBurns ${visual.durationMs}ms linear forwards`,
            transformOrigin: 'center center',
            '--drift-x': visual.driftX,
            '--drift-y': visual.driftY
          }}
        />
      </div>
    )
  }

  return (
    <div
      style={styles.root}
      onClick={onExit}
      onMouseMove={setOverlayVisibleWithTimeout}
      role="presentation"
    >
      <style>{`
        @keyframes shelfCinemaKenBurns {
          from { transform: translate3d(0, 0, 0) scale(1); }
          to { transform: translate3d(var(--drift-x), var(--drift-y), 0) scale(1.08); }
        }
      `}</style>

      {renderLayer(previousVisual, true)}
      {renderLayer(currentVisual, false)}
      <div style={styles.vignette} />

      {loading && !currentPack && (
        <div style={styles.centerMessage}>Loading Shelf Cinema...</div>
      )}
      {!loading && error && !currentPack && (
        <div style={styles.centerMessage}>Unable to start Shelf Cinema: {error}</div>
      )}

      <div
        style={{
          ...styles.overlay,
          opacity: overlayVisible ? 1 : 0
        }}
      >
        <button onClick={onExit} style={styles.closeBtn} title="Exit experience">✕</button>

        <div style={styles.bottomLeft}>
          <div style={styles.seriesName}>{currentPack?.series?.name || ''}</div>
          <div style={styles.authorName}>{currentPack?.series?.author_name || ''}</div>
        </div>

        <div style={styles.bottomCenter}>
          {(currentPack?.images || []).map((image, idx) => (
            <span
              key={`${image.url}-${idx}`}
              style={{
                ...styles.dot,
                opacity: idx === imageIndex ? 0.95 : 0.32,
                transform: idx === imageIndex ? 'scale(1.05)' : 'scale(0.9)'
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
  vignette: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle, rgba(0,0,0,0.0) 40%, rgba(0,0,0,0.28) 100%)',
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
