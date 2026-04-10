import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const TIER_COLORS = { S: '#f4c542', A: '#6ea8fe', B: '#5cb85c', C: '#e67e22', D: '#e74c3c', Unranked: '#555' }
const STATUS_COLORS = { Read: '#5cb85c', 'Currently Reading': '#6ea8fe', 'Want to Read': '#888', Dropped: '#e74c3c' }
const BOOKSHELF_PREFS_KEY = 'bookshelf:view-prefs:v1'

export default function Bookshelf() {
  const [savedPrefs] = useState(() => {
    try {
      const raw = localStorage.getItem(BOOKSHELF_PREFS_KEY)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  })
  const [series, setSeries] = useState([])
  const [books, setBooks] = useState([])
  const [view, setView] = useState(savedPrefs.view || 'books') // 'series' | 'books'
  const [zoom, setZoom] = useState(typeof savedPrefs.zoom === 'number' ? savedPrefs.zoom : 1)
  const [filter, setFilter] = useState({
    tier: savedPrefs.filter?.tier || 'all',
    status: savedPrefs.filter?.status || 'all',
    search: savedPrefs.filter?.search || ''
  })
  const [sortBy, setSortBy] = useState(savedPrefs.sortBy || 'title')
  const [sortDir, setSortDir] = useState(savedPrefs.sortDir || 'asc')
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

  const inferSeriesFromTitle = (title) => {
    if (!title) return null
    const parenMatch = title.match(/\(([^,#]+),\s*#?([\d.]+)\)\s*$/)
    if (parenMatch) {
      return {
        name: parenMatch[1].trim(),
        order: parenMatch[2] ? parseFloat(parenMatch[2]) : null,
        source: 'paren'
      }
    }
    const colonMatch = title.match(/:\s*([^,]+),\s*Book\s+([\d.]+)\s*$/i)
    if (colonMatch) {
      return {
        name: colonMatch[1].trim(),
        order: colonMatch[2] ? parseFloat(colonMatch[2]) : null,
        source: 'colon'
      }
    }
    return null
  }

  const normalizeKeyPart = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const normalizeText = (value) => (value || '').toString().toLowerCase().trim()
  const compareText = (a, b) => normalizeText(a).localeCompare(normalizeText(b))
  const dateToTs = (raw) => {
    if (!raw) return null
    const normalized = String(raw).trim().replace(/\//g, '-')
    const ts = Date.parse(normalized)
    return Number.isNaN(ts) ? null : ts
  }

  const seriesById = series.reduce((acc, s) => {
    acc[s.id] = s
    return acc
  }, {})

  const groupedSeries = (() => {
    const groups = {}
    let inferredSeriesCount = 0
    for (const book of books) {
      const linkedSeries = book.series_id ? seriesById[book.series_id] : null
      const inferred = inferSeriesFromTitle(book.title)
      const seriesName = (book.series_name || linkedSeries?.name || inferred?.name || '').trim()
      const authorName = (book.author_name || linkedSeries?.author_name || '').trim()
      if (!book.series_name && !linkedSeries?.name && inferred?.name) inferredSeriesCount++
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

    const builtGroups = Object.values(groups).map((g, idx) => {
      const booksRead = g.books.filter(b => normalizeStatus(b.status) === 'Read').length
      return {
        id: g.openSeriesId || `group-${idx}-${g.key}`,
        title: g.name,
        name: g.name,
        author_name: g.author_name,
        tier: g.tier || 'Unranked',
        status: g.status || 'Want to Read',
        cover_url: g.cover_url,
        book_count: g.books.length,
        books_read: booksRead,
        series_title: g.name,
        series_length_read: booksRead,
        first_read_date: (() => {
          const readDates = g.books.map(b => dateToTs(b.date_read)).filter(Boolean)
          if (!readDates.length) return null
          return new Date(Math.min(...readDates)).toISOString()
        })(),
        last_read_date: (() => {
          const readDates = g.books.map(b => dateToTs(b.date_read)).filter(Boolean)
          if (!readDates.length) return null
          return new Date(Math.max(...readDates)).toISOString()
        })(),
        publication_date: (() => {
          const pubDates = g.books.map(b => dateToTs(b.published_date)).filter(Boolean)
          if (!pubDates.length) return null
          return new Date(Math.min(...pubDates)).toISOString()
        })(),
        openSeriesId: g.openSeriesId,
        books: g.books
      }
    }).sort((a, b) => {
      if (a.tier !== b.tier) return a.tier.localeCompare(b.tier)
      return a.name.localeCompare(b.name)
    })
    builtGroups._debugInferredSeriesCount = inferredSeriesCount
    return builtGroups
  })()

  const debugStats = {
    totalBooks: books.length,
    booksWithSeriesId: books.filter(b => !!b.series_id).length,
    booksWithSeriesNameFromApi: books.filter(b => !!(b.series_name || '').trim()).length,
    booksWithInferableSeriesInTitle: books.filter(b => !!inferSeriesFromTitle(b.title)?.name).length,
    inferredSeriesUsedForGrouping: groupedSeries._debugInferredSeriesCount || 0,
    groupedSeriesCount: groupedSeries.length,
    groupsWithMultipleBooks: groupedSeries.filter(g => (g.book_count || 0) > 1).length,
    groupsWithMultipleReadBooks: groupedSeries.filter(g => (g.books_read || 0) > 1).length,
    groupsThatCanOpenSeriesPage: groupedSeries.filter(g => !!g.openSeriesId).length
  }
  const debugTopGroups = [...groupedSeries]
    .filter(g => (g.book_count || 0) > 1)
    .sort((a, b) => (b.book_count || 0) - (a.book_count || 0))
    .slice(0, 12)

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

  const readCountBySeriesName = books.reduce((acc, b) => {
    const inferred = inferSeriesFromTitle(b.title)
    const name = (b.series_name || inferred?.name || '').trim()
    const key = `${normalizeKeyPart(b.author_name || '')}::${normalizeKeyPart(name)}`
    if (!name) return acc
    if (!acc[key]) acc[key] = 0
    if (normalizeStatus(b.status) === 'Read') acc[key] += 1
    return acc
  }, {})

  const booksWithSortFields = filteredBooks.map(b => {
    const inferred = inferSeriesFromTitle(b.title)
    const seriesTitle = (b.series_name || inferred?.name || '').trim()
    const seriesKey = `${normalizeKeyPart(b.author_name || '')}::${normalizeKeyPart(seriesTitle)}`
    return {
      ...b,
      series_title: seriesTitle,
      series_length_read: readCountBySeriesName[seriesKey] || (normalizeStatus(b.status) === 'Read' ? 1 : 0),
      publication_date: b.published_date || null,
      first_read_date: b.date_read || null,
      last_read_date: b.date_read || null
    }
  })

  const getSortValue = (item) => {
    switch (sortBy) {
      case 'author':
        return item.author_name || ''
      case 'series_title':
        return item.series_title || item.series_name || ''
      case 'series_length':
        return Number(item.series_length_read || item.books_read || 0)
      case 'publication_date':
        return dateToTs(item.publication_date || item.published_date)
      case 'last_read_date':
        return dateToTs(item.last_read_date || item.date_read)
      case 'first_read_date':
        return dateToTs(item.first_read_date || item.date_read)
      case 'title':
      default:
        return item.title || item.name || ''
    }
  }

  const sortItems = (items) => {
    return [...items].sort((a, b) => {
      const av = getSortValue(a)
      const bv = getSortValue(b)
      let cmp = 0

      const aMissing = av == null || av === ''
      const bMissing = bv == null || bv === ''
      if (aMissing && bMissing) cmp = 0
      else if (aMissing) cmp = 1
      else if (bMissing) cmp = -1

      else if (typeof av === 'number' || typeof bv === 'number' || sortBy.includes('date') || sortBy === 'series_length') {
        const an = av == null ? Number.NEGATIVE_INFINITY : Number(av)
        const bn = bv == null ? Number.NEGATIVE_INFINITY : Number(bv)
        cmp = an === bn ? 0 : an > bn ? 1 : -1
      } else {
        cmp = compareText(av, bv)
      }

      if (cmp === 0) cmp = compareText(a.title || a.name, b.title || b.name)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }

  const sortedBooks = sortItems(booksWithSortFields)
  const sortedSeries = sortItems(filteredSeries)

  const hasPublicationDateData = books.some(b => dateToTs(b.published_date) != null)
  const hasReadDateData = books.some(b => dateToTs(b.date_read) != null)
  const sortOptions = [
    { value: 'title', label: 'Sort: Title' },
    { value: 'author', label: 'Sort: Author' },
    { value: 'series_title', label: 'Sort: Series title' },
    { value: 'series_length', label: 'Sort: Series length (read)' },
    ...(hasPublicationDateData ? [{ value: 'publication_date', label: 'Sort: Publication/release date' }] : []),
    ...(hasReadDateData ? [
      { value: 'last_read_date', label: 'Sort: Last read date' },
      { value: 'first_read_date', label: 'Sort: First read date' }
    ] : [])
  ]

  useEffect(() => {
    const available = new Set(sortOptions.map(o => o.value))
    if (!available.has(sortBy)) setSortBy('title')
  }, [sortBy, hasPublicationDateData, hasReadDateData])

  useEffect(() => {
    try {
      localStorage.setItem(BOOKSHELF_PREFS_KEY, JSON.stringify({
        view,
        zoom,
        filter,
        sortBy,
        sortDir
      }))
    } catch {
      // Ignore storage errors (private mode, quota, etc.)
    }
  }, [view, zoom, filter, sortBy, sortDir])

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
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={selectStyle}>
          {sortOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select value={sortDir} onChange={e => setSortDir(e.target.value)} style={selectStyle}>
          <option value="asc">Asc</option>
          <option value="desc">Desc</option>
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
      {(view === 'series' ? sortedSeries.length : sortedBooks.length) === 0 ? (
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
          {view === 'books' ? sortedBooks.map(b => (
            <BookCard key={b.id} book={b} size={coverSize} onClick={() => b.series_id && navigate(`/series/${b.series_id}`)} />
          )) : sortedSeries.map(s => (
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

      <div style={{ marginTop: 28, borderTop: '1px solid #2a2822', paddingTop: 16 }}>
        <details open style={{ background: '#1a1814', border: '1px solid #2a2822', borderRadius: 8, padding: '10px 12px' }}>
          <summary style={{ cursor: 'pointer', color: '#e8e4dc', fontSize: 13, fontWeight: 600 }}>
            Debug: Series grouping diagnostics
          </summary>
          <div style={{ marginTop: 10, color: '#9a9488', fontSize: 12, lineHeight: 1.5 }}>
            <div>Total books: <span style={{ color: '#e8e4dc' }}>{debugStats.totalBooks}</span></div>
            <div>Books with `series_id`: <span style={{ color: '#e8e4dc' }}>{debugStats.booksWithSeriesId}</span></div>
            <div>Books with API `series_name`: <span style={{ color: '#e8e4dc' }}>{debugStats.booksWithSeriesNameFromApi}</span></div>
            <div>Books with inferable series in title: <span style={{ color: '#e8e4dc' }}>{debugStats.booksWithInferableSeriesInTitle}</span></div>
            <div>Inferred series used for grouping: <span style={{ color: '#e8e4dc' }}>{debugStats.inferredSeriesUsedForGrouping}</span></div>
            <div>Total grouped series: <span style={{ color: '#e8e4dc' }}>{debugStats.groupedSeriesCount}</span></div>
            <div>Groups with 2+ books: <span style={{ color: '#e8e4dc' }}>{debugStats.groupsWithMultipleBooks}</span></div>
            <div>Groups with 2+ read books (stackable): <span style={{ color: '#e8e4dc' }}>{debugStats.groupsWithMultipleReadBooks}</span></div>
            <div>Groups with linked series page: <span style={{ color: '#e8e4dc' }}>{debugStats.groupsThatCanOpenSeriesPage}</span></div>
          </div>

          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', color: '#c8c4bc', fontSize: 12 }}>
              Top multi-book groups
            </summary>
            <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
              {debugTopGroups.length === 0 && (
                <div style={{ fontSize: 12, color: '#6a6460' }}>No groups with more than one book yet.</div>
              )}
              {debugTopGroups.map(g => (
                <div key={g.id} style={{ background: '#0f0e0c', border: '1px solid #2a2822', borderRadius: 6, padding: '6px 8px' }}>
                  <div style={{ color: '#e8e4dc', fontSize: 12 }}>
                    {g.name} — {g.author_name}
                  </div>
                  <div style={{ color: '#9a9488', fontSize: 11 }}>
                    {g.book_count} books, {g.books_read} read, {g.openSeriesId ? `series page #${g.openSeriesId}` : 'no linked series page'}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </details>
      </div>
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
  const [hoveredBookId, setHoveredBookId] = useState(null)
  const tierColor = TIER_COLORS[series.tier] || '#555'
  const readCount = Number(series.books_read || 0)
  const totalCount = Number(series.book_count || books.length || 0)
  const stackable = readCount > 1
  const stackDepth = stackable ? Math.min(4, Math.max(2, Math.ceil(totalCount / 2))) : 1
  const sortedBooks = [...books].sort((a, b) => (a.series_order || 9999) - (b.series_order || 9999))
  const fanBooks = sortedBooks
  const primaryCover = series.cover_url || sortedBooks.find(b => b.cover_url)?.cover_url
  const seriesHeight = Math.round(size * 1.5)
  const fanCount = fanBooks.length
  const fanAreaWidth = Math.min(Math.max(size * 3, size + 140), 620)
  const slotSpacing = fanCount > 1 ? fanAreaWidth / (fanCount - 1) : fanAreaWidth
  const targetFanWidth = Math.round(size * 0.75) // around 3/4 of series card width
  const fanWidth = Math.max(16, Math.min(targetFanWidth, Math.round(slotSpacing * 0.9)))
  const fanHeight = Math.round(fanWidth * 1.5)
  const targetHoverHeight = Math.round(seriesHeight * 1.3)
  const hoverScale = fanHeight > 0 ? targetHoverHeight / fanHeight : 1
  const fanReserveSpace = expanded && stackable && fanCount > 0 ? Math.max(targetHoverHeight + 30, fanHeight + 30) : 0

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
        transition: 'transform 0.15s', borderRadius: 6, overflow: 'visible',
        marginBottom: fanReserveSpace
      }}
      onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'none'
        setHoveredBookId(null)
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
          position: 'absolute',
          top: seriesHeight + 10,
          left: Math.round((size - fanAreaWidth) / 2),
          width: fanAreaWidth,
          height: Math.max(targetHoverHeight + 10, fanHeight + 10),
          zIndex: 70
        }}>
          {fanBooks.map((book, idx) => {
            const spread = fanBooks.length === 1 ? 0 : idx / (fanBooks.length - 1)
            const left = Math.round(spread * Math.max(0, fanAreaWidth - fanWidth))
            const rotate = -12 + spread * 24
            const isHovered = hoveredBookId === book.id
            return (
              <div key={book.id} style={{
                position: 'absolute',
                left,
                top: Math.max(0, Math.round((Math.abs(rotate) / 14) * 10)),
                width: fanWidth,
                height: fanHeight,
                borderRadius: 4,
                overflow: 'hidden',
                border: '1px solid #3a3830',
                boxShadow: '0 5px 16px rgba(0,0,0,0.45)',
                transform: isHovered
                  ? `translateY(-${Math.round(seriesHeight * 0.18)}px) rotate(${rotate}deg) scale(${hoverScale})`
                  : `rotate(${rotate}deg)`,
                transformOrigin: 'bottom center',
                transition: 'transform 0.16s ease, box-shadow 0.16s ease',
                background: '#1a1814',
                zIndex: isHovered ? 200 : idx + 1
              }}
              onMouseEnter={() => setHoveredBookId(book.id)}
              onMouseLeave={() => setHoveredBookId(null)}
              title={book.title}
              >
                <div style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  zIndex: 2,
                  fontSize: 9,
                  color: '#e8e4dc',
                  background: 'rgba(0,0,0,0.55)',
                  borderRadius: 3,
                  padding: '1px 3px'
                }}>
                  {book.series_order || idx + 1}
                </div>
                <div style={{ width: '100%', height: '100%' }}>
                  {book.cover_url
                    ? <img src={book.cover_url} alt={book.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9a9488', fontSize: 10 }}>📖</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {expanded && stackable && fanBooks.length > 0 && (
        <div style={{
          position: 'absolute',
          top: seriesHeight + Math.max(targetHoverHeight, fanHeight) + 14,
          left: Math.round((size - fanAreaWidth) / 2),
          width: fanAreaWidth,
          fontSize: 11,
          color: '#9a9488',
          textAlign: 'center'
        }}>
          Hover a book to preview larger
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
