import React, { useState, useEffect, useRef } from 'react'

const TIERS = [
  { key: 'S', label: 'S', color: '#f4c542', bg: '#f4c54215' },
  { key: 'A', label: 'A', color: '#6ea8fe', bg: '#6ea8fe15' },
  { key: 'B', label: 'B', color: '#5cb85c', bg: '#5cb85c15' },
  { key: 'C', label: 'C', color: '#e67e22', bg: '#e67e2215' },
  { key: 'D', label: 'D', color: '#e74c3c', bg: '#e74c3c15' },
]
const TIER_COLORS = { S: '#f4c542', A: '#6ea8fe', B: '#5cb85c', C: '#e67e22', D: '#e74c3c', Unranked: '#555' }

export default function TierList() {
  const [series, setSeries] = useState([])
  const [dragging, setDragging] = useState(null)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const tierRef = useRef()

  useEffect(() => {
    fetch('/api/series').then(r => r.json()).then(setSeries)
  }, [])

  const moveTo = (seriesId, newTier) => {
    setSeries(prev => prev.map(s => s.id === seriesId ? { ...s, tier: newTier } : s))
  }

  const saveAll = async () => {
    setSaving(true)
    const tiers = {}
    series.forEach(s => { tiers[s.id] = s.tier || 'Unranked' })
    await fetch('/api/series/tiers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers })
    })
    setSaving(false)
  }

  const exportImage = async () => {
    setExporting(true)
    const html2canvas = (await import('html2canvas')).default
    const canvas = await html2canvas(tierRef.current, { backgroundColor: '#0f0e0c', scale: 2 })
    const link = document.createElement('a')
    link.download = 'series-tier-list.png'
    link.href = canvas.toDataURL()
    link.click()
    setExporting(false)
  }

  const onDragStart = (e, s) => { setDragging(s); e.dataTransfer.effectAllowed = 'move' }
  const onDrop = (e, tier) => { e.preventDefault(); if (dragging) moveTo(dragging.id, tier); setDragging(null) }

  const bySeries = (tier) => series.filter(s => s.tier === tier)
  const unranked = series.filter(s => !s.tier || s.tier === 'Unranked')

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, color: '#e8e4dc' }}>Series Tier List</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={saveAll} disabled={saving} style={btnStyle}>
            {saving ? 'Saving...' : 'Save Rankings'}
          </button>
          <button onClick={exportImage} disabled={exporting} style={{ ...btnStyle, background: '#6ea8fe22', color: '#6ea8fe' }}>
            {exporting ? 'Exporting...' : '↓ Export Image'}
          </button>
        </div>
      </div>

      <div ref={tierRef} style={{ background: '#0f0e0c', padding: 4, borderRadius: 8 }}>
        {TIERS.map(tier => (
          <div key={tier.key}
            onDragOver={e => e.preventDefault()}
            onDrop={e => onDrop(e, tier.key)}
            style={{ display: 'flex', alignItems: 'stretch', marginBottom: 4, minHeight: 90, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{
              width: 56, flexShrink: 0, background: tier.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 28, fontWeight: 700, color: '#000'
            }}>{tier.label}</div>
            <div style={{
              flex: 1, background: tier.bg, border: `1px solid ${tier.color}22`,
              padding: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignContent: 'flex-start', minHeight: 90
            }}>
              {bySeries(tier.key).map(s => (
                <SeriesChip key={s.id} series={s} onDragStart={onDragStart} moveTo={moveTo} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 24 }}>
        <h2 style={{ color: '#9a9488', fontSize: 15, marginBottom: 12 }}>
          Unranked — drag into tiers above, or click to assign
        </h2>
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => onDrop(e, 'Unranked')}
          style={{
            display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12,
            background: '#1a1814', borderRadius: 8, minHeight: 60, border: '1px dashed #2a2822'
          }}>
          {unranked.map(s => (
            <SeriesChip key={s.id} series={s} onDragStart={onDragStart} moveTo={moveTo} />
          ))}
          {unranked.length === 0 && <div style={{ color: '#555', fontSize: 13 }}>All series ranked!</div>}
        </div>
      </div>
    </div>
  )
}

function SeriesChip({ series, onDragStart, moveTo }) {
  const [showMenu, setShowMenu] = useState(false)
  const allTiers = ['S', 'A', 'B', 'C', 'D', 'Unranked']

  return (
    <div style={{ position: 'relative' }}>
      <div
        draggable
        onDragStart={e => onDragStart(e, series)}
        onClick={() => setShowMenu(m => !m)}
        style={{
          background: '#1a1814', border: '1px solid #2a2822', borderRadius: 6,
          padding: '5px 10px', cursor: 'grab', display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 13, color: '#e8e4dc', userSelect: 'none'
        }}>
        {series.cover_url && (
          <img src={series.cover_url} style={{ width: 24, height: 36, objectFit: 'cover', borderRadius: 2 }} />
        )}
        <span>{series.name}</span>
        {series.book_count > 0 && <span style={{ color: '#555', fontSize: 11 }}>({series.book_count})</span>}
      </div>
      {showMenu && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 50, marginTop: 4,
          background: '#1a1814', border: '1px solid #2a2822', borderRadius: 8,
          overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
        }}>
          {allTiers.map(t => (
            <div key={t}
              style={{ padding: '7px 16px', cursor: 'pointer', fontSize: 13,
                color: TIER_COLORS[t] || '#e8e4dc', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={e => e.currentTarget.style.background = '#2a2822'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => { moveTo(series.id, t); setShowMenu(false) }}>
              {t}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const btnStyle = {
  background: '#2a2822', border: '1px solid #3a3830', borderRadius: 6,
  color: '#e8e4dc', padding: '8px 16px', fontSize: 13, cursor: 'pointer'
}
