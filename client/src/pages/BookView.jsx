import React, { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

export default function BookView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [book, setBook] = useState(null)
  const [editionState, setEditionState] = useState({ loading: false, error: null, editions: [], workKey: null })
  const [selectingCover, setSelectingCover] = useState(null)

  const loadBook = async () => {
    const res = await fetch(`/api/books/${id}`)
    const data = await res.json()
    setBook(data)
  }

  useEffect(() => {
    loadBook()
  }, [id])

  if (!book) return <div style={{ padding: 48, color: '#9a9488', textAlign: 'center' }}>Loading...</div>

  const hasSeries = Boolean(book.series_id)
  const seriesPosition = formatSeriesOrder(book.series_order)
  const canLookupEditions = Boolean(book.title || book.isbn)

  const findEditionCovers = async () => {
    setEditionState({ loading: true, error: null, editions: [], workKey: null })
    try {
      const res = await fetch(`/api/covers/editions?book_id=${encodeURIComponent(id)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load edition covers')
      setEditionState({
        loading: false,
        error: null,
        editions: data.editions || [],
        workKey: data.work_key || null
      })
    } catch (err) {
      setEditionState({ loading: false, error: err.message, editions: [], workKey: null })
    }
  }

  const applyCover = async (coverUrl, isbn, edition) => {
    setSelectingCover(coverUrl)
    setEditionState(prev => ({ ...prev, error: null }))
    try {
      const res = await fetch('/api/covers/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: Number(id),
          cover_url: coverUrl,
          isbn: isbn || null,
          source: 'open_library_edition_pick',
          metadata: {
            edition_key: edition?.edition_key || null,
            edition_title: edition?.title || null,
            publish_date: edition?.publish_date || null
          }
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to apply cover')
      await loadBook()
    } catch (err) {
      setEditionState(prev => ({ ...prev, error: err.message }))
    } finally {
      setSelectingCover(null)
    }
  }


  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', gap: 16 }}>
        <button onClick={() => navigate(-1)} style={linkBtn}>← Back</button>
        {hasSeries && (
          <button onClick={() => navigate(`/series/${book.series_id}`)} style={linkBtn}>
            ← Back to {book.series_name || 'series'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 28, marginTop: 18 }}>
        <div style={coverWrap}>
          {book.cover_url
            ? <img src={book.cover_url} alt={book.title} style={coverImg} />
            : <span style={{ fontSize: 52 }}>📖</span>}
        </div>

        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 28, color: '#e8e4dc', marginBottom: 4 }}>{book.title}</h1>
          <div style={{ color: '#9a9488', fontSize: 15, marginBottom: 14 }}>
            by {book.author_name || 'Unknown Author'}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {book.status && <Chip label={book.status} color="#6ea8fe22" text="#6ea8fe" />}
            {book.rating && <Chip label={`${book.rating}★`} color="#f4c54222" text="#f4c542" />}
            {hasSeries && <Chip label={`${book.series_name || 'Series'} #${seriesPosition}`} />}
            {book.published_date && <Chip label={`Published: ${book.published_date}`} />}
            {book.page_count && <Chip label={`${book.page_count} pages`} />}
          </div>

          {book.tags?.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {book.tags.map(tag => (
                <Chip key={tag} label={tag} />
              ))}
            </div>
          )}

          <div style={{ display: 'grid', gap: 8, color: '#9a9488', fontSize: 14 }}>
            {book.isbn && <InfoRow label="ISBN" value={book.isbn} />}
            {book.goodreads_id && <InfoRow label="Goodreads ID" value={book.goodreads_id} />}
            {book.audible_asin && <InfoRow label="Audible ASIN" value={book.audible_asin} />}
            {book.date_read && <InfoRow label="Date read" value={book.date_read} />}
            {book.source && <InfoRow label="Source" value={book.source} />}
          </div>
        </div>
      </div>

      <div style={sectionWrap}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, color: '#e8e4dc', marginBottom: 4 }}>Cover Picker</h2>
            <div style={{ color: '#9a9488', fontSize: 13 }}>
              Browse edition variants for this book and choose your preferred cover art.
            </div>
          </div>
          <button
            onClick={findEditionCovers}
            disabled={!canLookupEditions || editionState.loading}
            style={{ ...actionBtn, opacity: !canLookupEditions || editionState.loading ? 0.6 : 1 }}
          >
            {editionState.loading ? 'Finding editions...' : 'Find Edition Covers'}
          </button>
        </div>

        {editionState.workKey && (
          <div style={{ marginTop: 10, color: '#6a6460', fontSize: 12 }}>
            Source work: {editionState.workKey}
          </div>
        )}

        {editionState.error && (
          <div style={{ marginTop: 12, color: '#e74c3c', fontSize: 13 }}>{editionState.error}</div>
        )}

        {!editionState.loading && !editionState.error && editionState.editions.length === 0 && (
          <div style={{ marginTop: 12, color: '#9a9488', fontSize: 13 }}>
            Click "Find Edition Covers" to load cover options.
          </div>
        )}

        {editionState.editions.length > 0 && (
          <div style={{ marginTop: 14, display: 'grid', gap: 12, maxHeight: 520, overflowY: 'auto', paddingRight: 4 }}>
            {editionState.editions.map((edition, idx) => (
              <div key={edition.edition_key || `${edition.title}-${idx}`} style={editionCard}>
                <div style={{ color: '#e8e4dc', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                  {edition.title || 'Untitled edition'}
                </div>
                <div style={{ color: '#9a9488', fontSize: 11, marginBottom: 10 }}>
                  {edition.publish_date || 'Unknown date'} | ISBNs: {(edition.isbns || []).join(', ') || 'none listed'}
                </div>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {(edition.cover_urls || []).map(coverUrl => (
                    <div key={coverUrl} style={{ width: 108 }}>
                      <div style={candidateCoverWrap}>
                        <img src={coverUrl} alt={edition.title || 'Edition cover'} style={candidateImg} />
                      </div>
                      <button
                        onClick={() => applyCover(coverUrl, edition.isbns?.[0] || null, edition)}
                        disabled={selectingCover === coverUrl}
                        style={{ ...actionBtn, width: '100%', marginTop: 6, padding: '6px 8px', fontSize: 11 }}
                      >
                        {selectingCover === coverUrl ? 'Applying...' : 'Use This Cover'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div>
      <span style={{ color: '#6a6460', marginRight: 8 }}>{label}:</span>
      <span style={{ color: '#c8c4bc' }}>{value}</span>
    </div>
  )
}

function Chip({ label, color = '#2a2822', text = '#9a9488' }) {
  return (
    <span style={{ background: color, color: text, padding: '4px 10px', borderRadius: 20, fontSize: 12 }}>
      {label}
    </span>
  )
}

function formatSeriesOrder(value) {
  if (value == null || value === '') return '?'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return Number.isInteger(n) ? String(n) : String(n)
}

const linkBtn = {
  background: 'none',
  border: 'none',
  color: '#9a9488',
  cursor: 'pointer',
  fontSize: 14,
  padding: 0
}

const coverWrap = {
  width: 200,
  height: 300,
  flexShrink: 0,
  borderRadius: 8,
  overflow: 'hidden',
  background: '#2a2822',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
}

const coverImg = { width: '100%', height: '100%', objectFit: 'contain' }
const candidateImg = { width: '100%', height: 'auto', objectFit: 'contain', display: 'block' }

const sectionWrap = {
  marginTop: 28,
  background: '#1a1814',
  border: '1px solid #2a2822',
  borderRadius: 12,
  padding: 16
}

const editionCard = {
  background: '#0f0e0c',
  border: '1px solid #2a2822',
  borderRadius: 8,
  padding: 10
}

const candidateCoverWrap = {
  width: 108,
  minHeight: 96,
  maxHeight: 180,
  borderRadius: 6,
  overflow: 'hidden',
  background: '#2a2822',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 4
}

const actionBtn = {
  background: '#6ea8fe22',
  border: '1px solid #6ea8fe44',
  borderRadius: 6,
  color: '#6ea8fe',
  padding: '8px 12px',
  fontSize: 12,
  cursor: 'pointer'
}
