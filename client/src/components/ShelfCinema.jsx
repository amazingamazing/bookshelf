import React, { useCallback, useEffect, useRef, useState } from 'react'
import { readCinemaControls } from '../lib/cinemaControls'

const TIER_WEIGHTS = { S: 5, A: 4, B: 3, C: 2, D: 1 }
const TIER_COLORS = { S: '#f4c542', A: '#6ea8fe', B: '#5cb85c', C: '#e67e22', D: '#e74c3c' }
const OVERLAY_HIDE_MS = 3000
const ATTRIBUTION_HIDE_MS = 5000

export default function ShelfCinema({ onExit }) {
  const rootRef = useRef(null)
  const mountedRef = useRef(false)
  const queueRef = useRef({ series: null, images: [], cursor: 0 })
  const controlsRef = useRef(readCinemaControls())
  const timerRef = useRef(null)
  const overlayTimerRef = useRef(null)
  const fadeTimerRef = useRef(null)
  const attributionTimerRef = useRef(null)
  const advanceRef = useRef(() => {})
  const prefetchNextQueueRef = useRef(async () => null)
  const requestsRef = useRef(new Set())
  const failedImageUrlsRef = useRef(new Set())
  const debugLogRef = useRef([])
  const prefetchedQueueRef = useRef(null)
  const recentFanartUrlsRef = useRef([])
  const preloadedImageUrlsRef = useRef(new Set())

  const [seriesPool, setSeriesPool] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [controls, setControls] = useState(() => readCinemaControls())
  const [currentSeries, setCurrentSeries] = useState(null)
  const [currentSlide, setCurrentSlide] = useState(null)
  const [previousSlide, setPreviousSlide] = useState(null)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [attributionVisible, setAttributionVisible] = useState(false)
  const [debugCopiedAt, setDebugCopiedAt] = useState(0)

  const logDebug = useCallback((event, details = {}) => {
    const entry = {
      ts: new Date().toISOString(),
      event,
      details
    }
    const next = [...debugLogRef.current, entry]
    debugLogRef.current = next.slice(-80)
  }, [])

  const refreshControls = useCallback(() => {
    const latest = readCinemaControls()
    controlsRef.current = latest
    setControls(latest)
    return latest
  }, [])

  const clearTimer = (timerRef) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const clearAllTimers = useCallback(() => {
    clearTimer(timerRef)
    clearTimer(overlayTimerRef)
    clearTimer(fadeTimerRef)
    clearTimer(attributionTimerRef)
  }, [])

  const scheduleOverlayAutoHide = useCallback(() => {
    setOverlayVisible(true)
    clearTimer(overlayTimerRef)
    overlayTimerRef.current = setTimeout(() => setOverlayVisible(false), OVERLAY_HIDE_MS)
  }, [])

  const handleExit = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {})
    }
    onExit()
  }, [onExit])

  const pullNextImageFromQueue = useCallback(() => {
    const queue = queueRef.current
    if (!queue.images.length || queue.cursor >= queue.images.length) return null
    const image = queue.images[queue.cursor]
    queue.cursor += 1
    return image
  }, [])

  const preloadImage = useCallback((url, timeoutMs = 8000) => {
    return new Promise((resolve) => {
      const safeUrl = String(url || '').trim()
      if (!safeUrl) {
        resolve(false)
        return
      }
      if (preloadedImageUrlsRef.current.has(safeUrl)) {
        resolve(true)
        return
      }
      const image = new Image()
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        if (ok) preloadedImageUrlsRef.current.add(safeUrl)
        resolve(ok)
      }
      const timeout = setTimeout(() => finish(false), timeoutMs)
      image.onload = () => {
        clearTimeout(timeout)
        finish(true)
      }
      image.onerror = () => {
        clearTimeout(timeout)
        finish(false)
      }
      image.src = safeUrl
    })
  }, [])

  const preloadImages = useCallback(async (urls) => {
    const safeUrls = (Array.isArray(urls) ? urls : []).filter(Boolean)
    if (!safeUrls.length) return []
    const results = await Promise.all(safeUrls.map(url => preloadImage(url)))
    return safeUrls.filter((_, index) => results[index])
  }, [preloadImage])

  const fetchSeriesQueue = useCallback(async (series, runtimeControls, options = {}) => {
    const controller = new AbortController()
    requestsRef.current.add(controller)
    try {
      const fanartEnabled = options.forceFanartEnabled == null
        ? runtimeControls.fanartEnabled
        : Boolean(options.forceFanartEnabled)
      const fanartPerCover = options.forceFanartPerCover == null
        ? runtimeControls.fanartPerCover
        : options.forceFanartPerCover
      const params = new URLSearchParams({
        fanart_enabled: fanartEnabled ? 'true' : 'false',
        fanart_per_cover: String(fanartPerCover)
      })
      logDebug('queue_fetch_start', {
        seriesId: series.id,
        seriesName: series.name,
        fanartEnabled,
        fanartPerCover
      })
      const response = await fetch(`/api/cinema/series-images/${series.id}?${params.toString()}`, {
        signal: controller.signal
      })
      const data = await response.json()
      if (!response.ok) {
        logDebug('queue_fetch_failed', {
          seriesId: series.id,
          seriesName: series.name,
          status: response.status,
          error: data?.error || null
        })
        return null
      }

      const unique = []
      const seen = new Set()
      for (const image of (data.images || [])) {
        const url = String(image?.url || '').trim()
        if (!url || seen.has(url)) continue
        seen.add(url)
        unique.push({
          url,
          kind: image.kind || (image.source === 'fanart' ? 'fanart' : 'cover'),
          source: image.source || 'unknown',
          title: image.title || series.name,
          creator: image.creator || null,
          creator_url: image.creator_url || null,
          external_link: image.external_link || null
        })
      }
      if (!unique.length) return null
      const recentSet = new Set(recentFanartUrlsRef.current)
      const fanartFresh = unique.filter(image => image.source === 'fanart' && !recentSet.has(image.url))
      const fanartSeen = unique.filter(image => image.source === 'fanart' && recentSet.has(image.url))
      const covers = unique.filter(image => image.source !== 'fanart')
      const diversified = interleaveFanartGroups(covers, fanartFresh, fanartSeen)
      logDebug('queue_loaded', {
        seriesId: series.id,
        seriesName: series.name,
        imageCount: diversified.length,
        freshFanart: fanartFresh.length,
        fanartCount: fanartFresh.length + fanartSeen.length,
        coverCount: covers.length
      })
      return { series, images: diversified }
    } catch (err) {
      logDebug('queue_fetch_error', {
        seriesId: series.id,
        seriesName: series.name,
        message: err?.message || 'Unknown error'
      })
      return null
    } finally {
      requestsRef.current.delete(controller)
    }
  }, [logDebug])

  const weightedPickSeries = useCallback((pool) => {
    if (!pool.length) return null
    const totalWeight = pool.reduce((sum, s) => sum + (TIER_WEIGHTS[s.tier] || 0), 0)
    if (totalWeight <= 0) return pool[Math.floor(Math.random() * pool.length)] || null
    let roll = Math.random() * totalWeight
    for (const series of pool) {
      roll -= (TIER_WEIGHTS[series.tier] || 0)
      if (roll <= 0) return series
    }
    return pool[pool.length - 1]
  }, [])

  const pickNextSeriesQueue = useCallback(async () => {
    const runtimeControls = refreshControls()
    const allowed = applySeriesRules(seriesPool, runtimeControls.seriesRules)
    if (!allowed.length) {
      logDebug('no_allowed_series_after_rules', {
        seriesPoolSize: seriesPool.length,
        seriesRulesCount: Object.keys(runtimeControls.seriesRules || {}).length
      })
      return null
    }

    for (let attempts = 0; attempts < allowed.length * 2; attempts += 1) {
      const picked = weightedPickSeries(allowed)
      if (!picked) break
      logDebug('series_picked', {
        attempt: attempts + 1,
        seriesId: picked.id,
        seriesName: picked.name,
        tier: picked.tier
      })
      const queue = await fetchSeriesQueue(picked, runtimeControls)
      if (queue?.images?.length) return queue
    }
    logDebug('no_queue_from_any_pick', { allowedCount: allowed.length })
    return null
  }, [fetchSeriesQueue, logDebug, refreshControls, seriesPool, weightedPickSeries])

  const prefetchUpcomingFromCurrentQueue = useCallback(() => {
    const queue = queueRef.current
    const upcoming = (queue.images || []).slice(queue.cursor, queue.cursor + 2).map(item => item.url).filter(Boolean)
    if (!upcoming.length) return
    preloadImages(upcoming).then(() => {})
  }, [preloadImages])

  const rememberFanartImage = useCallback((image) => {
    if (!image || image.source !== 'fanart') return
    const list = [...recentFanartUrlsRef.current, image.url]
    recentFanartUrlsRef.current = list.slice(-200)
  }, [])

  const pushSlide = useCallback((image, series) => {
    const runtimeControls = refreshControls()
    const holdMs = randomInt(
      Math.round(runtimeControls.holdMinSec * 1000),
      Math.round(runtimeControls.holdMaxSec * 1000)
    )
    const crossfadeMs = Math.round(runtimeControls.crossfadeSec * 1000)
    const slide = {
      key: `${image.url}::${Date.now()}::${Math.random()}`,
      image,
      holdMs,
      crossfadeMs,
      kenBurnsScale: runtimeControls.kenBurnsScale,
      fadingOut: false
    }

    setCurrentSeries(series)
    setCurrentSlide(prev => {
      if (prev) {
        setPreviousSlide({ ...prev, fadingOut: false, crossfadeMs })
        setTimeout(() => {
          if (!mountedRef.current) return
          setPreviousSlide(value => (value ? { ...value, fadingOut: true } : value))
        }, 20)
        clearTimer(fadeTimerRef)
        fadeTimerRef.current = setTimeout(() => setPreviousSlide(null), crossfadeMs + 80)
      }
      return slide
    })

    const isFanart = image.kind === 'fanart' || image.source === 'fanart'
    setAttributionVisible(isFanart)
    clearTimer(attributionTimerRef)
    if (isFanart) {
      attributionTimerRef.current = setTimeout(() => setAttributionVisible(false), ATTRIBUTION_HIDE_MS)
    }

    clearTimer(timerRef)
    timerRef.current = setTimeout(() => advanceRef.current(), holdMs)
  }, [refreshControls])

  const advance = useCallback(async () => {
    if (!mountedRef.current) return
    let nextImage = pullNextImageFromQueue()
    let series = queueRef.current.series
    if (!nextImage) {
      let nextQueue = prefetchedQueueRef.current
      prefetchedQueueRef.current = null
      if (!nextQueue) nextQueue = await pickNextSeriesQueue()
      if (!mountedRef.current) return
      if (!nextQueue) {
        setError('No eligible series with images available for Shelf Cinema.')
        logDebug('advance_no_next_queue', {
          seriesPoolSize: seriesPool.length
        })
        return
      }
      queueRef.current = { series: nextQueue.series, images: nextQueue.images, cursor: 0 }
      nextImage = pullNextImageFromQueue()
      series = nextQueue.series
    }
    if (!nextImage) {
      setError('Could not load the next image.')
      logDebug('advance_no_next_image', {})
      return
    }
    await preloadImages([nextImage.url])
    if (!mountedRef.current) return
    setError(null)
    logDebug('slide_pushed', {
      seriesId: series?.id || null,
      imageUrl: nextImage.url,
      source: nextImage.source
    })
    rememberFanartImage(nextImage)
    pushSlide(nextImage, series)
    prefetchUpcomingFromCurrentQueue()
    prefetchNextQueueRef.current(series?.id || null)
  }, [logDebug, pickNextSeriesQueue, prefetchUpcomingFromCurrentQueue, preloadImages, pullNextImageFromQueue, pushSlide, rememberFanartImage, seriesPool.length])

  const prefetchNextQueue = useCallback(async (excludeSeriesId = null) => {
    if (prefetchedQueueRef.current) return prefetchedQueueRef.current
    const runtimeControls = refreshControls()
    const allowed = applySeriesRules(seriesPool, runtimeControls.seriesRules)
      .filter(series => Number(series.id) !== Number(excludeSeriesId))
    if (!allowed.length) return null

    for (let attempts = 0; attempts < allowed.length * 2; attempts += 1) {
      const picked = weightedPickSeries(allowed)
      if (!picked) break
      const queue = await fetchSeriesQueue(picked, runtimeControls)
      if (!queue?.images?.length) continue
      const firstFew = queue.images.slice(0, 3).map(item => item.url).filter(Boolean)
      await preloadImages(firstFew)
      prefetchedQueueRef.current = queue
      logDebug('next_queue_prefetched', {
        seriesId: picked.id,
        seriesName: picked.name,
        imageCount: queue.images.length
      })
      return queue
    }
    return null
  }, [fetchSeriesQueue, logDebug, preloadImages, refreshControls, seriesPool, weightedPickSeries])

  useEffect(() => {
    prefetchNextQueueRef.current = prefetchNextQueue
  }, [prefetchNextQueue])

  const hydrateCurrentSeriesWithFanart = useCallback(async (series, runtimeControls) => {
    if (!runtimeControls.fanartEnabled) return
    const fullQueue = await fetchSeriesQueue(series, runtimeControls, {
      forceFanartEnabled: true
    })
    if (!mountedRef.current || !fullQueue?.images?.length) return
    const currentQueue = queueRef.current
    if (!currentQueue?.series || Number(currentQueue.series.id) !== Number(series.id)) return
    const cursor = Math.max(1, Number(currentQueue.cursor) || 1)
    queueRef.current = {
      series: fullQueue.series,
      images: fullQueue.images,
      cursor: Math.min(cursor, Math.max(0, fullQueue.images.length - 1))
    }
    logDebug('queue_hydrated_with_fanart', {
      seriesId: series.id,
      oldImageCount: currentQueue.images.length,
      newImageCount: fullQueue.images.length,
      cursor
    })
    preloadImages(fullQueue.images.slice(cursor, cursor + 3).map(item => item.url)).then(() => {})
  }, [fetchSeriesQueue, logDebug, preloadImages])

  const handleImageError = useCallback((url, layer) => {
    const safeUrl = String(url || '')
    if (!safeUrl || failedImageUrlsRef.current.has(safeUrl)) return
    failedImageUrlsRef.current.add(safeUrl)
    logDebug('image_load_error', { url: safeUrl, layer })
    clearTimer(timerRef)
    setError('Some images failed to load. Skipping broken image...')
    setTimeout(() => {
      if (!mountedRef.current) return
      setError(null)
      advanceRef.current()
    }, 80)
  }, [logDebug])

  const copyDebugSnapshot = useCallback(async () => {
    const queue = queueRef.current
    const snapshot = {
      timestamp: new Date().toISOString(),
      currentSeries,
      currentSlide: currentSlide ? {
        key: currentSlide.key,
        image: currentSlide.image,
        holdMs: currentSlide.holdMs,
        crossfadeMs: currentSlide.crossfadeMs
      } : null,
      queue: {
        series: queue.series,
        cursor: queue.cursor,
        imageCount: Array.isArray(queue.images) ? queue.images.length : 0,
        nextImageUrl: queue.images?.[queue.cursor]?.url || null
      },
      controls: controlsRef.current,
      state: {
        loading,
        error,
        seriesPoolSize: seriesPool.length,
        allowedSeriesSize: applySeriesRules(seriesPool, controlsRef.current.seriesRules).length,
        activeRequests: requestsRef.current.size,
        failedImageCount: failedImageUrlsRef.current.size
      },
      recentLog: debugLogRef.current
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
      setDebugCopiedAt(Date.now())
      logDebug('debug_snapshot_copied', {})
    } catch {
      setError('Could not copy debug snapshot to clipboard.')
      logDebug('debug_snapshot_copy_failed', {})
    }
  }, [currentSeries, currentSlide, error, loading, logDebug, seriesPool])

  useEffect(() => {
    advanceRef.current = advance
  }, [advance])

  useEffect(() => {
    mountedRef.current = true
    scheduleOverlayAutoHide()
    refreshControls()
    logDebug('cinema_mount', {})

    const onKeyDown = (event) => {
      if (event.key === 'Escape') handleExit()
    }
    const onStorage = () => {
      refreshControls()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('storage', onStorage)

    if (rootRef.current && !document.fullscreenElement && rootRef.current.requestFullscreen) {
      rootRef.current.requestFullscreen().catch(() => {})
    }

    ;(async () => {
      try {
        const response = await fetch('/api/series')
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Failed to load series')
        const eligible = (Array.isArray(data) ? data : [])
          .map(s => ({
            id: Number(s.id),
            name: s.name,
            author_name: s.author_name,
            tier: String(s.tier || '').toUpperCase(),
            book_count: Number(s.book_count) || 0
          }))
          .filter(s => s.book_count > 0 && Number(TIER_WEIGHTS[s.tier] || 0) > 0)
        setSeriesPool(eligible)
        logDebug('series_loaded', {
          totalFromApi: Array.isArray(data) ? data.length : 0,
          eligibleCount: eligible.length
        })
        if (!eligible.length) {
          setError('No ranked (S/A/B/C/D) library series found for Shelf Cinema.')
        }
      } catch (err) {
        setError(err.message)
        logDebug('series_load_error', { message: err.message })
      } finally {
        setLoading(false)
      }
    })()

    return () => {
      mountedRef.current = false
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('storage', onStorage)
      clearAllTimers()
      for (const controller of requestsRef.current) controller.abort()
      requestsRef.current.clear()
    }
  }, [clearAllTimers, handleExit, refreshControls, scheduleOverlayAutoHide])

  useEffect(() => {
    if (!seriesPool.length || currentSlide) return
    ;(async () => {
      const runtimeControls = refreshControls()
      const allowed = applySeriesRules(seriesPool, runtimeControls.seriesRules)
      if (!allowed.length) {
        setError('No eligible series with images available for Shelf Cinema.')
        return
      }
      const firstSeries = weightedPickSeries(allowed)
      let startupQueue = null
      if (firstSeries) {
        startupQueue = await fetchSeriesQueue(firstSeries, runtimeControls, {
          forceFanartEnabled: false,
          forceFanartPerCover: 0
        })
      }
      if (!startupQueue?.images?.length) {
        startupQueue = prefetchedQueueRef.current || await pickNextSeriesQueue()
      }
      if (!mountedRef.current) return
      if (!startupQueue?.images?.length) {
        setError('No eligible series with images available for Shelf Cinema.')
        return
      }
      prefetchedQueueRef.current = null
      queueRef.current = { series: startupQueue.series, images: startupQueue.images, cursor: 0 }
      const firstUrl = startupQueue.images[0]?.url || null
      if (firstUrl) await preloadImages([firstUrl])
      preloadImages(startupQueue.images.slice(1, 4).map(item => item.url)).then(() => {})
      if (!mountedRef.current) return
      const firstImage = pullNextImageFromQueue()
      if (!firstImage) {
        setError('Could not load the first image.')
        return
      }
      rememberFanartImage(firstImage)
      pushSlide(firstImage, startupQueue.series)
      prefetchUpcomingFromCurrentQueue()
      prefetchNextQueue(startupQueue.series.id)
      hydrateCurrentSeriesWithFanart(startupQueue.series, runtimeControls)
    })()
  }, [currentSlide, fetchSeriesQueue, hydrateCurrentSeriesWithFanart, pickNextSeriesQueue, prefetchNextQueue, prefetchUpcomingFromCurrentQueue, preloadImages, pullNextImageFromQueue, pushSlide, refreshControls, rememberFanartImage, seriesPool, weightedPickSeries])

  return (
    <div
      ref={rootRef}
      style={styles.root}
      onClick={handleExit}
      onMouseMove={scheduleOverlayAutoHide}
      role="presentation"
    >
      <style>{`
        @keyframes shelfCinemaForegroundKenBurns {
          from { transform: scale(1); }
          to { transform: scale(var(--ken-burns-scale, 1)); }
        }
      `}</style>

      {renderSlide(previousSlide, true)}
      {renderSlide(currentSlide, false, handleImageError)}

      {loading && !currentSlide && (
        <div style={styles.centerMessage}>Loading Shelf Cinema...</div>
      )}
      {!loading && error && !currentSlide && (
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
          x
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation()
            copyDebugSnapshot()
          }}
          style={styles.debugBtn}
          title="Copy Shelf Cinema debug snapshot"
        >
          {Date.now() - debugCopiedAt < 2500 ? 'Copied' : 'Copy Debug'}
        </button>

        <div style={styles.bottomLeft}>
          <div style={styles.seriesName}>{currentSeries?.name || ''}</div>
          <div style={styles.authorName}>{currentSeries?.author_name || ''}</div>
          {(currentSlide?.image?.source === 'fanart' || currentSlide?.image?.kind === 'fanart') && (
            <div
              style={{
                ...styles.leftCreditRow,
                opacity: attributionVisible ? 1 : 0,
                transition: `opacity ${Math.max(140, Math.round((controls.crossfadeSec || 1) * 1000 * 0.6))}ms ease`
              }}
              onClick={event => event.stopPropagation()}
            >
              {currentSlide?.image?.creator_url ? (
                <a href={currentSlide.image.creator_url} target="_blank" rel="noopener noreferrer" style={styles.leftCreditLink}>
                  @{currentSlide.image.creator || 'artist'}
                </a>
              ) : currentSlide?.image?.external_link ? (
                <a href={currentSlide.image.external_link} target="_blank" rel="noopener noreferrer" style={styles.leftCreditLink}>
                  @{currentSlide.image.creator || 'artist'}
                </a>
              ) : (
                <span style={styles.leftCreditLabel}>@{currentSlide?.image?.creator || 'artist'}</span>
              )}
            </div>
          )}
        </div>

        <div style={styles.bottomRight}>
          {currentSeries?.tier && (
            <span style={{
              ...styles.tierBadge,
              background: TIER_COLORS[currentSeries.tier] || '#555',
              color: '#0a0806'
            }}>
              {currentSeries.tier}
            </span>
          )}
          {(currentSlide?.image?.source === 'fanart' || currentSlide?.image?.kind === 'fanart') && currentSlide?.image?.external_link && (
            <a
              href={currentSlide.image.external_link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={event => event.stopPropagation()}
              style={styles.creditLink}
            >
              View artwork
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

function renderSlide(slide, isPrevious, onImageError) {
  if (!slide) return null
  const opacity = isPrevious ? (slide.fadingOut ? 0 : 1) : 1
  const transition = `opacity ${slide.crossfadeMs}ms ease`
  return (
    <div
      key={slide.key}
      style={{
        ...styles.slideLayer,
        opacity,
        transition,
        zIndex: isPrevious ? 1 : 2
      }}
    >
      <div style={styles.backdropBase}>
        <img
          src={slide.image.url}
          alt=""
          onError={() => onImageError?.(slide.image.url, 'backdrop')}
          style={styles.backdropImage}
        />
      </div>

      <div style={styles.foregroundWrap}>
        <img
          src={slide.image.url}
          alt={slide.image.title || 'Shelf cinema image'}
          onError={() => onImageError?.(slide.image.url, 'foreground')}
          style={{
            ...styles.foregroundImage,
            animation: `shelfCinemaForegroundKenBurns ${slide.holdMs}ms linear forwards`,
            '--ken-burns-scale': String(Math.max(1, slide.kenBurnsScale || 1))
          }}
        />
      </div>
    </div>
  )
}

function randomInt(min, max) {
  const lo = Math.ceil(Number(min) || 0)
  const hi = Math.floor(Number(max) || 0)
  if (hi <= lo) return lo
  return Math.floor(Math.random() * (hi - lo + 1)) + lo
}

function applySeriesRules(seriesPool, seriesRules) {
  const rules = seriesRules && typeof seriesRules === 'object' ? seriesRules : {}
  const whitelist = new Set()
  const blacklist = new Set()
  for (const [id, mode] of Object.entries(rules)) {
    if (mode === 'whitelist') whitelist.add(String(id))
    if (mode === 'blacklist') blacklist.add(String(id))
  }
  return (seriesPool || []).filter(series => {
    const id = String(series.id)
    if (blacklist.has(id)) return false
    if (whitelist.size > 0 && !whitelist.has(id)) return false
    return true
  })
}

function interleaveFanartGroups(covers, freshFanart, seenFanart) {
  const output = []
  const fresh = [...freshFanart]
  const seen = [...seenFanart]
  const coverList = [...covers]
  for (let index = 0; index < coverList.length; index += 1) {
    output.push(coverList[index])
    if (index >= coverList.length - 1) continue
    const bucket = fresh.length ? fresh : seen
    if (bucket.length) output.push(bucket.shift())
  }
  while (fresh.length) output.push(fresh.shift())
  while (seen.length) output.push(seen.shift())
  return output
}

const styles = {
  root: {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    zIndex: 9999,
    background: '#0a0806',
    overflow: 'hidden',
    cursor: 'default'
  },
  slideLayer: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden'
  },
  backdropBase: {
    position: 'absolute',
    inset: 0,
    background: '#0a0806',
    overflow: 'hidden'
  },
  backdropImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: 'scale(1.1)',
    filter: 'blur(40px) brightness(0.35)'
  },
  foregroundWrap: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  foregroundImage: {
    width: 'auto',
    maxWidth: '88vw',
    maxHeight: '88vh',
    objectFit: 'contain',
    boxShadow: '0 24px 70px rgba(0, 0, 0, 0.72)',
    transformOrigin: 'center center'
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
    background: 'rgba(10,8,6,0.55)',
    color: '#fff',
    width: 30,
    height: 30,
    borderRadius: 16,
    cursor: 'pointer',
    fontSize: 15
  },
  debugBtn: {
    position: 'absolute',
    top: 16,
    right: 56,
    border: '1px solid rgba(255,255,255,0.35)',
    background: 'rgba(26,24,20,0.7)',
    color: '#e8e4dc',
    borderRadius: 999,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12
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
  leftCreditRow: {
    marginTop: 8,
    fontSize: 12,
    color: 'rgba(232,228,220,0.85)',
    textShadow: '0 2px 10px rgba(0,0,0,0.75)'
  },
  leftCreditLabel: {
    color: 'rgba(232,228,220,0.85)'
  },
  leftCreditLink: {
    color: 'rgba(232,228,220,0.9)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px'
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
  creditLink: {
    color: '#fff',
    textDecoration: 'underline',
    textUnderlineOffset: '2px'
  }
}
