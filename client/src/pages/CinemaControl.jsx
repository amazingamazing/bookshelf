import React, { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_CINEMA_CONTROLS,
  cycleRuleMode,
  readCinemaControls,
  writeCinemaControls
} from '../lib/cinemaControls'

export default function CinemaControl() {
  const [series, setSeries] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [controls, setControls] = useState(() => readCinemaControls())

  useEffect(() => {
    fetch('/api/series')
      .then(r => r.json())
      .then(data => setSeries(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false))
  }, [])

  const genres = useMemo(() => {
    const set = new Set()
    for (const s of series) {
      for (const g of (s.genres || [])) set.add(String(g))
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [series])

  const filteredSeries = useMemo(() => {
    const q = search.trim().toLowerCase()
    const ranked = series
      .filter(s => ['S', 'A', 'B', 'C', 'D'].includes(s.tier))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    if (!q) return ranked
    return ranked.filter(s => (
      String(s.name || '').toLowerCase().includes(q) ||
      String(s.author_name || '').toLowerCase().includes(q)
    ))
  }, [search, series])

  const whitelistSeriesCount = Object.values(controls.seriesRules || {}).filter(v => v === 'whitelist').length
  const blacklistSeriesCount = Object.values(controls.seriesRules || {}).filter(v => v === 'blacklist').length
  const whitelistGenreCount = Object.values(controls.genreRules || {}).filter(v => v === 'whitelist').length
  const blacklistGenreCount = Object.values(controls.genreRules || {}).filter(v => v === 'blacklist').length

  const updateControls = (updater) => {
    setControls(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      return writeCinemaControls(next)
    })
  }

  const setSeriesRule = (seriesId, mode) => {
    updateControls(prev => {
      const nextSeriesRules = { ...(prev.seriesRules || {}) }
      if (mode === 'neutral') delete nextSeriesRules[String(seriesId)]
      else nextSeriesRules[String(seriesId)] = mode
      return { ...prev, seriesRules: nextSeriesRules }
    })
  }

  const setGenreRule = (genreName, mode) => {
    updateControls(prev => {
      const nextGenreRules = { ...(prev.genreRules || {}) }
      if (mode === 'neutral') delete nextGenreRules[String(genreName)]
      else nextGenreRules[String(genreName)] = mode
      return { ...prev, genreRules: nextGenreRules }
    })
  }

  const resetAll = () => {
    updateControls({ ...DEFAULT_CINEMA_CONTROLS })
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <h1 style={{ color: '#e8e4dc', fontSize: 24, margin: 0 }}>Shelf Cinema Control Panel</h1>
        <button onClick={resetAll} style={resetBtn}>Reset all</button>
      </div>

      <div style={sectionStyle}>
        <h2 style={sectionTitle}>Playback</h2>
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <div style={labelStyle}>Images per series: {controls.imageCount}</div>
            <input
              type="range"
              min="3"
              max="15"
              step="1"
              value={controls.imageCount}
              onChange={e => updateControls(prev => ({ ...prev, imageCount: Number(e.target.value) || 10 }))}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <div style={labelStyle}>Image duration: {controls.imageDurationSec}s</div>
            <input
              type="range"
              min="3"
              max="15"
              step="1"
              value={controls.imageDurationSec}
              onChange={e => updateControls(prev => ({ ...prev, imageDurationSec: Number(e.target.value) || 8 }))}
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </div>

      <div style={sectionStyle}>
        <h2 style={sectionTitle}>Genre Rules</h2>
        <div style={subtleText}>
          Whitelist genres force inclusion. If any genre is whitelisted, Shelf Cinema only rotates series matching at least one whitelisted genre.
        </div>
        <div style={{ ...subtleText, marginBottom: 10 }}>
          Whitelisted: {whitelistGenreCount} · Blacklisted: {blacklistGenreCount}
        </div>
        {genres.length === 0 && !loading && <div style={subtleText}>No genres available yet.</div>}
        <div style={gridStyle}>
          {genres.map(genre => {
            const mode = controls.genreRules?.[genre] || 'neutral'
            return (
              <RuleChip
                key={genre}
                label={genre}
                mode={mode}
                onToggle={() => setGenreRule(genre, cycleRuleMode(mode))}
              />
            )
          })}
        </div>
      </div>

      <div style={sectionStyle}>
        <h2 style={sectionTitle}>Series Rules</h2>
        <div style={subtleText}>
          Whitelist series pins them into rotation. Blacklist removes them.
        </div>
        <div style={{ ...subtleText, marginBottom: 10 }}>
          Whitelisted: {whitelistSeriesCount} · Blacklisted: {blacklistSeriesCount}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter series by name or author..."
          style={inputStyle}
        />
        {loading ? (
          <div style={{ ...subtleText, marginTop: 12 }}>Loading series...</div>
        ) : (
          <div style={{ ...gridStyle, marginTop: 12 }}>
            {filteredSeries.map(s => {
              const mode = controls.seriesRules?.[String(s.id)] || 'neutral'
              return (
                <RuleChip
                  key={s.id}
                  label={`${s.name}${s.author_name ? ` — ${s.author_name}` : ''}`}
                  mode={mode}
                  onToggle={() => setSeriesRule(s.id, cycleRuleMode(mode))}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function RuleChip({ label, mode, onToggle }) {
  const modeStyle = modeStyles[mode] || modeStyles.neutral
  return (
    <button onClick={onToggle} style={{ ...chipStyle, ...modeStyle }}>
      <span style={{ fontSize: 11, opacity: 0.9, marginRight: 8 }}>{mode.toUpperCase()}</span>
      <span style={{ textAlign: 'left' }}>{label}</span>
    </button>
  )
}

const sectionStyle = {
  background: '#1a1814',
  border: '1px solid #2a2822',
  borderRadius: 10,
  padding: 16,
  marginBottom: 16
}
const sectionTitle = { color: '#e8e4dc', fontSize: 17, margin: '0 0 8px 0' }
const subtleText = { color: '#9a9488', fontSize: 12, lineHeight: 1.5 }
const labelStyle = { color: '#c8c4bc', fontSize: 13, marginBottom: 4 }
const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }
const inputStyle = {
  width: '100%',
  background: '#0f0e0c',
  border: '1px solid #2a2822',
  borderRadius: 8,
  color: '#e8e4dc',
  padding: '8px 10px',
  fontSize: 13,
  outline: 'none'
}
const chipStyle = {
  borderRadius: 8,
  padding: '7px 10px',
  fontSize: 12,
  border: '1px solid #3a3830',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}
const modeStyles = {
  neutral: { background: '#2a2822', color: '#c8c4bc' },
  whitelist: { background: '#5cb85c22', color: '#5cb85c', border: '1px solid #5cb85c55' },
  blacklist: { background: '#e74c3c22', color: '#e74c3c', border: '1px solid #e74c3c55' }
}
const resetBtn = {
  background: '#2a2822',
  border: '1px solid #3a3830',
  borderRadius: 6,
  color: '#e8e4dc',
  fontSize: 12,
  padding: '6px 10px',
  cursor: 'pointer'
}
