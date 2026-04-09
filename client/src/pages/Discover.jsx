import React, { useState, useEffect } from 'react'

export default function Discover() {
  const [tab, setTab] = useState('recommend')
  const [authors, setAuthors] = useState([])
  const [recommendations, setRecommendations] = useState(null)
  const [newReleases, setNewReleases] = useState(null)
  const [research, setResearch] = useState(null)
  const [researchQuery, setResearchQuery] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/authors').then(r => r.json()).then(setAuthors)
  }, [])

  const getRecommendations = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/ai/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: customPrompt || 'Recommend series similar to what I enjoy most' })
      })
      setRecommendations(await res.json())
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  const checkNewReleases = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/ai/new-releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      const data = await res.json()
      setNewReleases(data)
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  const doResearch = async () => {
    if (!researchQuery.trim()) return
    setLoading(true)
    try {
      const res = await fetch('/api/ai/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: researchQuery })
      })
      setResearch(await res.json())
    } catch (e) { console.error(e) }
    setLoading(false)
  }

  const toggleFollow = async (author) => {
    await fetch(`/api/authors/${author.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ following: !author.following })
    })
    setAuthors(prev => prev.map(a => a.id === author.id ? { ...a, following: !a.following } : a))
  }

  const followedAuthors = authors.filter(a => a.following)

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: 24 }}>
      <h1 style={{ color: '#e8e4dc', fontSize: 24, marginBottom: 24 }}>Discover</h1>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 28, borderBottom: '1px solid #2a2822', paddingBottom: 0 }}>
        {[
          { key: 'recommend', label: '✨ Recommendations' },
          { key: 'releases', label: '🔔 New Releases' },
          { key: 'research', label: '🔍 Research' },
          { key: 'authors', label: '👤 Authors' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '10px 16px', fontSize: 14, borderBottom: tab === t.key ? '2px solid #6ea8fe' : '2px solid transparent',
            color: tab === t.key ? '#e8e4dc' : '#9a9488', marginBottom: -1
          }}>{t.label}</button>
        ))}
      </div>

      {/* Recommendations */}
      {tab === 'recommend' && (
        <div>
          <p style={{ color: '#9a9488', fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
            Claude analyzes your highest-rated series and finds similar ones you might enjoy.
          </p>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            <input
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              placeholder="Optional: refine the request (e.g. 'something shorter' or 'more sci-fi')"
              style={inputStyle}
            />
            <button onClick={getRecommendations} disabled={loading} style={primaryBtn}>
              {loading ? 'Thinking...' : 'Get Recommendations'}
            </button>
          </div>

          {recommendations && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {recommendations.map((r, i) => (
                <RecommendCard key={i} rec={r} />
              ))}
            </div>
          )}

          {!recommendations && !loading && (
            <EmptyState icon="✨" text="Click 'Get Recommendations' to find your next great series" />
          )}
        </div>
      )}

      {/* New Releases */}
      {tab === 'releases' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <p style={{ color: '#9a9488', fontSize: 14, flex: 1 }}>
              Searches for upcoming and recent releases from authors you follow.
              {followedAuthors.length === 0 && ' Follow some authors in the Authors tab first.'}
            </p>
            <button onClick={checkNewReleases} disabled={loading || followedAuthors.length === 0} style={primaryBtn}>
              {loading ? 'Searching...' : 'Check New Releases'}
            </button>
          </div>

          {followedAuthors.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
              <span style={{ color: '#9a9488', fontSize: 12, alignSelf: 'center' }}>Following:</span>
              {followedAuthors.map(a => (
                <span key={a.id} style={tagStyle}>{a.name}</span>
              ))}
            </div>
          )}

          {newReleases && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {newReleases.message && (
                <div style={{ color: '#9a9488', fontSize: 14 }}>{newReleases.message}</div>
              )}
              {newReleases.results?.map((r, i) => (
                <div key={i} style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                        <span style={{ color: '#e8e4dc', fontWeight: 500, fontSize: 15 }}>{r.title}</span>
                        {r.series && <span style={{ color: '#9a9488', fontSize: 13 }}>{r.series}</span>}
                      </div>
                      <div style={{ color: '#6ea8fe', fontSize: 13, marginBottom: 6 }}>by {r.author}</div>
                      <div style={{ color: '#9a9488', fontSize: 13, lineHeight: 1.5 }}>{r.description}</div>
                    </div>
                    <div style={{ flexShrink: 0 }}>
                      <span style={{
                        padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 500,
                        background: r.is_upcoming ? '#6ea8fe22' : '#5cb85c22',
                        color: r.is_upcoming ? '#6ea8fe' : '#5cb85c'
                      }}>
                        {r.is_upcoming ? '📅 Upcoming' : '✓ Out now'}
                      </span>
                      {r.release_date && <div style={{ color: '#555', fontSize: 12, marginTop: 4, textAlign: 'center' }}>{r.release_date}</div>}
                    </div>
                  </div>
                </div>
              ))}
              {newReleases.results?.length === 0 && (
                <EmptyState icon="📚" text="No recent releases found for your followed authors" />
              )}
            </div>
          )}

          {!newReleases && !loading && followedAuthors.length > 0 && (
            <EmptyState icon="🔔" text="Click 'Check New Releases' to search for upcoming books" />
          )}
        </div>
      )}

      {/* Research */}
      {tab === 'research' && (
        <div>
          <p style={{ color: '#9a9488', fontSize: 14, marginBottom: 16 }}>
            Look up any book series to get details, similar recommendations, and publication status.
          </p>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            <input
              value={researchQuery}
              onChange={e => setResearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doResearch()}
              placeholder="e.g. 'Wheel of Time' or 'Brandon Sanderson Mistborn'"
              style={inputStyle}
            />
            <button onClick={doResearch} disabled={loading || !researchQuery.trim()} style={primaryBtn}>
              {loading ? 'Searching...' : 'Research'}
            </button>
          </div>

          {research && (
            <div style={cardStyle}>
              <h2 style={{ color: '#e8e4dc', fontSize: 20, marginBottom: 4 }}>{research.name}</h2>
              <div style={{ color: '#9a9488', fontSize: 14, marginBottom: 16 }}>by {research.author}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                <InfoChip label={`${research.book_count} books`} />
                <InfoChip label={research.status} color={research.status === 'complete' ? '#5cb85c' : '#6ea8fe'} />
                <InfoChip label={research.genre} />
                {research.goodreads_rating && <InfoChip label={`${research.goodreads_rating}★ Goodreads`} color="#f4c542" />}
              </div>
              <p style={{ color: '#c8c4bc', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>{research.synopsis}</p>
              {research.similar_series?.length > 0 && (
                <div>
                  <div style={{ color: '#9a9488', fontSize: 13, marginBottom: 8 }}>Similar series you might enjoy:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {research.similar_series.map((s, i) => (
                      <span key={i} onClick={() => { setResearchQuery(s); setTab('research') }}
                        style={{ ...tagStyle, cursor: 'pointer', color: '#6ea8fe' }}>{s}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {!research && !loading && (
            <EmptyState icon="🔍" text="Search for any book series to get detailed info and similar recommendations" />
          )}
        </div>
      )}

      {/* Authors */}
      {tab === 'authors' && (
        <div>
          <p style={{ color: '#9a9488', fontSize: 14, marginBottom: 20 }}>
            Follow authors to track their new releases. Your library has {authors.length} authors.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {authors.map(a => (
              <div key={a.id} style={{
                ...cardStyle, padding: '10px 14px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between'
              }}>
                <div>
                  <span style={{ color: '#e8e4dc', fontSize: 14 }}>{a.name}</span>
                  <span style={{ color: '#555', fontSize: 12, marginLeft: 8 }}>
                    {a.series_count} series · {a.book_count} books
                  </span>
                </div>
                <button onClick={() => toggleFollow(a)} style={{
                  background: a.following ? '#6ea8fe22' : '#2a2822',
                  border: `1px solid ${a.following ? '#6ea8fe44' : '#3a3830'}`,
                  borderRadius: 20, color: a.following ? '#6ea8fe' : '#9a9488',
                  padding: '4px 14px', fontSize: 12, cursor: 'pointer'
                }}>
                  {a.following ? '✓ Following' : 'Follow'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RecommendCard({ rec }) {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ color: '#e8e4dc', fontWeight: 500, fontSize: 15 }}>{rec.name}</span>
        <span style={{ color: '#9a9488', fontSize: 13 }}>by {rec.author}</span>
        {rec.books_count && <span style={{ color: '#555', fontSize: 12 }}>{rec.books_count} books</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {rec.genres?.map(g => <span key={g} style={tagStyle}>{g}</span>)}
      </div>
      <p style={{ color: '#9a9488', fontSize: 13, lineHeight: 1.6 }}>{rec.reason}</p>
    </div>
  )
}

function InfoChip({ label, color = '#9a9488' }) {
  return <span style={{ background: '#2a2822', color, padding: '3px 10px', borderRadius: 20, fontSize: 12 }}>{label}</span>
}

function EmptyState({ icon, text }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 0', color: '#555' }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontSize: 14 }}>{text}</div>
    </div>
  )
}

const inputStyle = {
  flex: 1, background: '#1a1814', border: '1px solid #2a2822', borderRadius: 8,
  color: '#e8e4dc', padding: '10px 14px', fontSize: 14, outline: 'none'
}
const primaryBtn = {
  background: '#6ea8fe22', border: '1px solid #6ea8fe44', borderRadius: 8,
  color: '#6ea8fe', padding: '10px 18px', fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap'
}
const cardStyle = {
  background: '#1a1814', border: '1px solid #2a2822', borderRadius: 10, padding: '16px 18px'
}
const tagStyle = {
  background: '#2a2822', color: '#9a9488', padding: '3px 10px', borderRadius: 20, fontSize: 12
}
