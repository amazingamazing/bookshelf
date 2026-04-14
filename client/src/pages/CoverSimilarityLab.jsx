import React, { useEffect, useMemo, useState } from 'react'

const DEFAULT_DISTANCE = 8

export default function CoverSimilarityLab() {
  const [distance, setDistance] = useState(DEFAULT_DISTANCE)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const loadAnalysis = async (distanceValue = distance) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ distance: String(distanceValue) })
      const response = await fetch(`/api/covers/similarity-lab?${params.toString()}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Failed to analyze covers')
      setData(payload)
    } catch (err) {
      setError(err.message || 'Failed to analyze covers')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAnalysis(distance)
    // Run once on page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clusterStats = useMemo(() => {
    if (!data?.clusters?.length) return { duplicates: 0, singles: 0 }
    const duplicates = data.clusters.filter(cluster => cluster.size > 1).length
    const singles = data.clusters.filter(cluster => cluster.size === 1).length
    return { duplicates, singles }
  }, [data])

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Cover Similarity Lab</h1>
      <p style={styles.subtitle}>
        Perceptual hash clustering across A Song of Ice and Fire, Wheel of Time, and Harry Potter.
      </p>

      <div style={styles.controlsCard}>
        <div style={styles.sliderRow}>
          <label style={styles.label}>
            Hamming distance threshold: <strong>{distance}</strong>
          </label>
          <input
            type="range"
            min="0"
            max="24"
            step="1"
            value={distance}
            onChange={event => setDistance(Number(event.target.value) || 0)}
            style={{ width: '100%' }}
          />
        </div>
        <button onClick={() => loadAnalysis(distance)} disabled={loading} style={styles.reloadBtn}>
          {loading ? 'Running analysis...' : 'Reload analysis'}
        </button>
      </div>

      {error && <div style={styles.error}>Error: {error}</div>}

      {data && (
        <div style={styles.summaryCard}>
          <div style={styles.summaryLine}>Covers considered: {data.totals?.covers_considered ?? 0}</div>
          <div style={styles.summaryLine}>Covers hashed: {data.totals?.covers_hashed ?? 0}</div>
          <div style={styles.summaryLine}>Hash failures: {data.totals?.covers_failed ?? 0}</div>
          <div style={styles.summaryLine}>Clusters: {data.totals?.clusters ?? 0}</div>
          <div style={styles.summaryLine}>Duplicate clusters: {clusterStats.duplicates}</div>
          <div style={styles.summaryLine}>Singletons: {clusterStats.singles}</div>
        </div>
      )}

      {data?.clusters?.map((cluster, index) => (
        <section key={cluster.id || index} style={styles.clusterSection}>
          <div style={styles.clusterHeader}>
            <div style={styles.clusterTitle}>
              Cluster {index + 1} · {cluster.size} cover{cluster.size === 1 ? '' : 's'}
            </div>
            <div style={styles.clusterMeta}>Max internal distance: {cluster.max_internal_distance}</div>
          </div>
          <div style={styles.coverGrid}>
            {(cluster.items || []).map((item, itemIndex) => (
              <article key={`${item.cover_url}-${itemIndex}`} style={styles.coverCard}>
                <img src={item.cover_url} alt={item.book_title || 'Cover'} style={styles.coverImage} />
                <div style={styles.coverBook}>{item.book_title || 'Unknown title'}</div>
                <div style={styles.coverSeries}>{item.series_name || 'Unknown series'}</div>
                <div style={styles.badgeRow}>
                  <span style={styles.badge}>d={item.distance_to_anchor}</span>
                  <span style={styles.badge}>{item.source || 'unknown'}</span>
                  {item.is_primary && <span style={styles.primaryBadge}>Primary</span>}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      {Boolean(data?.failures?.length) && (
        <section style={styles.clusterSection}>
          <div style={styles.clusterHeader}>
            <div style={styles.clusterTitle}>Hash Failures</div>
            <div style={styles.clusterMeta}>{data.failures.length} failed cover{data.failures.length === 1 ? '' : 's'}</div>
          </div>
          <div style={{ ...styles.coverGrid, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {data.failures.slice(0, 30).map((failure, index) => (
              <article key={`${failure.cover_url}-${index}`} style={styles.coverCard}>
                <div style={styles.coverBook}>{failure.book_title || 'Unknown title'}</div>
                <div style={styles.coverSeries}>{failure.series_name || 'Unknown series'}</div>
                <div style={{ ...styles.coverSeries, marginTop: 6, color: '#d98b8b' }}>
                  {failure.hash_error || 'unknown'}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

const styles = {
  page: {
    maxWidth: 1240,
    margin: '0 auto',
    padding: 24
  },
  title: {
    margin: 0,
    color: '#e8e4dc',
    fontSize: 28
  },
  subtitle: {
    color: '#9a9488',
    marginTop: 8,
    marginBottom: 16
  },
  controlsCard: {
    background: '#1a1814',
    border: '1px solid #2a2822',
    borderRadius: 10,
    padding: 14,
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 12,
    alignItems: 'end',
    marginBottom: 12
  },
  sliderRow: {
    display: 'grid',
    gap: 8
  },
  label: {
    color: '#c8c4bc',
    fontSize: 13
  },
  reloadBtn: {
    border: '1px solid #3a3830',
    background: '#2a2822',
    color: '#e8e4dc',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 12,
    cursor: 'pointer'
  },
  summaryCard: {
    background: '#1a1814',
    border: '1px solid #2a2822',
    borderRadius: 10,
    padding: 14,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 8,
    marginBottom: 14
  },
  summaryLine: {
    color: '#c8c4bc',
    fontSize: 12
  },
  error: {
    background: '#3a1414',
    color: '#ffd0d0',
    border: '1px solid #6a3030',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
    fontSize: 12
  },
  clusterSection: {
    background: '#1a1814',
    border: '1px solid #2a2822',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12
  },
  clusterHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10
  },
  clusterTitle: {
    color: '#e8e4dc',
    fontSize: 14,
    fontWeight: 600
  },
  clusterMeta: {
    color: '#9a9488',
    fontSize: 12
  },
  coverGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 10
  },
  coverCard: {
    background: '#0a0806',
    border: '1px solid #2a2822',
    borderRadius: 8,
    padding: 8
  },
  coverImage: {
    width: '100%',
    aspectRatio: '2 / 3',
    objectFit: 'cover',
    borderRadius: 6,
    marginBottom: 8,
    background: '#15120f'
  },
  coverBook: {
    color: '#e8e4dc',
    fontSize: 12,
    lineHeight: 1.35,
    minHeight: 32
  },
  coverSeries: {
    color: '#9a9488',
    fontSize: 11,
    marginTop: 3,
    minHeight: 16
  },
  badgeRow: {
    display: 'flex',
    gap: 6,
    marginTop: 7,
    flexWrap: 'wrap'
  },
  badge: {
    border: '1px solid #3a3830',
    color: '#c8c4bc',
    fontSize: 10,
    borderRadius: 999,
    padding: '2px 7px'
  },
  primaryBadge: {
    border: '1px solid #5cb85c55',
    color: '#73cf73',
    fontSize: 10,
    borderRadius: 999,
    padding: '2px 7px'
  }
}
