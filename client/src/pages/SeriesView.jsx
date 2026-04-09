import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

const TIERS = ['S','A','B','C','D','Unranked']
const TIER_COLORS = { S: '#f4c542', A: '#6ea8fe', B: '#5cb85c', C: '#e67e22', D: '#e74c3c', Unranked: '#555' }

export default function SeriesView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [series, setSeries] = useState(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({})
  const [aiLoading, setAiLoading] = useState(false)
  const [related, setRelated] = useState(null)

  useEffect(() => {
    fetch(`/api/series/${id}`).then(r => r.json()).then(data => {
      setSeries(data)
      setForm({ tier: data.tier, rating: data.rating, notes: data.notes, status: data.status })
    })
  }, [id])

  const save = async () => {
    await fetch(`/api/series/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...series, ...form })
    })
    setSeries(s => ({ ...s, ...form }))
    setEditing(false)
  }

  const findSimilar = async () => {
    setAiLoading(true)
    const res = await fetch('/api/ai/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seriesIds: [id],
        prompt: `Find series similar to "${series.name}" by ${series.author_name}`
      })
    })
    setRelated(await res.json())
    setAiLoading(false)
  }

  if (!series) return <div style={{ padding: 48, color: '#9a9488', textAlign: 'center' }}>Loading...</div>

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <button onClick={() => navigate(-1)} style={backBtn}>← Back to shelf</button>

      <div style={{ display: 'flex', gap: 32, marginTop: 16 }}>
        {/* Cover */}
        <div style={{
          width: 180, height: 270, flexShrink: 0, borderRadius: 8, overflow: 'hidden',
          background: '#2a2822', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          {series.cover_url
            ? <img src={series.cover_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 48 }}>📚</span>}
        </div>

        {/* Info */}
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: '#e8e4dc', marginBottom: 4 }}>{series.name}</h1>
          <div style={{ color: '#9a9488', fontSize: 15, marginBottom: 16 }}>by {series.author_name || 'Unknown Author'}</div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
            <Chip label={`${series.book_count} books`} />
            <Chip label={`${series.books_read} read`} color="#5cb85c22" text="#5cb85c" />
            <Chip label={series.status} />
          </div>

          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <div>
                  <label style={labelStyle}>Tier</label>
                  <select value={form.tier || 'Unranked'} onChange={e => setForm(f => ({ ...f, tier: e.target.value }))} style={selectStyle}>
                    {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Rating</label>
                  <select value={form.rating || ''} onChange={e => setForm(f => ({ ...f, rating: e.target.value }))} style={selectStyle}>
                    <option value="">—</option>
                    {[1,1.5,2,2.5,3,3.5,4,4.5,5].map(r => <option key={r} value={r}>{r}★</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Status</label>
                  <select value={form.status || ''} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={selectStyle}>
                    {['Reading','Completed','Dropped','Want to Read'].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Notes</label>
                <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={3} style={{ ...selectStyle, width: '100%', resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={save} style={{ ...actionBtn, background: '#5cb85c22', color: '#5cb85c' }}>Save</button>
                <button onClick={() => setEditing(false)} style={actionBtn}>Cancel</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                <div style={{
                  background: TIER_COLORS[series.tier] || '#555', color: '#000',
                  fontWeight: 700, fontSize: 20, width: 40, height: 40, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>{series.tier}</div>
                {series.rating && <span style={{ fontSize: 18, color: '#f4c542' }}>{'★'.repeat(Math.floor(series.rating))}</span>}
                <span style={{ color: '#9a9488', fontSize: 13 }}>{series.rating ? `${series.rating}/5` : 'Not rated'}</span>
                <button onClick={() => setEditing(true)} style={actionBtn}>Edit</button>
              </div>
              {series.notes && <p style={{ color: '#9a9488', fontSize: 14, lineHeight: 1.6 }}>{series.notes}</p>}
            </div>
          )}
        </div>
      </div>

      {/* Books list */}
      <div style={{ marginTop: 32 }}>
        <h2 style={{ color: '#e8e4dc', fontSize: 18, marginBottom: 16 }}>Books in series</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {series.books?.map(book => (
            <div key={book.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: '#1a1814', borderRadius: 8, padding: '10px 14px'
            }}>
              <span style={{ color: '#555', fontSize: 13, minWidth: 24 }}>#{book.series_order || '?'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ color: '#e8e4dc', fontSize: 14 }}>{book.title}</div>
              </div>
              <StatusBadge status={book.status} />
              {book.rating && <span style={{ color: '#f4c542', fontSize: 13 }}>{book.rating}★</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Similar series */}
      <div style={{ marginTop: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h2 style={{ color: '#e8e4dc', fontSize: 18 }}>Similar series</h2>
          <button onClick={findSimilar} disabled={aiLoading} style={actionBtn}>
            {aiLoading ? 'Searching...' : '✨ Find similar'}
          </button>
        </div>
        {related && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {related.map((r, i) => (
              <div key={i} style={{ background: '#1a1814', borderRadius: 8, padding: '12px 16px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                  <span style={{ color: '#e8e4dc', fontWeight: 500 }}>{r.name}</span>
                  <span style={{ color: '#9a9488', fontSize: 13 }}>by {r.author}</span>
                  <span style={{ color: '#555', fontSize: 12 }}>{r.books_count} books</span>
                </div>
                <div style={{ color: '#9a9488', fontSize: 13 }}>{r.reason}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  {r.genres?.map(g => <Chip key={g} label={g} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Chip({ label, color = '#2a2822', text = '#9a9488' }) {
  return <span style={{ background: color, color: text, padding: '3px 10px', borderRadius: 20, fontSize: 12 }}>{label}</span>
}

function StatusBadge({ status }) {
  const colors = { Read: '#5cb85c', 'Currently Reading': '#6ea8fe', 'Want to Read': '#555', Dropped: '#e74c3c' }
  return <span style={{ color: colors[status] || '#555', fontSize: 12 }}>{status}</span>
}

const backBtn = { background: 'none', border: 'none', color: '#9a9488', cursor: 'pointer', fontSize: 14, padding: 0 }
const labelStyle = { display: 'block', fontSize: 12, color: '#9a9488', marginBottom: 4 }
const selectStyle = { background: '#1a1814', border: '1px solid #2a2822', borderRadius: 6, color: '#e8e4dc', padding: '7px 10px', fontSize: 14, outline: 'none' }
const actionBtn = { background: '#2a2822', border: '1px solid #3a3830', borderRadius: 6, color: '#e8e4dc', padding: '6px 14px', fontSize: 13, cursor: 'pointer' }
