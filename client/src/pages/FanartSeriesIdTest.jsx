import React, { useEffect, useMemo, useState } from 'react'

const MAX_SERIES = 10

export default function FanartSeriesIdTest() {
  const [series, setSeries] = useState([])
  const [loadingSeries, setLoadingSeries] = useState(true)
  const [resultsById, setResultsById] = useState({})
  const [runState, setRunState] = useState({ running: false, currentId: null, completed: 0 })

  useEffect(() => {
    ;(async () => {
      try {
        const response = await fetch('/api/series')
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Failed to load series list')
        setSeries(Array.isArray(data) ? data : [])
      } finally {
        setLoadingSeries(false)
      }
    })()
  }, [])

  const topSeries = useMemo(() => {
    return [...series]
      .filter(item => Number(item.book_count) > 0)
      .sort((a, b) => {
        const byBookCount = Number(b.book_count || 0) - Number(a.book_count || 0)
        if (byBookCount !== 0) return byBookCount
        return String(a.name || '').localeCompare(String(b.name || ''))
      })
      .slice(0, MAX_SERIES)
  }, [series])

  const runSeriesIdChecks = async () => {
    if (runState.running || !topSeries.length) return
    setResultsById({})
    setRunState({ running: true, currentId: null, completed: 0 })

    for (const item of topSeries) {
      const seriesId = Number(item.id)
      setRunState(prev => ({ ...prev, currentId: seriesId }))
      try {
        const params = new URLSearchParams({
          series_id: String(seriesId),
          limit: '10',
          allow_mature: 'false',
          min_edge: '700',
          sort_mode: 'popular',
          time_window: 'all',
          exclude_ai: 'true',
          per_creator_cap: '2'
        })
        const response = await fetch(`/api/fanart/deviantart?${params.toString()}`)
        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || `HTTP ${response.status}`)
        }
        setResultsById(prev => ({
          ...prev,
          [seriesId]: {
            ok: true,
            count: Number(data.count || 0),
            queryCount: Array.isArray(data.queries) ? data.queries.length : 0,
            queries: Array.isArray(data.queries) ? data.queries : [],
            source: data.source || null
          }
        }))
      } catch (err) {
        setResultsById(prev => ({
          ...prev,
          [seriesId]: {
            ok: false,
            count: 0,
            queryCount: 0,
            queries: [],
            source: null,
            error: err?.message || 'Unknown error'
          }
        }))
      } finally {
        setRunState(prev => ({
          ...prev,
          completed: prev.completed + 1
        }))
      }
    }

    setRunState({ running: false, currentId: null, completed: topSeries.length })
  }

  const successCount = topSeries.reduce((total, item) => {
    const result = resultsById[Number(item.id)]
    return total + (result && result.ok && result.count > 0 ? 1 : 0)
  }, 0)

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <h1 style={{ color: '#e8e4dc', margin: 0, fontSize: 24 }}>Fan Art Series-ID Test</h1>
      <p style={{ color: '#9a9488', marginTop: 8, marginBottom: 16 }}>
        Runs separate fan-art searches by <code>series_id</code> only for your top 10 longest series (by book count).
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <button onClick={runSeriesIdChecks} disabled={loadingSeries || runState.running || !topSeries.length} style={buttonStyle}>
          {runState.running ? 'Running checks...' : 'Run all 10 checks'}
        </button>
        <span style={mutedStyle}>
          {runState.running
            ? `Progress: ${runState.completed}/${topSeries.length}${runState.currentId ? ` (currently ${runState.currentId})` : ''}`
            : resultsById && Object.keys(resultsById).length
              ? `Done. ${successCount}/${topSeries.length} returned at least one result.`
              : 'Not run yet.'}
        </span>
      </div>

      {loadingSeries ? (
        <div style={mutedStyle}>Loading series list...</div>
      ) : !topSeries.length ? (
        <div style={mutedStyle}>No eligible series found.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Series ID</th>
                <th style={thStyle}>Series</th>
                <th style={thStyle}>Author</th>
                <th style={thStyle}>Books</th>
                <th style={thStyle}>Results</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Queries</th>
              </tr>
            </thead>
            <tbody>
              {topSeries.map(item => {
                const id = Number(item.id)
                const result = resultsById[id]
                return (
                  <tr key={id}>
                    <td style={tdStyle}>{id}</td>
                    <td style={tdStyle}>{item.name || 'Untitled'}</td>
                    <td style={tdStyle}>{item.author_name || 'Unknown'}</td>
                    <td style={tdStyle}>{Number(item.book_count || 0)}</td>
                    <td style={tdStyle}>
                      {result ? result.count : '—'}
                    </td>
                    <td style={tdStyle}>
                      {!result
                        ? 'Pending'
                        : result.ok
                          ? (result.count > 0 ? 'Found' : 'No matches')
                          : `Error: ${result.error}`}
                    </td>
                    <td style={{ ...tdStyle, maxWidth: 520 }}>
                      {result?.queries?.length ? result.queries.join(' | ') : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const buttonStyle = {
  background: '#2a2822',
  border: '1px solid #3a3830',
  borderRadius: 6,
  color: '#e8e4dc',
  padding: '7px 12px',
  fontSize: 13,
  cursor: 'pointer'
}

const mutedStyle = {
  color: '#9a9488',
  fontSize: 13
}

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  background: '#161411',
  border: '1px solid #2a2822',
  borderRadius: 8
}

const thStyle = {
  textAlign: 'left',
  color: '#c8c4bc',
  fontSize: 12,
  padding: '10px 8px',
  borderBottom: '1px solid #2a2822',
  background: '#1d1a16',
  whiteSpace: 'nowrap'
}

const tdStyle = {
  color: '#e8e4dc',
  fontSize: 12,
  padding: '8px',
  borderBottom: '1px solid #24211d',
  verticalAlign: 'top'
}
