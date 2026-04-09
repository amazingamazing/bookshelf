import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const TIER_COLORS = { S: '#f4c542', A: '#6ea8fe', B: '#5cb85c', C: '#e67e22', D: '#e74c3c', Unranked: '#555' }
const STATUS_COLORS = { Read: '#5cb85c', 'Currently Reading': '#6ea8fe', 'Want to Read': '#888', Dropped: '#e74c3c' }

export default function Bookshelf() {
  const [series, setSeries] = useState([])
  const [books, setBooks] = useState([])
  const [view, setView] = useState('series') // 'series' | 'books'
  const [zoom, setZoom] = useState(1)
  const [filter, setFilter] = useState({ tier: 'all', status: 'all', search: '' })
  const [loading, setLoading] = useState(true)
  const [coverLoading, setCoverLoading] = useState(false)
  const [coverStatus, setCoverStatus] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    Promise.all([
      fetch('/api/series').then(r => r.json()),
      fetch('/api/books').then(r => r.json())
    ]).then(([s, b]) => {
      setSeries(s)
      setBooks(b)
      setLoading(false)
    })
  }, [])

  const filteredSeries = series.filter(s => {
    if (filter.tier !== 'all' && s.tier !== filter.tier) return false
    if (filter.status !== 'all' && s.status !== filter.status) return false
    if (filter.search && !s.name.toLowerCase().includes(filter.search.toLowerCase()) &&
        !s.author_name?.toLowerCase().includes(filter.search.toLowerCase())) return false
    return true
  })

  const coverSize = Math.round(120 * zoom)

  const handleFetchCovers = async () => {
    setCoverLoading(true)
    setCoverStatus('Fetching covers...')
    try {
      const res = await fetch('/api/covers/fetch-missing', { method: 'POST' })
      const data = await res.json()
      
      if (!res.ok) throw new Error(data.error || 'Failed to fetch covers')
      
      setCoverStatus(`✓ Found ${data.updated} covers (${data.remaining} remaining)`)
      
      // Refresh data
      const [s, b] = await Promise.all([
        fetch('/api/series').then(r => r.json()),
        fetch('/api/books').then(r => r.json())
      ])
      setSeries(s)
      setBooks(b)
      
      // Clear status message after 3 seconds
      setTimeout(() => setCoverStatus(''), 3000)
    } catch (err) {
      setCoverStatus(`✗ Error: ${err.message}`)
      setTimeout(() => setCoverStatus(''), 3000)
    } finally {
      setCoverLoading(false)
    }
  }

  if (loading) return <div style={{ padding: 48, color: '#9a9488', textAlign: 'center' }}>Loading your shelf...</div>

  return (
    <div style={{ padding: '24px' }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search series or author..."
          value={filter.search}
          onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
          style={inputStyle}
        />
        <select value={filter.tier} onChange={e => setFilter(f => ({ ...f, tier: e.target.value }))} style={selectStyle}>
          <option value="all">All tiers</option>
          {['S','A','B','C','D','Unranked'].map(t => <option key={t} value={t}>{t} Tier</option>)}
        </select>
        <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))} style={selectStyle}>
          <option value="all">All status</option>
          {['Completed','Reading','Want to Read','Dropped'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <span style={{ color: '#9a9488', fontSize: 13 }}>Zoom</span>
          <input type="range" min="0.5" max="2" step="0.1" value={zoom}
            onChange={e => setZoom(parseFloat(e.target.value))}
            style={{ width: 80 }} />
        </div>
        <button onClick={handleFetchCovers} disabled={coverLoading} 
          style={{...btnStyle, opacity: coverLoading ? 0.6 : 1, cursor: coverLoading ? 'not-allowed' : 'pointer'}}>
          {coverLoading ? 'Fetching...' : 'Fetch Missing Covers'}
        </button>
        {coverStatus && <span style={{ fontSize: 13, color: coverStatus.startsWith('✓') ? '#5cb85c' : '#e74c3c' }}>{coverStatus}</span>}
        <button onClick={() => navigate('/import')} style={{ ...btnStyle, background: '#5cb85c22', color: '#5cb85c' }}>
          + Import
        </button>
      </div>

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 24, fontSize: 13, color: '#9a9488' }}>
        <span>{series.length} series</span>
        <span>{books.length} books</span>
        <span>{books.filter(b => b.status === 'Read').length} read</span>
        <span>{series.filter(s => s.tier && s.tier !== 'Unranked').length} ranked</span>
      </div>

      {/* Cover grid */}
      {filteredSeries.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '80px 0', color: '#9a9488' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📚</div>
          <div style={{ fontSize: 18, marginBottom: 8 }}>Your shelf is empty</div>
          <div style={{ fontSize: 14 }}>Import your Goodreads or Audible library to get started</div>
          <button onClick={() => navigate('/import')} style={{ ...btnStyle, marginTop: 24, padding: '10px 24px' }}>
            Go to Import
          </button>
        </div>
      ) : (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: zoom < 0.75 ? 6 : 12
        }}>
          {filteredSeries.map(s => (
            <SeriesCard key={s.id} series={s} size={coverSize} onClick={() => navigate(`/series/${s.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

function SeriesCard({ series, size, onClick }) {
  const [imgErr, setImgErr] = useState(false)
  const tierColor = TIER_COLORS[series.tier] || '#555'

  return (
    <div onClick={onClick} title={`${series.name} by ${series.author_name || 'Unknown'}`}
      style={{
        width: size, cursor: 'pointer', position: 'relative',
        transition: 'transform 0.15s', borderRadius: 6, overflow: 'hidden'
      }}
      onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'}
      onMouseLeave={e => e.currentTarget.style.transform = 'none'}
    >
      {/* Cover */}
      <div style={{
        width: size, height: Math.round(size * 1.5),
        background: series.cover_url && !imgErr ? 'transparent' : '#2a2822',
        borderRadius: 6, overflow: 'hidden', position: 'relative'
      }}>
        {series.cover_url && !imgErr ? (
          <img src={series.cover_url} alt={series.name}
            onError={() => setImgErr(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{
            width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', padding: 8, textAlign: 'center'
          }}>
            <div style={{ fontSize: Math.max(10, size * 0.1), marginBottom: 4 }}>📖</div>
            <div style={{ fontSize: Math.max(9, size * 0.09), color: '#e8e4dc', lineHeight: 1.2, fontWeight: 500 }}>
              {series.name}
            </div>
            {size > 80 && (
              <div style={{ fontSize: Math.max(8, size * 0.075), color: '#9a9488', marginTop: 4 }}>
                {series.author_name}
              </div>
            )}
          </div>
        )}

        {/* Tier badge */}
        {series.tier && series.tier !== 'Unranked' && (
          <div style={{
            position: 'absolute', top: 4, right: 4,
            background: tierColor, color: '#000', fontWeight: 700,
            fontSize: Math.max(9, size * 0.1), width: Math.max(18, size * 0.18), height: Math.max(18, size * 0.18),
            borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            {series.tier}
          </div>
        )}

        {/* Book count */}
        {size > 70 && (
          <div style={{
            position: 'absolute', bottom: 4, left: 4,
            background: 'rgba(0,0,0,0.7)', color: '#e8e4dc',
            fontSize: 10, padding: '2px 5px', borderRadius: 3
          }}>
            {series.book_count} {series.book_count === 1 ? 'book' : 'books'}
          </div>
        )}
      </div>

      {/* Title below cover (only at larger zoom) */}
      {size > 100 && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#c8c4bc', lineHeight: 1.3,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {series.name}
        </div>
      )}
    </div>
  )
}

const inputStyle = {
  background: '#1a1814', border: '1px solid #2a2822', borderRadius: 6,
  color: '#e8e4dc', padding: '8px 12px', fontSize: 14, outline: 'none', flex: 1, minWidth: 200
}
const selectStyle = {
  background: '#1a1814', border: '1px solid #2a2822', borderRadius: 6,
  color: '#e8e4dc', padding: '8px 12px', fontSize: 14, outline: 'none'
}
const btnStyle = {
  background: '#2a2822', border: '1px solid #3a3830', borderRadius: 6,
  color: '#e8e4dc', padding: '8px 14px', fontSize: 13, cursor: 'pointer'
}
