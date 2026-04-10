import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const TIER_COLORS = { S: '#f4c542', A: '#6ea8fe', B: '#5cb85c', C: '#e67e22', D: '#e74c3c', Unranked: '#555' }
const STATUS_COLORS = { Read: '#5cb85c', 'Currently Reading': '#6ea8fe', 'Want to Read': '#888', Dropped: '#e74c3c' }

export default function Bookshelf() {
  const [series, setSeries] = useState([])
  const [books, setBooks] = useState([])
  const [view, setView] = useState('books') // 'series' | 'books'
  const [zoom, setZoom] = useState(1)
  const [filter, setFilter] = useState({ tier: 'all', status: 'all', search: '' })
  const [expandedSeriesId, setExpandedSeriesId] = useState(null)
  const [loading, setLoading] = useState(true)
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

  const normalizeStatus = (status) => {
    const map = { Completed: 'Read', Reading: 'Currently Reading' }
    return map[status] || status
  }

  const normalizeKeyPart = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  const seriesById = series.reduce((acc, s) => {
    acc[s.id] = s
    return acc
  }, {})

  const groupedSeries = (() => {
    const groups = {}
    for (const book of books) {
      const linkedSeries = book.series_id ? seriesById[book.series_id] : null
      const seriesName = (book.series_name || linkedSeries?.name || '').trim()
      const authorName = (book.author_name || linkedSeries?.author_name || '').trim()
      const key = seriesName
        ? `${normalizeKeyPart(authorName)}::${normalizeKeyPart(seriesName)}`
        : `book-${book.id}`

      if (!groups[key]) {
        groups[key] = {
          key,
          books: [],
          name: seriesName || book.title,
          author_name: authorName || 'Unknown',
          tier: linkedSeries?.tier || 'Unranked',
          status: linkedSeries?.status || normalizeStatus(book.status) || 'Want to Read',
          cover_url: linkedSeries?.cover_url || book.cover_url || null,
          openSeriesId: linkedSeries?.id || null,
          sourceSeriesIds: linkedSeries?.id ? [linkedSeries.id] : []
        }
      } else if (linkedSeries?.id && !groups[key].sourceSeriesIds.includes(linkedSeries.id)) {
        groups[key].sourceSeriesIds.push(linkedSeries.id)
      }

      groups[key].books.push(book)
      if (!groups[key].cover_url && book.cover_url) groups[key].cover_url = book.cover_url
      if (!groups[key].openSeriesId && linkedSeries?.id) groups[key].openSeriesId = linkedSeries.id
      if (linkedSeries?.tier && linkedSeries.tier !== 'Unranked') groups[key].tier = linkedSeries.tier
    }

    return Object.values(groups).map((g, idx) => {
      const booksRead = g.books.filter(b => normalizeStatus(b.status) === 'Read').length
      return {
        id: g.openSeriesId || `group-${idx}-${g.key}`,
        name: g.name,
        author_name: g.author_name,
        tier: g.tier || 'Unranked',
        status: g.status || 'Want to Read',
        cover_url: g.cover_url,
        book_count: g.books.length,
        books_read: booksRead,
        openSeriesId: g.openSeriesId,
        books: g.books
      }
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier.localeCompare(b.tier)
      return a.name.localeCompare(b.name)
    })
  })()

  const filteredSeries = groupedSeries.filter(s => {
    if (filter.tier !== 'all' && s.tier !== filter.tier) return false
    if (filter.status !== 'all' && normalizeStatus(s.status) !== normalizeStatus(filter.status)) return false
    if (filter.search && !s.name.toLowerCase().includes(filter.search.toLowerCase()) &&
        !s.author_name?.toLowerCase().includes(filter.search.toLowerCase())) return false
    return true
  })

  const filteredBooks = books.filter(b => {
    if (filter.status !== 'all' && normalizeStatus(b.status) !== normalizeStatus(filter.status)) return false
    if (
      filter.search &&
      !b.title.toLowerCase().includes(filter.search.toLowerCase()) &&
      !b.author_name?.toLowerCase().includes(filter.search.toLowerCase()) &&
      !b.series_name?.toLowerCase().includes(filter.search.toLowerCase())
    ) return false
    if (filter.tier !== 'all') {
      const parentSeries = series.find(s => s.id === b.series_id)
      if (!parentSeries || parentSeries.tier !== filter.tier) return false
    }
    return true
  })

  const coverSize = Math.round(120 * zoom)

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
          {['Read','Currently Reading','Want to Read','Dropped'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 6, background: '#1a1814', border: '1px solid #2a2822', borderRadius: 8, padding: 4 }}>
          <button onClick={() => setView('books')} style={view === 'books' ? activeToggle : inactiveToggle}>Books</button>
          <button onClick={() => setView('series')} style={view === 'series' ? activeToggle : inactiveToggle}>Series</button>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <span style={{ color: '#9a9488', fontSize: 13 }}>Zoom</span>
          <input type="range" min="0.5" max="2" step="0.1" value={zoom}
            onChange={e => setZoom(parseFloat(e.target.value))}
            style={{ width: 80 }} />
        </div>
        <button onClick={() => navigate('/import')} style={{ ...btnStyle, background: '#5cb85c22', color: '#5cb85c' }}>
          + Import
        </button>
      </div>

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 24, fontSize: 13, color: '#9a9488' }}>
        <span>{groupedSeries.length} series</span>
        <span>{books.length} books</span>
        <span>{books.filter(b => b.status === 'Read').length} read</span>
        <span>{groupedSeries.filter(s => s.tier && s.tier !== 'Unranked').length} ranked</span>
      </div>

      {/* Cover grid */}
      {(view === 'series' ? filteredSeries.length : filteredBooks.length) === 0 ? (
        <div style={{ textAlign: 'center', padding: '80px 0', color: '#9a9488' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📚</div>
          <div style={{ fontSize: 18, marginBottom: 8 }}>No books match this filter</div>
          <div style={{ fontSize: 14 }}>Try clearing search or switching views</div>
          <button onClick={() => navigate('/import')} style={{ ...btnStyle, marginTop: 24, padding: '10px 24px' }}>
            Go to Import
          </button>
        </div>
      ) : (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: zoom < 0.75 ? 6 : 12
        }}>
          {view === 'books' ? filteredBooks.map(b => (
            <BookCard key={b.id} book={b} size={coverSize} onClick={() => b.series_id && navigate(`/series/${b.series_id}`)} />
          )) : filteredSeries.map(s => (
            <SeriesStackCard
              key={s.id}
              series={s}
              books={s.books || []}
              size={coverSize}
              expanded={expandedSeriesId === s.id}
              onExpand={() => setExpandedSeriesId(s.id)}
              onCollapse={() => setExpandedSeriesId(null)}
              onOpen={() => s.openSeriesId && navigate(`/series/${s.openSeriesId}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BookCard({ book, size, onClick }) {
  const [imgErr, setImgErr] = useState(false)

  return (
    <div onClick={onClick} title={`${book.title} by ${book.author_name || 'Unknown'}`}
      style={{
        width: size, cursor: book.series_id ? 'pointer' : 'default', position: 'relative',
        transition: 'transform 0.15s', borderRadius: 6, overflow: 'hidden'
      }}
      onMouseEnter={e => e.currentTarget.style.transform = book.series_id ? 'translateY(-4px) scale(1.02)' : 'none'}
      onMouseLeave={e => e.currentTarget.style.transform = 'none'}
    >
      <div style={{
        width: size, height: Math.round(size * 1.5),
        background: book.cover_url && !imgErr ? 'transparent' : '#2a2822',
        borderRadius: 6, overflow: 'hidden', position: 'relative'
      }}>
        {book.cover_url && !imgErr ? (
          <img src={book.cover_url} alt={book.title}
            onError={() => setImgErr(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{
            width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', padding: 8, textAlign: 'center'
          }}>
            <div style={{ fontSize: Math.max(10, size * 0.1), marginBottom: 4 }}>📖</div>
            <div style={{ fontSize: Math.max(9, size * 0.09), color: '#e8e4dc', lineHeight: 1.2, fontWeight: 500 }}>
              {book.title}
            </div>
          </div>
        )}
      </div>
      {size > 100 && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#c8c4bc', lineHeight: 1.3,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {book.title}
        </div>
      )}
    </div>
  )
}

function SeriesStackCard({ series, books, size, expanded, onExpand, onCollapse, onOpen }) {
  const [imgErr, setImgErr] = useState(false)
  const tierColor = TIER_COLORS[series.tier] || '#555'
  const readCount = Number(series.books_read || 0)
  const totalCount = Number(series.book_count || books.length || 0)
  const stackable = readCount > 1
  const stackDepth = stackable ? Math.min(4, Math.max(2, Math.ceil(totalCount / 2))) : 1
  const sortedBooks = [...books].sort((a, b) => (a.series_order || 9999) - (b.series_order || 9999))
  const fanBooks = sortedBooks.slice(0, 5)
  const primaryCover = series.cover_url || sortedBooks.find(b => b.cover_url)?.cover_url

  const handleCardClick = () => {
    if (!stackable) {
      onOpen()
      return
    }
    if (!expanded) {
      onExpand()
      return
    }
    onOpen()
  }

  return (
    <div title={`${series.name} by ${series.author_name || 'Unknown'}`}
      style={{
        width: size, cursor: 'pointer', position: 'relative',
        transition: 'transform 0.15s', borderRadius: 6, overflow: 'visible'
      }}
      onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none'
        if (expanded) onCollapse()
      }}
    >
      {/* Stack shadow layers */}
      {stackable && !expanded && (
        <>
          {Array.from({ length: stackDepth - 1 }).map((_, idx) => (
            <div key={idx} style={{
              position: 'absolute',
              top: idx * 3 + 2,
              left: idx * 3 + 2,
              width: size,
              height: Math.round(size * 1.5),
              borderRadius: 6,
              background: '#1a1814',
              border: '1px solid #3a3830',
              zIndex: idx
            }} />
          ))}
        </>
      )}

      {/* Main cover */}
      <div onClick={handleCardClick} style={{
        width: size, height: Math.round(size * 1.5),
        background: primaryCover && !imgErr ? 'transparent' : '#2a2822',
        borderRadius: 6, overflow: 'hidden', position: 'relative',
        zIndex: stackDepth + 1
      }}>
        {primaryCover && !imgErr ? (
          <img src={primaryCover} alt={series.name}
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

        {size > 70 && (
          <div style={{
            position: 'absolute', bottom: 4, left: 4,
            background: 'rgba(0,0,0,0.7)', color: '#e8e4dc',
            fontSize: 10, padding: '2px 5px', borderRadius: 3
          }}>
            {totalCount} {totalCount === 1 ? 'book' : 'books'}
          </div>
        )}
        {stackable && (
          <div style={{
            position: 'absolute', bottom: 4, right: 4,
            background: '#6ea8fe22', border: '1px solid #6ea8fe55',
            color: '#6ea8fe', fontSize: 10, padding: '2px 5px', borderRadius: 3
          }}>
            stack
          </div>
        )}
      </div>

      {/* Fan out preview */}
      {expanded && stackable && fanBooks.length > 0 && (
        <div style={{
          position: 'absolute', top: Math.round(size * 1.5) + 8, left: -4,
          width: size + 64, height: 88, zIndex: 60
        }}>
          {fanBooks.map((book, idx) => {
            const spread = fanBooks.length === 1 ? 0 : idx / (fanBooks.length - 1)
            const left = Math.round(spread * Math.min(size - 24, 96))
            const rotate = -12 + spread * 24
            return (
              <div key={book.id} style={{
                position: 'absolute',
                left,
                top: Math.abs(rotate) * 0.4,
                width: 42,
                height: 64,
                borderRadius: 4,
                overflow: 'hidden',
                border: '1px solid #3a3830',
                boxShadow: '0 5px 16px rgba(0,0,0,0.45)',
                transform: `rotate(${rotate}deg)`,
                background: '#1a1814'
              }}>
                {book.cover_url
                  ? <img src={book.cover_url} alt={book.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9a9488', fontSize: 10 }}>📖</div>}
              </div>
            )
          })}
        </div>
      )}

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
const activeToggle = {
  background: '#6ea8fe22', border: '1px solid #6ea8fe55', borderRadius: 6,
  color: '#6ea8fe', padding: '6px 12px', fontSize: 12, cursor: 'pointer'
}
const inactiveToggle = {
  background: 'transparent', border: '1px solid transparent', borderRadius: 6,
  color: '#9a9488', padding: '6px 12px', fontSize: 12, cursor: 'pointer'
}
