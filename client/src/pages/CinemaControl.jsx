import React, { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_CINEMA_CONTROLS,
  cycleRuleMode,
  readCinemaControls,
  writeCinemaControls
} from '../lib/cinemaControls'

const TIER_ORDER = ['S', 'A', 'B', 'C', 'D']

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

  const eligibleSeries = useMemo(() => {
    return series
      .filter(s => TIER_ORDER.includes(String(s.tier || '').toUpperCase()) && Number(s.book_count) > 0)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
  }, [series])

  const filteredSeries = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return eligibleSeries
    return eligibleSeries.filter(s => (
      String(s.name || '').toLowerCase().includes(q) ||
      String(s.author_name || '').toLowerCase().includes(q)
    ))
  }, [eligibleSeries, search])

  const whitelistSeriesCount = Object.values(controls.seriesRules || {}).filter(v => v === 'whitelist').length
  const blacklistSeriesCount = Object.values(controls.seriesRules || {}).filter(v => v === 'blacklist').length

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

  const handleDebugModeToggle = () => {
    updateControls(prev => {
      if (!prev.debugMode) {
        return {
          ...prev,
          debugMode: true,
          lastNonDebug: {
            holdMinSec: prev.holdMinSec,
            holdMaxSec: prev.holdMaxSec,
            crossfadeSec: prev.crossfadeSec,
            kenBurnsScale: prev.kenBurnsScale
          },
          holdMinSec: 3,
          holdMaxSec: 3,
          crossfadeSec: 0.5,
          kenBurnsScale: 1
        }
      }
      return {
        ...prev,
        debugMode: false,
        holdMinSec: prev.lastNonDebug?.holdMinSec ?? DEFAULT_CINEMA_CONTROLS.holdMinSec,
        holdMaxSec: prev.lastNonDebug?.holdMaxSec ?? DEFAULT_CINEMA_CONTROLS.holdMaxSec,
        crossfadeSec: prev.lastNonDebug?.crossfadeSec ?? DEFAULT_CINEMA_CONTROLS.crossfadeSec,
        kenBurnsScale: prev.lastNonDebug?.kenBurnsScale ?? DEFAULT_CINEMA_CONTROLS.kenBurnsScale
      }
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
        <div style={controlRow}>
          <div style={labelStyle}>Hold duration range</div>
          <div style={subtleText}>{controls.holdMinSec.toFixed(1)}s - {controls.holdMaxSec.toFixed(1)}s</div>
          <input
            type="range"
            min="3"
            max="90"
            step="0.5"
            value={controls.holdMinSec}
            onChange={e => updateControls(prev => ({ ...prev, holdMinSec: Number(e.target.value) || 3 }))}
            style={{ width: '100%' }}
          />
          <input
            type="range"
            min="3"
            max="90"
            step="0.5"
            value={controls.holdMaxSec}
            onChange={e => updateControls(prev => ({ ...prev, holdMaxSec: Number(e.target.value) || 3 }))}
            style={{ width: '100%' }}
          />
        </div>

        <div style={controlRow}>
          <div style={labelStyle}>Crossfade duration: {controls.crossfadeSec.toFixed(1)}s</div>
          <input
            type="range"
            min="0.5"
            max="5"
            step="0.1"
            value={controls.crossfadeSec}
            onChange={e => updateControls(prev => ({ ...prev, crossfadeSec: Number(e.target.value) || 0.5 }))}
            style={{ width: '100%' }}
          />
        </div>

        <div style={controlRow}>
          <div style={labelStyle}>Ken Burns max scale: {controls.kenBurnsScale.toFixed(2)}</div>
          <input
            type="range"
            min="1"
            max="1.08"
            step="0.01"
            value={controls.kenBurnsScale}
            onChange={e => updateControls(prev => ({ ...prev, kenBurnsScale: Number(e.target.value) || 1 }))}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <div style={sectionStyle}>
        <h2 style={sectionTitle}>Fan Art</h2>
        <label style={toggleRow}>
          <input
            type="checkbox"
            checked={controls.fanartEnabled}
            onChange={e => updateControls(prev => ({ ...prev, fanartEnabled: e.target.checked }))}
          />
          <span>Enable fan art between covers</span>
        </label>
        <div style={controlRow}>
          <div style={labelStyle}>Fan art per cover</div>
          <select
            value={controls.fanartPerCover}
            onChange={e => updateControls(prev => ({ ...prev, fanartPerCover: e.target.value }))}
            style={selectStyle}
          >
            <option value="random">Random (1-3)</option>
            <option value="0">0 (off)</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </div>
      </div>

      <div style={sectionStyle}>
        <h2 style={sectionTitle}>Debug Mode</h2>
        <div style={{ ...subtleText, marginBottom: 10 }}>
          Applies fast cycling preset: hold 3s, crossfade 0.5s, Ken Burns off.
        </div>
        <label style={toggleRow}>
          <input type="checkbox" checked={controls.debugMode} onChange={handleDebugModeToggle} />
          <span>Debug mode</span>
        </label>
      </div>

      <div style={sectionStyle}>
        <h2 style={sectionTitle}>Series Whitelist / Blacklist</h2>
        <div style={subtleText}>Whitelist limits playback to those series only. Blacklist always excludes.</div>
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
                  label={`${s.name}${s.author_name ? ` - ${s.author_name}` : ''}`}
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
const controlRow = { display: 'grid', gap: 8, marginBottom: 12 }
const toggleRow = { display: 'flex', gap: 8, alignItems: 'center', color: '#e8e4dc', fontSize: 13 }
const selectStyle = {
  width: '100%',
  background: '#0a0806',
  border: '1px solid #2a2822',
  borderRadius: 8,
  color: '#e8e4dc',
  padding: '8px 10px',
  fontSize: 13,
  outline: 'none'
}
const inputStyle = {
  width: '100%',
  background: '#0a0806',
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
