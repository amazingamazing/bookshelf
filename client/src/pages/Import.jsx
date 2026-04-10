import React, { useState, useEffect } from 'react'

const FANART_PREFS_KEY = 'bookshelf:fanart-prefs:v1'

export default function Import() {
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(null)
  const [manualForm, setManualForm] = useState({ title: '', author: '', series: '', seriesOrder: '' })
  const [coverStats, setCoverStats] = useState({ total: 0, withCovers: 0, missing: 0 })
  const [coverStatus, setCoverStatus] = useState(null)
  const [resetStatus, setResetStatus] = useState(null)
  const [dupes, setDupes] = useState({ groups: [], totalGroups: 0 })
  const [dupeStatus, setDupeStatus] = useState(null)
  const [dupeChoiceByGroup, setDupeChoiceByGroup] = useState({})
  const [seriesRepairStatus, setSeriesRepairStatus] = useState(null)
  const [editionQuery, setEditionQuery] = useState({ bookId: '', title: '', author: '', isbn: '' })
  const [editionStatus, setEditionStatus] = useState(null)
  const [editionResults, setEditionResults] = useState(null)
  const [fanartPrefs, setFanartPrefs] = useState(() => {
    try {
      const raw = localStorage.getItem(FANART_PREFS_KEY)
      if (!raw) return { allowMature: false, minEdge: 700 }
      const parsed = JSON.parse(raw)
      return {
        allowMature: Boolean(parsed.allowMature),
        minEdge: Number(parsed.minEdge) || 700
      }
    } catch {
      return { allowMature: false, minEdge: 700 }
    }
  })

  useEffect(() => {
    loadCoverStats()
    loadDuplicates()
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(FANART_PREFS_KEY, JSON.stringify(fanartPrefs))
    } catch {
      // Ignore storage failures.
    }
  }, [fanartPrefs])

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

  const loadDuplicates = async () => {
    try {
      const res = await fetch('/api/import/duplicates')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load duplicates')
      setDupes(data)
      setDupeChoiceByGroup(prev => {
        const next = { ...prev }
        for (const g of data.groups || []) {
          if (!next[g.key]) {
            const withCover = g.books.find(b => b.cover_url)
            next[g.key] = withCover?.id || g.books[0]?.id || null
          }
        }
        return next
      })
    } catch (err) {
      setDupeStatus({ state: 'error', message: err.message })
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
    setCoverStatus({ state: 'loading' })
    try {
      const res = await fetch('/api/covers/fetch-missing', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch covers')
      setCoverStatus({ state: 'done', ...data })
      await loadCoverStats()
    } catch (err) {
      setCoverStatus({ state: 'error', message: err.message })
    } finally {
      setLoading(null)
    }
  }

  const handleFindEditions = async () => {
    const params = new URLSearchParams()
    if (editionQuery.bookId.trim()) params.set('book_id', editionQuery.bookId.trim())
    if (editionQuery.title.trim()) params.set('title', editionQuery.title.trim())
    if (editionQuery.author.trim()) params.set('author', editionQuery.author.trim())
    if (editionQuery.isbn.trim()) params.set('isbn', editionQuery.isbn.trim())

    if (![...params.keys()].length) {
      setEditionStatus({ state: 'error', message: 'Enter a book ID, title, or ISBN first.' })
      return
    }

    setLoading('editions')
    setEditionStatus({ state: 'loading' })
    setEditionResults(null)

    try {
      const res = await fetch(`/api/covers/editions?${params.toString()}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load editions')
      setEditionResults(data)
      setEditionStatus({ state: 'done' })
    } catch (err) {
      setEditionStatus({ state: 'error', message: err.message })
    } finally {
      setLoading(null)
    }
  }

  const handleSelectEditionCover = async (coverUrl, isbn) => {
    const bookId = editionQuery.bookId.trim()
    if (!bookId) {
      setEditionStatus({ state: 'error', message: 'Enter a Book ID to apply a selected cover.' })
      return
    }

    setLoading(`edition-select-${coverUrl}`)
    setEditionStatus({ state: 'loading' })
    try {
      const res = await fetch('/api/covers/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: Number(bookId),
          cover_url: coverUrl,
          isbn: isbn || null,
          source: 'open_library_edition_pick'
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to apply selected cover')
      setEditionStatus({ state: 'done', message: 'Selected cover applied to book.' })
      await loadCoverStats()
    } catch (err) {
      setEditionStatus({ state: 'error', message: err.message })
    } finally {
      setLoading(null)
    }
  }

  const handleResetAll = async () => {
    const ok = window.confirm('This will delete ALL authors, series, books, and queue data. Continue?')
    if (!ok) return
    setLoading('reset')
    setResetStatus({ state: 'loading' })
    try {
      const res = await fetch('/api/import/reset-all', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to clear data')
      setResetStatus({ state: 'done', deleted: data.deleted })
      setResults(null)
      setCoverStatus(null)
      await loadCoverStats()
      await loadDuplicates()
    } catch (err) {
      setResetStatus({ state: 'error', message: err.message })
    } finally {
      setLoading(null)
    }
  }

  const applyDuplicateChoice = async (group, merge) => {
    const keepBookId = dupeChoiceByGroup[group.key]
    if (!keepBookId) return
    setLoading(`dupe-${group.key}`)
    setDupeStatus({ state: 'loading', message: merge ? 'Merging duplicates...' : 'Applying cover choice...' })
    try {
      const res = await fetch('/api/import/duplicates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keepBookId,
          bookIds: group.books.map(b => b.id),
          merge
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to apply duplicate choice')
      setDupeStatus({
        state: 'done',
        message: merge
          ? `Merged group, removed ${data.deleted} duplicate book${data.deleted === 1 ? '' : 's'}.`
          : 'Applied selected cover to this duplicate group.'
      })
      await loadCoverStats()
      await loadDuplicates()
    } catch (err) {
      setDupeStatus({ state: 'error', message: err.message })
    } finally {
      setLoading(null)
    }
  }

  const handleRepairSeries = async () => {
    setLoading('series-repair')
    setSeriesRepairStatus({ state: 'loading' })
    try {
      const res = await fetch('/api/import/repair-series', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to repair series')
      setSeriesRepairStatus({ state: 'done', ...data })
      await loadDuplicates()
    } catch (err) {
      setSeriesRepairStatus({ state: 'error', message: err.message })
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
            {coverStatus && coverStatus.state === 'loading' && (
              <div style={{ fontSize: 13, color: '#9a9488', padding: '8px 0' }}>
                Running cover waterfall (Google Books -> Open Library -> LibraryThing -> Internet Archive)...
              </div>
            )}
            {coverStatus && coverStatus.state === 'error' && (
              <div style={{ fontSize: 13, color: '#e74c3c', background: '#e74c3c11', border: '1px solid #e74c3c33', borderRadius: 6, padding: '10px 12px' }}>
                ✗ Error: {coverStatus.message}
              </div>
            )}
            {coverStatus && coverStatus.state === 'done' && (
              <div style={{ fontSize: 13, borderRadius: 6, overflow: 'hidden', border: '1px solid #2a2822' }}>
                <div style={{ background: '#5cb85c11', borderBottom: coverStatus.notFound?.length || coverStatus.fetchErrors?.length ? '1px solid #2a2822' : 'none', padding: '10px 12px', color: '#5cb85c' }}>
                  ✓ Found {coverStatus.updated} cover{coverStatus.updated !== 1 ? 's' : ''} out of {coverStatus.tried} tried — {coverStatus.remaining} still missing in library
                </div>
                {coverStatus.notFound?.length > 0 && (
                  <details style={{ background: '#1a1814' }}>
                    <summary style={{ padding: '8px 12px', cursor: 'pointer', color: '#e67e22', userSelect: 'none' }}>
                      ⚠ {coverStatus.notFound.length} book{coverStatus.notFound.length !== 1 ? 's' : ''} not found in waterfall sources
                    </summary>
                    <div style={{ padding: '4px 12px 10px', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                      {coverStatus.notFound.map((b, i) => (
                        <div key={i} style={{ padding: '5px 8px', background: '#0f0e0c', borderRadius: 4 }}>
                          <span style={{ color: '#e8e4dc' }}>{b.title}</span>
                          {b.author && <span style={{ color: '#9a9488' }}> — {b.author}</span>}
                          <div style={{ color: '#6a6460', fontSize: 11, marginTop: 2 }}>{b.reason}</div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {coverStatus.fetchErrors?.length > 0 && (
                  <details style={{ background: '#1a1814', borderTop: '1px solid #2a2822' }}>
                    <summary style={{ padding: '8px 12px', cursor: 'pointer', color: '#e74c3c', userSelect: 'none' }}>
                      ✗ {coverStatus.fetchErrors.length} fetch error{coverStatus.fetchErrors.length !== 1 ? 's' : ''}
                    </summary>
                    <div style={{ padding: '4px 12px 10px', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
                      {coverStatus.fetchErrors.map((b, i) => (
                        <div key={i} style={{ padding: '5px 8px', background: '#0f0e0c', borderRadius: 4 }}>
                          <span style={{ color: '#e8e4dc' }}>{b.title}</span>
                          <div style={{ color: '#e74c3c', fontSize: 11, marginTop: 2 }}>{b.error}</div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        </Section>

        <Section
          title="Edition Browser"
          icon="🧭"
          description="Find edition variants via Open Library Works, browse available covers + ISBNs, and apply your preferred art to a book."
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Book ID (optional, required to apply)</label>
              <input
                value={editionQuery.bookId}
                onChange={e => setEditionQuery(prev => ({ ...prev, bookId: e.target.value }))}
                style={inputStyle}
                placeholder="e.g. 42"
              />
            </div>
            <div>
              <label style={labelStyle}>ISBN (optional)</label>
              <input
                value={editionQuery.isbn}
                onChange={e => setEditionQuery(prev => ({ ...prev, isbn: e.target.value }))}
                style={inputStyle}
                placeholder="9780316066525"
              />
            </div>
            <div>
              <label style={labelStyle}>Title</label>
              <input
                value={editionQuery.title}
                onChange={e => setEditionQuery(prev => ({ ...prev, title: e.target.value }))}
                style={inputStyle}
                placeholder="e.g. The Final Empire"
              />
            </div>
            <div>
              <label style={labelStyle}>Author (optional)</label>
              <input
                value={editionQuery.author}
                onChange={e => setEditionQuery(prev => ({ ...prev, author: e.target.value }))}
                style={inputStyle}
                placeholder="e.g. Brandon Sanderson"
              />
            </div>
          </div>

          <button
            onClick={handleFindEditions}
            disabled={loading === 'editions'}
            style={{ ...btnStyle, marginBottom: 12 }}
          >
            {loading === 'editions' ? 'Finding editions...' : 'Find Edition Covers'}
          </button>

          {editionStatus?.state === 'loading' && (
            <div style={{ fontSize: 13, color: '#9a9488', marginBottom: 8 }}>Querying Open Library works + editions...</div>
          )}
          {editionStatus?.state === 'error' && (
            <div style={{ fontSize: 13, color: '#e74c3c', marginBottom: 8 }}>✗ {editionStatus.message}</div>
          )}
          {editionStatus?.state === 'done' && editionStatus.message && (
            <div style={{ fontSize: 13, color: '#5cb85c', marginBottom: 8 }}>✓ {editionStatus.message}</div>
          )}

          {editionResults && (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: '#9a9488', fontSize: 12, marginBottom: 10 }}>
                Found {editionResults.editions?.length || 0} edition{editionResults.editions?.length === 1 ? '' : 's'}
                {editionResults.work_key ? ` for ${editionResults.work_key}` : ''}.
              </div>

              {(editionResults.editions || []).length === 0 ? (
                <div style={{ color: '#9a9488', fontSize: 13 }}>No cover-bearing editions found for that query.</div>
              ) : (
                <div style={{ display: 'grid', gap: 12, maxHeight: 520, overflowY: 'auto', paddingRight: 4 }}>
                  {editionResults.editions.map((edition, idx) => (
                    <div key={edition.edition_key || `${edition.title}-${idx}`} style={{ background: '#0f0e0c', border: '1px solid #2a2822', borderRadius: 8, padding: 10 }}>
                      <div style={{ color: '#e8e4dc', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                        {edition.title || 'Untitled edition'}
                      </div>
                      <div style={{ color: '#9a9488', fontSize: 11, marginBottom: 8 }}>
                        {edition.publish_date || 'Unknown date'} - ISBNs: {(edition.isbns || []).join(', ') || 'none listed'}
                      </div>

                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        {(edition.cover_urls || []).map(coverUrl => (
                          <div key={coverUrl} style={{ width: 96 }}>
                            <div style={{ width: 96, height: 144, borderRadius: 4, overflow: 'hidden', background: '#2a2822', marginBottom: 6 }}>
                              <img src={coverUrl} alt={edition.title || 'Edition cover'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            </div>
                            <button
                              onClick={() => handleSelectEditionCover(coverUrl, edition.isbns?.[0] || null)}
                              disabled={loading === `edition-select-${coverUrl}` || !editionQuery.bookId.trim()}
                              style={{
                                ...btnStyle,
                                width: '100%',
                                padding: '6px 8px',
                                fontSize: 11,
                                opacity: !editionQuery.bookId.trim() ? 0.5 : 1
                              }}
                            >
                              {loading === `edition-select-${coverUrl}` ? 'Applying...' : 'Use Cover'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Section>

        <Section
          title="Fan Art Preferences"
          icon="🎨"
          description="Controls for DeviantArt fan-art lookups used on series pages."
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#c8c4bc', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={fanartPrefs.allowMature}
                onChange={e => setFanartPrefs(prev => ({ ...prev, allowMature: e.target.checked }))}
              />
              Include mature / risque DeviantArt results
            </label>

            <div>
              <label style={labelStyle}>Quality floor (minimum long edge in pixels)</label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  type="range"
                  min="300"
                  max="1600"
                  step="50"
                  value={fanartPrefs.minEdge}
                  onChange={e => setFanartPrefs(prev => ({ ...prev, minEdge: Number(e.target.value) }))}
                  style={{ flex: 1 }}
                />
                <span style={{ color: '#9a9488', fontSize: 12, minWidth: 62, textAlign: 'right' }}>
                  {fanartPrefs.minEdge}px
                </span>
              </div>
              <div style={{ color: '#6a6460', fontSize: 11, marginTop: 6 }}>
                Higher values mean fewer but sharper images.
              </div>
            </div>
          </div>
        </Section>
      </SectionGroup>

      <SectionGroup title="🧩 Duplicate Review" description="Review likely duplicate books, choose a preferred cover, and optionally merge extras.">
        <Section
          title="Possible Duplicates"
          icon="🔎"
          description={dupes.totalGroups > 0
            ? `${dupes.totalGroups} duplicate group${dupes.totalGroups === 1 ? '' : 's'} found`
            : 'No likely duplicates found right now.'}
        >
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              onClick={loadDuplicates}
              disabled={loading === 'dupes-refresh'}
              style={btnStyle}
            >
              Refresh Duplicate Scan
            </button>
          </div>

          {dupeStatus?.state === 'loading' && (
            <div style={{ marginBottom: 10, fontSize: 13, color: '#9a9488' }}>{dupeStatus.message}</div>
          )}
          {dupeStatus?.state === 'error' && (
            <div style={{ marginBottom: 10, fontSize: 13, color: '#e74c3c' }}>✗ {dupeStatus.message}</div>
          )}
          {dupeStatus?.state === 'done' && (
            <div style={{ marginBottom: 10, fontSize: 13, color: '#5cb85c' }}>✓ {dupeStatus.message}</div>
          )}

          {dupes.totalGroups === 0 ? (
            <div style={{ color: '#9a9488', fontSize: 13 }}>Nothing to review here yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 700, overflowY: 'auto', paddingRight: 4 }}>
              {dupes.groups.map(group => (
                <div key={group.key} style={{ background: '#0f0e0c', border: '1px solid #2a2822', borderRadius: 8, padding: 12 }}>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ color: '#e8e4dc', fontSize: 14, fontWeight: 600 }}>{group.display_title}</div>
                    <div style={{ color: '#9a9488', fontSize: 12 }}>
                      {group.display_author} - {group.count} duplicates
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                    {group.books.map(book => {
                      const selected = dupeChoiceByGroup[group.key] === book.id
                      return (
                        <button
                          key={book.id}
                          type="button"
                          onClick={() => setDupeChoiceByGroup(prev => ({ ...prev, [group.key]: book.id }))}
                          style={{
                            textAlign: 'left',
                            background: selected ? '#6ea8fe12' : '#1a1814',
                            border: `1px solid ${selected ? '#6ea8fe55' : '#2a2822'}`,
                            borderRadius: 8,
                            padding: 8,
                            cursor: 'pointer',
                            color: '#e8e4dc'
                          }}
                        >
                          <div style={{ display: 'flex', gap: 8 }}>
                            <div style={{
                              width: 42,
                              height: 62,
                              background: '#2a2822',
                              borderRadius: 4,
                              overflow: 'hidden',
                              flexShrink: 0
                            }}>
                              {book.cover_url
                                ? <img src={book.cover_url} alt={book.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 11 }}>No cover</div>}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: selected ? '#6ea8fe' : '#e8e4dc' }}>
                                {selected ? '✓ Keep this cover' : 'Use this cover'}
                              </div>
                              <div style={{ fontSize: 11, color: '#9a9488', marginTop: 2 }}>id #{book.id} - {book.source}</div>
                              <div style={{ fontSize: 11, color: '#9a9488' }}>
                                {book.series_name ? `${book.series_name}${book.series_order ? ` #${book.series_order}` : ''}` : 'No series'}
                              </div>
                              <div style={{ fontSize: 11, color: '#9a9488' }}>
                                {book.goodreads_id ? 'GR' : '-'} / {book.audible_asin ? 'Audible' : '-'}
                              </div>
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      onClick={() => applyDuplicateChoice(group, false)}
                      disabled={loading === `dupe-${group.key}`}
                      style={btnStyle}
                    >
                      {loading === `dupe-${group.key}` ? 'Applying...' : 'Apply Cover Choice'}
                    </button>
                    <button
                      onClick={() => applyDuplicateChoice(group, true)}
                      disabled={loading === `dupe-${group.key}`}
                      style={{ ...btnStyle, background: '#e67e2218', border: '1px solid #e67e2244', color: '#e67e22' }}
                    >
                      {loading === `dupe-${group.key}` ? 'Merging...' : 'Apply + Merge Duplicates'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </SectionGroup>

      <SectionGroup title="🔧 Series Cleanup" description="Fix split series rows caused by author-variation imports (e.g. co-author credits).">
        <Section title="Repair Split Series" icon="🪄" description="Merges series rows with the same canonical name, moves books to the kept row, and preserves best tier/cover.">
          <button
            onClick={handleRepairSeries}
            disabled={loading === 'series-repair'}
            style={{ ...btnStyle, background: '#6ea8fe22', border: '1px solid #6ea8fe55', color: '#6ea8fe' }}
          >
            {loading === 'series-repair' ? 'Repairing...' : 'Repair Split Series'}
          </button>

          {seriesRepairStatus?.state === 'loading' && (
            <div style={{ marginTop: 10, fontSize: 13, color: '#9a9488' }}>Merging split series rows...</div>
          )}
          {seriesRepairStatus?.state === 'error' && (
            <div style={{ marginTop: 10, fontSize: 13, color: '#e74c3c' }}>✗ {seriesRepairStatus.message}</div>
          )}
          {seriesRepairStatus?.state === 'done' && (
            <div style={{ marginTop: 10, fontSize: 13, color: '#5cb85c' }}>
              ✓ Merged {seriesRepairStatus.groupsMerged || 0} series groups ({seriesRepairStatus.mergedSeriesRows || 0} rows removed, {seriesRepairStatus.movedBooks || 0} books reassigned)
            </div>
          )}
        </Section>
      </SectionGroup>

      <SectionGroup title="🧹 Reset Test Data" description="Clear all current library data so you can rerun imports with new normalization logic.">
        <Section title="Danger Zone" icon="⚠️" description="Deletes books, series, authors, and reading queue rows from the database. Use only for test resets.">
          <button
            onClick={handleResetAll}
            disabled={loading === 'reset'}
            style={{ ...btnStyle, background: '#e74c3c22', border: '1px solid #e74c3c44', color: '#e74c3c' }}
          >
            {loading === 'reset' ? 'Clearing...' : 'Clear All Library Data'}
          </button>
          {resetStatus?.state === 'loading' && (
            <div style={{ marginTop: 10, fontSize: 13, color: '#9a9488' }}>Deleting data...</div>
          )}
          {resetStatus?.state === 'error' && (
            <div style={{ marginTop: 10, fontSize: 13, color: '#e74c3c' }}>
              ✗ {resetStatus.message}
            </div>
          )}
          {resetStatus?.state === 'done' && (
            <div style={{ marginTop: 10, fontSize: 13, color: '#5cb85c' }}>
              ✓ Cleared {resetStatus.deleted?.books || 0} books, {resetStatus.deleted?.series || 0} series, {resetStatus.deleted?.authors || 0} authors
            </div>
          )}
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
