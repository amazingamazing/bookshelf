import React, { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

export default function BookView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [book, setBook] = useState(null)

  useEffect(() => {
    fetch(`/api/books/${id}`).then(r => r.json()).then(setBook)
  }, [id])

  if (!book) return <div style={{ padding: 48, color: '#9a9488', textAlign: 'center' }}>Loading...</div>

  const hasSeries = Boolean(book.series_id)
  const seriesPosition = formatSeriesOrder(book.series_order)

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

const coverImg = { width: '100%', height: '100%', objectFit: 'cover' }
