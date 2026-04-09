import React, { useState, useEffect } from 'react'

export default function Import() {
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(null)
  const [manualForm, setManualForm] = useState({ title: '', author: '', series: '', seriesOrder: '' })
  const [coverStats, setCoverStats] = useState({ total: 0, withCovers: 0, missing: 0 })
  const [coverStatus, setCoverStatus] = useState('')

  useEffect(() => {
    loadCoverStats()
  }, [])

  const loadCoverStats = async () => {
    try {
      const booksRes = await fetch('/api/books')
      const books = await booksRes.json()
      const withCovers = books.filter(b => b.cover_url).length
      const missing = books.length - withCovers
      setCoverStats({ total: books.length, withCovers, missing })
    } catch (e) {
      console.error('Failed to load cover stats:', e)
    }
  }

  const uploadFile = async (type, file) => {
    if (!file) return
    setLoading(type)
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(`/api/import/${type}`, { method: 'POST', body: form })
      const data = await res.json()
      setResults({ type, ...data })
    } catch (e) {
      setResults({ type, error: e.message })
    }
    setLoading(null)
  }

  const submitManual = async (e) => {
    e.preventDefault()
    setLoading('manual')
    try {
      // Find or create author
      const authorRes = await fetch('/api/authors/find-or-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: manualForm.author })
      })
      const author = await authorRes.json()

      // Create series if provided
      let seriesId = null
      if (manualForm.series) {
        const seriesRes = await fetch('/api/series', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: manualForm.series, author_id: author.id })
        })
        const series = await seriesRes.json()
        seriesId = series.id
      }

      // Create book
      await fetch('/api/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: manualForm.title,
          author_id: author.id,
          series_id: seriesId,
          series_order: manualForm.seriesOrder || null,
          source: 'manual',
          status: 'Read'
        })
      })
      setResults({ type: 'manual', imported: 1 })
      setManualForm({ title: '', author: '', series: '', seriesOrder: '' })
    } catch (e) {
      setResults({ type: 'manual', error: e.message })
    }
    setLoading(null)
  }

  const handleFetchCovers = async () => {
    setLoading('covers')
    setCoverStatus('Fetching covers...')
    try {
      const res = await fetch('/api/covers/fetch-missing', { method: 'POST' })
      const data = await res.json()
      
      if (!res.ok) throw new Error(data.error || 'Failed to fetch covers')
      
      setCoverStatus(`✓ Found ${data.updated} covers (${data.remaining} remaining)`)
      await loadCoverStats()
      
      // Clear status after 4 seconds
      setTimeout(() => setCoverStatus(''), 4000)
    } catch (err) {
      setCoverStatus(`✗ Error: ${err.message}`)
      setTimeout(() => setCoverStatus(''), 4000)
    } finally {
      setLoading(null)
    }
  }

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: 32 }}>
      <h1 style={{ color: '#e8e4dc', fontSize: 24, marginBottom: 8 }}>Import & Manage</h1>
      <p style={{ color: '#9a9488', marginBottom: 32 }}>
        Import from Goodreads, Audible, add books manually, or manage your book covers.
      </p>

      {results && (
        <div style={{
          background: results.error ? '#e74c3c11' : '#5cb85c11',
          border: `1px solid ${results.error ? '#e74c3c33' : '#5cb85c33'}`,
          borderRadius: 8, padding: '12px 16px', marginBottom: 24
        }}>
          {results.error
            ? <span style={{ color: '#e74c3c' }}>Error: {results.error}</span>
            : <span style={{ color: '#5cb85c' }}>
                ✓ Imported {results.imported} books
                {results.skipped > 0 && `, skipped ${results.skipped} duplicates`}
              </span>
          }
          {results.errors?.length > 0 && (
            <details style={{ marginTop: 8, fontSize: 12, color: '#9a9488' }}>
              <summary>{results.errors.length} rows had errors</summary>
              <pre style={{ marginTop: 4 }}>{JSON.stringify(results.errors.slice(0,5), null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      <SectionGroup title="📥 Import Your Library" description="Add books to your shelf from external sources">
        {/* Goodreads */}
        <Section title="Goodreads" icon="📗" description="Export your library from Goodreads → My Books → Tools → Import and Export → Export Library">
          <FileUpload accept=".csv" label="Upload goodreads_library_export.csv"
            loading={loading === 'goodreads'}
            onChange={e => uploadFile('goodreads', e.target.files[0])} />
        </Section>

        {/* Audible */}
        <Section title="Audible" icon="🎧" description="Use the free 'Audible Library Extractor' Chrome extension to export your library as CSV, then upload here.">
          <a href="https://chrome.google.com/webstore/detail/audible-library-extractor" target="_blank"
            style={{ color: '#6ea8fe', fontSize: 13, display: 'block', marginBottom: 12 }}>
            Get Audible Library Extractor ↗
          </a>
          <FileUpload accept=".csv" label="Upload Audible library CSV"
            loading={loading === 'audible'}
            onChange={e => uploadFile('audible', e.target.files[0])} />
        </Section>

        {/* Manual */}
        <Section title="Manual Entry" icon="✍️" description="Add a single book manually.">
          <form onSubmit={submitManual} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Title *</label>
                <input required value={manualForm.title} onChange={e => setManualForm(f => ({ ...f, title: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Author *</label>
                <input required value={manualForm.author} onChange={e => setManualForm(f => ({ ...f, author: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Series name</label>
                <input value={manualForm.series} onChange={e => setManualForm(f => ({ ...f, series: e.target.value }))} style={inputStyle} placeholder="e.g. The Stormlight Archive" />
              </div>
              <div>
                <label style={labelStyle}>Book # in series</label>
                <input type="number" value={manualForm.seriesOrder} onChange={e => setManualForm(f => ({ ...f, seriesOrder: e.target.value }))} style={inputStyle} placeholder="e.g. 1" />
              </div>
            </div>
            <button type="submit" disabled={loading === 'manual'} style={btnStyle}>
              {loading === 'manual' ? 'Adding...' : 'Add Book'}
            </button>
          </form>
        </Section>
      </SectionGroup>

      <SectionGroup title="🎨 Manage Covers" description="Fetch and manage book cover images">
        <Section title="Cover Status" icon="📊" description={`You have covers for ${coverStats.withCovers} of ${coverStats.total} books${coverStats.missing > 0 ? ` (${coverStats.missing} missing)` : ' ✓'}`}>
          <div style={{ background: '#1a181411', borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#e8e4dc' }}>{coverStats.total}</div>
                <div style={{ fontSize: 12, color: '#9a9488', marginTop: 4 }}>Total Books</div>
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#5cb85c' }}>{coverStats.withCovers}</div>
                <div style={{ fontSize: 12, color: '#9a9488', marginTop: 4 }}>Have Covers</div>
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#e67e22' }}>{coverStats.missing}</div>
                <div style={{ fontSize: 12, color: '#9a9488', marginTop: 4 }}>Missing</div>
              </div>
            </div>
          </div>
          
          <div>
            <button 
              onClick={handleFetchCovers} 
              disabled={loading === 'covers'} 
              style={{...btnStyle, width: '100%', marginBottom: 12, opacity: loading === 'covers' ? 0.6 : 1, cursor: loading === 'covers' ? 'not-allowed' : 'pointer'}}
            >
              {loading === 'covers' ? 'Fetching...' : `Find Missing Covers (${coverStats.missing})`}
            </button>
            {coverStatus && (
              <div style={{ 
                fontSize: 13, 
                color: coverStatus.startsWith('✓') ? '#5cb85c' : '#e74c3c',
                background: coverStatus.startsWith('✓') ? '#5cb85c11' : '#e74c3c11',
                border: `1px solid ${coverStatus.startsWith('✓') ? '#5cb85c33' : '#e74c3c33'}`,
                borderRadius: 6,
                padding: '8px 12px'
              }}>
                {coverStatus}
              </div>
            )}
          </div>
        </Section>
      </SectionGroup>
    </div>
  )
}

function Section({ title, icon, description, children }) {
  return (
    <div style={{ background: '#1a1814', borderRadius: 12, padding: 24, marginBottom: 20, border: '1px solid #2a2822' }}>
      <h2 style={{ color: '#e8e4dc', fontSize: 17, marginBottom: 6 }}>{icon} {title}</h2>
      <p style={{ color: '#9a9488', fontSize: 13, marginBottom: 16 }}>{description}</p>
      {children}
    </div>
  )
}

function SectionGroup({ title, description, children }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ color: '#e8e4dc', fontSize: 18, fontWeight: 600, marginBottom: 8, paddingLeft: 4 }}>{title}</h2>
      <p style={{ color: '#9a9488', fontSize: 13, marginBottom: 16, paddingLeft: 4 }}>{description}</p>
      {children}
    </div>
  )
}

function FileUpload({ accept, label, loading, onChange }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: '#0f0e0c', border: '1px dashed #3a3830', borderRadius: 8,
      padding: '14px 18px', cursor: 'pointer', color: '#9a9488', fontSize: 13
    }}>
      {loading ? '⏳ Importing...' : `📂 ${label}`}
      <input type="file" accept={accept} onChange={onChange} style={{ display: 'none' }} disabled={loading} />
    </label>
  )
}

const inputStyle = { background: '#0f0e0c', border: '1px solid #2a2822', borderRadius: 6, color: '#e8e4dc', padding: '8px 12px', fontSize: 14, outline: 'none', width: '100%' }
const labelStyle = { display: 'block', fontSize: 12, color: '#9a9488', marginBottom: 4 }
const btnStyle = { background: '#5cb85c22', border: '1px solid #5cb85c44', borderRadius: 6, color: '#5cb85c', padding: '9px 20px', fontSize: 14, cursor: 'pointer', alignSelf: 'flex-start' }
