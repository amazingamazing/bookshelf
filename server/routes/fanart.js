const router = require('express').Router();
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');

const DEVIANTART_CLIENT_ID = process.env.DEVIANTART_CLIENT_ID || null;
const DEVIANTART_CLIENT_SECRET = process.env.DEVIANTART_CLIENT_SECRET || null;
const DEVIANTART_TOKEN_URL = 'https://www.deviantart.com/oauth2/token';
const DEVIANTART_API_BASE = 'https://www.deviantart.com/api/v1/oauth2';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

let tokenCache = { accessToken: null, expiresAtMs: 0 };
const aiClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

router.get('/deviantart', async (req, res) => {
  try {
    const {
      book_id: rawBookId,
      series_id: rawSeriesId,
      query: rawQuery,
      limit: rawLimit
    } = req.query;
    const limit = Math.max(1, Math.min(20, Number(rawLimit) || 10));
    const allowMature = parseBoolean(req.query.allow_mature, false);
    const minEdge = Math.max(200, Math.min(4000, Number(req.query.min_edge) || 700));
    const sortMode = normalizeSortMode(req.query.sort_mode);
    const timeWindow = normalizeTimeWindow(req.query.time_window);
    const excludeAi = parseBoolean(req.query.exclude_ai, true);
    const perCreatorCap = Math.max(1, Math.min(5, Number(req.query.per_creator_cap) || 2));

    let searchText = (rawQuery || '').trim();
    const searchQueries = [];
    const relevanceHints = [];
    if (rawBookId) {
      const { rows } = await pool.query(`
        SELECT
          b.title,
          a.name AS author_name,
          s.name AS series_name
        FROM books b
        LEFT JOIN authors a ON a.id = b.author_id
        LEFT JOIN series s ON s.id = b.series_id
        WHERE b.id = $1
      `, [rawBookId]);
      if (!rows[0]) return res.status(404).json({ error: 'Book not found' });
      const b = rows[0];
      const pieces = [b.title, b.series_name, b.author_name];
      searchText = pieces.filter(Boolean).join(' ');
      searchQueries.push(searchText);
      searchQueries.push([b.title].filter(Boolean).join(' '));
      if (b.series_name) searchQueries.push([b.series_name].filter(Boolean).join(' '));
      if (b.title) relevanceHints.push(b.title);
      if (b.series_name) relevanceHints.push(b.series_name);
    }

    if (rawSeriesId) {
      const { rows } = await pool.query(`
        SELECT
          s.id,
          s.name AS series_name,
          a.name AS author_name,
          (
            SELECT b1.title
            FROM books b1
            WHERE b1.series_id = s.id
            ORDER BY b1.series_order NULLS LAST, b1.id
            LIMIT 1
          ) AS first_book_title,
          (
            SELECT ARRAY_AGG(bt.title)
            FROM (
              SELECT b2.title
              FROM books b2
              WHERE b2.series_id = s.id
              ORDER BY b2.series_order NULLS LAST, b2.id
              LIMIT 6
            ) bt
          ) AS sample_book_titles
        FROM series s
        LEFT JOIN authors a ON a.id = s.author_id
        WHERE s.id = $1
      `, [rawSeriesId]);
      if (!rows[0]) return res.status(404).json({ error: 'Series not found' });
      const s = rows[0];

      const seriesQuery = [s.series_name, s.author_name].filter(Boolean).join(' ');
      searchQueries.push(seriesQuery);
      searchQueries.push([s.series_name].filter(Boolean).join(' '));
      const acronym = buildSeriesAcronym(s.series_name);
      if (acronym) searchQueries.push([acronym].filter(Boolean).join(' '));
      if (s.series_name) relevanceHints.push(s.series_name);

      if (s.first_book_title) {
        const bookOneQuery = [s.first_book_title, s.author_name].filter(Boolean).join(' ');
        searchQueries.push(bookOneQuery);
        searchQueries.push([s.first_book_title].filter(Boolean).join(' '));
        const shortBookTitle = stripBookSubtitle(s.first_book_title);
        if (shortBookTitle && shortBookTitle !== s.first_book_title) {
          searchQueries.push([shortBookTitle].filter(Boolean).join(' '));
          searchQueries.push([shortBookTitle, s.series_name].filter(Boolean).join(' '));
          relevanceHints.push(shortBookTitle);
        }
        relevanceHints.push(s.first_book_title);
      }

      const sampleTitles = Array.isArray(s.sample_book_titles) ? s.sample_book_titles : [];
      for (const title of sampleTitles.slice(0, 4)) {
        const cleanedTitle = stripBookSubtitle(title);
        if (!cleanedTitle) continue;
        searchQueries.push([cleanedTitle].filter(Boolean).join(' '));
        if (s.series_name) searchQueries.push([cleanedTitle, s.series_name].filter(Boolean).join(' '));
        relevanceHints.push(cleanedTitle);
      }
    }

    if (!searchText) {
      if (!searchQueries.length) return res.status(400).json({ error: 'Provide series_id, book_id, or query' });
    } else {
      searchQueries.push(searchText);
      relevanceHints.push(stripFanArtSuffix(searchText));
    }

    const dedupedQueries = Array.from(new Set(searchQueries.map(q => q.trim()).filter(Boolean)));
    const anchorPhrases = Array.from(new Set(relevanceHints
      .map(stripFanArtSuffix)
      .map(v => String(v || '').trim())
      .filter(v => v.length >= 4)));
    const relevanceProfiles = dedupedQueries.map(buildRelevanceProfile);
    const debug = {
      queries: dedupedQueries,
      anchor_phrases: anchorPhrases,
      stage_counts: {
        merged: 0,
        unique_links: 0,
        relevance_kept: 0,
        relevance_rejected: 0,
        live_kept: 0,
        quality_rejected: 0,
        time_rejected: 0,
        ai_rejected: 0
      }
    };
    const merged = [];
    for (const query of dedupedQueries) {
      const itemsForQuery = await searchDeviantArtRss(query, Math.max(20, limit * 3), { allowMature });
      merged.push(...itemsForQuery.map(item => ({ ...item, query })));
      if (merged.length >= limit * 12) break;
    }
    debug.stage_counts.merged = merged.length;

    const seen = new Set();
    const unique = [];
    let relevanceRejected = 0;
    const relevanceExamples = [];
    for (const item of merged) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      const relevance = evaluateRelevance(item, relevanceProfiles, anchorPhrases);
      if (!relevance.pass) {
        relevanceRejected++;
        continue;
      }
      const scoredItem = {
        ...item,
        relevance_reason: relevance.reason,
        relevance_score: relevance.score
      };
      unique.push(scoredItem);
      if (relevanceExamples.length < 5) {
        relevanceExamples.push({
          title: item.title,
          reason: relevance.reason,
          score: relevance.score
        });
      }
      if (unique.length >= limit * 12) break;
    }
    debug.stage_counts.unique_links = seen.size;
    debug.stage_counts.relevance_kept = unique.length;
    debug.stage_counts.relevance_rejected = relevanceRejected;
    debug.relevance_examples = relevanceExamples;

    const withLiveImages = [];
    const targetCandidatePool = Math.max(limit * 6, 24);
    let qualityRejected = 0;
    let timeRejected = 0;
    for (const item of unique) {
      const ok = await urlLooksLikeImage(item.image_url);
      if (!ok) continue;
      if (!passesQualityFloor(item, minEdge)) {
        qualityRejected++;
        continue;
      }
      if (!passesTimeWindow(item, timeWindow)) {
        timeRejected++;
        continue;
      }
      withLiveImages.push(item);
      if (withLiveImages.length >= targetCandidatePool) break;
    }
    debug.stage_counts.live_kept = withLiveImages.length;
    debug.stage_counts.quality_rejected = qualityRejected;
    debug.stage_counts.time_rejected = timeRejected;

    const canEnrich = Boolean(DEVIANTART_CLIENT_ID && DEVIANTART_CLIENT_SECRET);
    let enriched = withLiveImages;
    if (canEnrich && withLiveImages.length > 0) {
      const metadataById = await fetchDeviationMetadata(withLiveImages.map(item => item.deviation_id).filter(Boolean), allowMature);
      enriched = withLiveImages.map(item => {
        const metadata = item.deviation_id ? metadataById.get(item.deviation_id) : null;
        const stats = metadata?.stats || null;
        const popularityScore = computePopularityScore(stats);
        const qualityScore = computeQualityScore(item);
        const relevanceScore = Number(item.relevance_score) || 0;
        const score = popularityScore + qualityScore + relevanceScore;
        return {
          ...item,
          stats,
          tags: normalizeTags(metadata?.tags || []),
          quality_score: Number(qualityScore.toFixed(3)),
          popularity_score: Number(popularityScore.toFixed(3)),
          score: Number(score.toFixed(3)),
          metadata_enriched: Boolean(metadata)
        };
      });
    } else {
      enriched = withLiveImages
        .map(item => ({
          ...item,
          tags: [],
          quality_score: Number(computeQualityScore(item).toFixed(3)),
          popularity_score: null,
          score: Number((computeQualityScore(item) + (Number(item.relevance_score) || 0)).toFixed(3)),
          metadata_enriched: false
        }));
    }

    let filtered = enriched;
    if (excludeAi) {
      const before = filtered.length;
      filtered = filtered.filter(item => !looksLikeAiArt(item));
      debug.stage_counts.ai_rejected = Math.max(0, before - filtered.length);
    }

    const sorted = sortFanartItems(filtered, sortMode);
    const diversified = diversifyByCreator(sorted, limit, perCreatorCap);

    res.json({
      source: 'deviantart_rss',
      query: dedupedQueries.join(' || '),
      queries: dedupedQueries,
      allow_mature: allowMature,
      quality_floor_min_edge: minEdge,
      sort_mode: sortMode,
      time_window: timeWindow,
      exclude_ai: excludeAi,
      per_creator_cap: perCreatorCap,
      count: diversified.length,
      metadata_enrichment: canEnrich,
      metadata_enrichment_reason: canEnrich ? null : 'Set DEVIANTART_CLIENT_ID and DEVIANTART_CLIENT_SECRET to enable engagement-based ranking',
      debug,
      items: diversified
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reddit', async (req, res) => {
  try {
    const rawSeriesId = Number(req.query.series_id);
    const rawLimit = Number(req.query.limit);
    const allowMature = parseBoolean(req.query.allow_mature, false);
    const perSubredditLimit = Math.max(1, Math.min(8, Number(req.query.per_subreddit_limit) || 5));
    const subredditLimit = Math.max(1, Math.min(12, Number(req.query.subreddit_limit) || 6));
    const overallLimit = Math.max(5, Math.min(120, Number.isFinite(rawLimit) ? rawLimit : perSubredditLimit * subredditLimit));
    if (!Number.isFinite(rawSeriesId)) {
      return res.status(400).json({ error: 'Provide series_id' });
    }

    const series = await loadSeriesContext(rawSeriesId);
    if (!series) return res.status(404).json({ error: 'Series not found' });

    const discovery = await discoverRedditTargets(req, series);
    const subreddits = (discovery.subreddits || []).slice(0, subredditLimit);
    const queries = (discovery.queries || []).slice(0, 8);
    if (!subreddits.length || !queries.length) {
      return res.json({
        source: 'reddit_public_json',
        count: 0,
        series,
        subreddits,
        queries,
        debug: {
          discovery_source: discovery.source || 'fallback',
          api_mode: 'direct_urls',
          subreddit_errors: [],
          subreddit_counts: {}
        },
        items: []
      });
    }
    const items = [];
    const seenUrls = new Set();
    const subredditErrors = [];
    const subredditCounts = {};
    const subredditStats = {};
    for (const subreddit of subreddits) {
      const result = await collectRedditImagesForSubreddit(subreddit, queries, {
        perSubredditLimit,
        allowMature,
        series
      });
      subredditCounts[subreddit] = result.items.length;
      subredditStats[subreddit] = result.stats || null;
      if (result.error) subredditErrors.push({ subreddit, error: result.error });
      for (const item of result.items) {
        const imageUrl = String(item.image_url || '').trim();
        if (!imageUrl || seenUrls.has(imageUrl)) continue;
        seenUrls.add(imageUrl);
        items.push(item);
        if (items.length >= overallLimit) break;
      }
      if (items.length >= overallLimit) break;
    }

    res.json({
      source: 'reddit_public_json',
      count: items.length,
      series,
      subreddits,
      queries,
      discovery_source: discovery.source || 'fallback',
      debug: {
        discovery_source: discovery.source || 'fallback',
        api_mode: 'direct_urls',
        subreddit_errors: subredditErrors,
        subreddit_counts: subredditCounts,
        subreddit_stats: subredditStats
      },
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function searchDeviantArtRss(searchText, limit, { allowMature }) {
  const rssUrl = `https://backend.deviantart.com/rss.xml?q=${encodeURIComponent(searchText)}&type=deviation&mature_content=${allowMature ? 'true' : 'false'}&include_mature=${allowMature ? 'true' : 'false'}`;
  const feedRes = await fetch(rssUrl);
  if (!feedRes.ok) return [];
  const xml = await feedRes.text();
  return parseRssItems(xml)
    .filter(item => item.title && item.link && item.image_url)
    .slice(0, limit);
}

async function loadSeriesContext(seriesId) {
  const { rows } = await pool.query(`
    SELECT
      s.id,
      s.name AS series_name,
      a.name AS author_name,
      (
        SELECT b1.title
        FROM books b1
        WHERE b1.series_id = s.id
        ORDER BY b1.series_order NULLS LAST, b1.id
        LIMIT 1
      ) AS first_book_title
    FROM series s
    LEFT JOIN authors a ON a.id = s.author_id
    WHERE s.id = $1
    LIMIT 1
  `, [seriesId]);
  return rows[0] || null;
}

async function discoverRedditTargets(req, series) {
  const seriesTokens = tokenizeSeriesTerms(series);
  const fallback = {
    source: 'fallback',
    subreddits: buildSeriesSpecificFallbackSubreddits(series),
    queries: buildFallbackQueries(series)
  };
  try {
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host');
    if (!host) return fallback;
    const endpoint = `${protocol}://${host}/api/ai/reddit-discover`;
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ series_id: series.id })
    }, 12000);
    if (!response.ok) return fallback;
    const data = await response.json();
    const blockedGeneric = new Set([
      'fanart', 'digitalart', 'characterdrawing', 'imaginarynetwork', 'fantasy', 'books', 'art', 'drawing', 'illustration'
    ]);
    const subreddits = dedupeLowerStrings(data?.subreddits)
      .filter(name => !blockedGeneric.has(name))
      .filter(name => isSeriesSpecificSubreddit(name, seriesTokens))
      .slice(0, 12);
    const queries = dedupeQueryStrings(data?.queries).slice(0, 10);
    if (!subreddits.length || !queries.length) return fallback;
    return { source: 'claude', subreddits, queries };
  } catch {
    return fallback;
  }
}

async function collectRedditImagesForSubreddit(subreddit, queries, options) {
  const perSubredditLimit = Math.max(1, Number(options?.perSubredditLimit) || 5);
  const allowMature = Boolean(options?.allowMature);
  const series = options?.series || null;
  const safeSubreddit = String(subreddit || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  if (!safeSubreddit) return { items: [], error: 'invalid_subreddit' };

  const out = [];
  const seenUrls = new Set();
  const pickedQueries = buildRedditSearchQueries((Array.isArray(queries) ? queries : []).slice(0, 4));
  const discoveredFlairs = new Set();
  const flairCounts = new Map();
  const flairSamples = new Map();
  const stats = {
    scanned_posts: 0,
    rejected_non_art: 0,
    kept_posts: 0,
    flair_discovery_scanned: 0,
    flair_counts: {},
    discovered_flairs: [],
    selected_flair: null,
    selected_flair_reason: null,
    selected_flair_confidence: null,
    request_attempts: []
  };
  try {
    const discoveryPasses = [
      { stage: 'top_year', path: `/r/${safeSubreddit}/top.json?t=year&limit=100&raw_json=1` },
      { stage: 'hot_now', path: `/r/${safeSubreddit}/hot.json?limit=100&raw_json=1` }
    ];

    for (const pass of discoveryPasses) {
      const path = pass.path;
      const listing = await fetchRedditListingByPath(path);
      if (Array.isArray(listing.trace) && listing.trace.length) {
        stats.request_attempts.push(...listing.trace.map(t => ({ ...t, stage: pass.stage })));
      }
      for (const post of listing.posts) {
        stats.flair_discovery_scanned += 1;
        const flair = String(post?.link_flair_text || '').trim();
        if (!flair) continue;
        discoveredFlairs.add(flair);
        flairCounts.set(flair, (flairCounts.get(flair) || 0) + 1);
        if (!flairSamples.has(flair)) flairSamples.set(flair, []);
        const title = String(post?.title || '').trim();
        if (title && flairSamples.get(flair).length < 3) flairSamples.get(flair).push(title);
      }
      pushImagesFromPosts(listing.posts, {
        output: out,
        seenUrls,
        perSubredditLimit,
        subreddit: safeSubreddit,
        queryUsed: pass.stage,
        allowMature,
        stats
      });
      if (out.length >= perSubredditLimit) {
        stats.discovered_flairs = sortFlairsByCount(flairCounts);
        stats.flair_counts = mapFlairCounts(flairCounts);
        return { items: out, stats };
      }
    }

    const pickedFlair = await pickBestRedditFlairForSeries({
      series,
      subreddit: safeSubreddit,
      flairCounts,
      flairSamples
    });
    if (pickedFlair?.selectedFlair) {
      stats.selected_flair = pickedFlair.selectedFlair;
      stats.selected_flair_reason = pickedFlair.reason || null;
      stats.selected_flair_confidence = pickedFlair.confidence || null;
    }

    const pickedFlairName = String(pickedFlair?.selectedFlair || '').trim();
    const flairQuerySeed = pickedFlairName ? [pickedFlairName] : Array.from(discoveredFlairs);
    const flairQueries = buildFlairFocusedQueries(flairQuerySeed);
    const queryCandidates = dedupeQueryStrings([...flairQueries, ...pickedQueries]).slice(0, 16);

    for (const query of queryCandidates) {
      const path = `/r/${safeSubreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=year&limit=100&raw_json=1`;
      const listing = await fetchRedditListingByPath(path);
      if (Array.isArray(listing.trace) && listing.trace.length) {
        stats.request_attempts.push(...listing.trace.map(t => ({ ...t, stage: 'search', query })));
      }
      for (const post of listing.posts) {
        const flair = String(post?.link_flair_text || '').trim();
        if (!flair) continue;
        discoveredFlairs.add(flair);
        flairCounts.set(flair, (flairCounts.get(flair) || 0) + 1);
      }
      pushImagesFromPosts(listing.posts, {
        output: out,
        seenUrls,
        perSubredditLimit,
        subreddit: safeSubreddit,
        queryUsed: query,
        allowMature,
        preferredFlair: pickedFlairName,
        stats
      });
      if (out.length >= perSubredditLimit) {
        stats.discovered_flairs = sortFlairsByCount(flairCounts);
        stats.flair_counts = mapFlairCounts(flairCounts);
        return { items: out, stats };
      }
    }

    stats.discovered_flairs = sortFlairsByCount(flairCounts);
    stats.flair_counts = mapFlairCounts(flairCounts);
    return { items: out, stats };
  } catch (err) {
    stats.discovered_flairs = sortFlairsByCount(flairCounts);
    stats.flair_counts = mapFlairCounts(flairCounts);
    return { items: out, error: err?.message || 'fetch_failed', stats };
  }
}

async function fetchRedditListingByPath(path) {
  const hosts = ['https://www.reddit.com', 'https://old.reddit.com', 'https://api.reddit.com'];
  const trace = [];
  for (const host of hosts) {
    const url = `${host}${path}`;
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'bookshelf-fanart-prototype/1.0 (contact: local-dev)',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }, 10000);
      trace.push({ host, status: response.status });
      if (!response.ok) continue;
      const data = await response.json();
      const posts = (data?.data?.children || []).map(item => item?.data).filter(Boolean);
      return { posts, trace };
    } catch (err) {
      trace.push({ host, status: 'error', error: err?.message || 'request_failed' });
    }
  }
  const statusSummary = trace.map(t => `${t.host}:${t.status}`).join(',');
  throw new Error(`reddit_all_hosts_failed:${statusSummary}`);
}

function mapFlairCounts(flairCounts) {
  const out = {};
  const pairs = [...(flairCounts || new Map()).entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of pairs) out[name] = count;
  return out;
}

function sortFlairsByCount(flairCounts) {
  return [...(flairCounts || new Map()).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .slice(0, 30);
}

async function pickBestRedditFlairForSeries({ series, subreddit, flairCounts, flairSamples }) {
  const candidates = [...(flairCounts || new Map()).entries()]
    .filter(([name]) => String(name || '').trim())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({
      name: String(name || '').trim(),
      count,
      sample_titles: (flairSamples?.get(name) || []).slice(0, 3)
    }));
  if (!candidates.length) return { selectedFlair: null, confidence: 'none', reason: 'no_flairs_discovered' };

  const heuristic = pickBestFlairHeuristic(candidates);
  if (!aiClient) {
    return {
      selectedFlair: heuristic?.name || null,
      confidence: heuristic ? 'medium' : 'low',
      reason: heuristic ? 'heuristic_art_keyword_match' : 'heuristic_no_match'
    };
  }

  try {
    const seriesName = String(series?.series_name || '').trim() || 'unknown series';
    const authorName = String(series?.author_name || '').trim();
    const prompt = [
      'Choose the single best Reddit flair that most likely represents fan art/image posts.',
      `Series: ${seriesName}`,
      authorName ? `Author: ${authorName}` : null,
      `Subreddit: r/${subreddit}`,
      'Flair candidates with counts and sample titles:',
      JSON.stringify(candidates, null, 2),
      'Return ONLY JSON with keys: selected_flair, confidence, reason.',
      'Rules:',
      '- selected_flair must exactly match one candidate name, or null if no art-like flair exists.',
      '- Prefer fan art, art, illustration, sketch, drawing, concept-art style labels.',
      '- Reject question/discussion/news/recommendation flairs.'
    ].filter(Boolean).join('\n');
    const message = await aiClient.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 280,
      messages: [{ role: 'user', content: prompt }]
    });
    const lastContent = message.content[message.content.length - 1];
    const text = lastContent?.type === 'text' ? lastContent.text : '';
    const parsed = parseJsonPayloadLoose(text);
    const chosen = String(parsed?.selected_flair || '').trim();
    const candidateNames = new Set(candidates.map(c => c.name));
    if (chosen && candidateNames.has(chosen)) {
      return {
        selectedFlair: chosen,
        confidence: String(parsed?.confidence || 'medium').trim() || 'medium',
        reason: String(parsed?.reason || 'llm_selected').trim() || 'llm_selected'
      };
    }
  } catch {
    // Fall through to heuristic.
  }

  return {
    selectedFlair: heuristic?.name || null,
    confidence: heuristic ? 'medium' : 'low',
    reason: heuristic ? 'heuristic_after_llm_fallback' : 'no_art_like_flair'
  };
}

function pickBestFlairHeuristic(candidates) {
  const artRegex = /\bfan[\s-]?art\b|\bart\b|illustration|drawing|sketch|concept/i;
  for (const candidate of candidates || []) {
    if (artRegex.test(String(candidate?.name || ''))) return candidate;
  }
  return null;
}

function parseJsonPayloadLoose(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = stripped.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }
  return JSON.parse(stripped);
}

function pushImagesFromPosts(posts, options) {
  const output = options?.output || [];
  const seenUrls = options?.seenUrls || new Set();
  const perSubredditLimit = Math.max(1, Number(options?.perSubredditLimit) || 5);
  const subreddit = String(options?.subreddit || '');
  const queryUsed = String(options?.queryUsed || '');
  const allowMature = Boolean(options?.allowMature);
  const preferredFlair = String(options?.preferredFlair || '').trim().toLowerCase();
  const stats = options?.stats;

  for (const post of posts || []) {
    if (stats) stats.scanned_posts += 1;
    if (output.length >= perSubredditLimit) break;
    if (!allowMature && Boolean(post?.over_18)) continue;
    const artSignal = detectArtSignal(post, queryUsed, preferredFlair);
    if (!artSignal.ok) {
      if (stats) stats.rejected_non_art += 1;
      continue;
    }
    const imageCandidates = extractImageUrlsFromRedditPost(post);
    if (!imageCandidates.length) continue;
    if (stats) stats.kept_posts += 1;
    for (const imageUrl of imageCandidates) {
      if (output.length >= perSubredditLimit) break;
      if (!imageUrl || seenUrls.has(imageUrl)) continue;
      seenUrls.add(imageUrl);
      output.push({
        source: 'reddit',
        image_url: imageUrl,
        post_url: buildRedditPostUrl(post),
        title: String(post?.title || '').trim() || null,
        subreddit,
        author: String(post?.author || '').trim() || null,
        score: Number(post?.score) || 0,
        created_utc: Number(post?.created_utc) || null,
        query_used: queryUsed,
        flair_text: String(post?.link_flair_text || '').trim() || null,
        art_signal: artSignal.reason
      });
    }
  }
}

function detectArtSignal(post, queryUsed, preferredFlair) {
  const flair = String(post?.link_flair_text || '').toLowerCase();
  const title = String(post?.title || '').toLowerCase();
  const selftext = String(post?.selftext || '').toLowerCase();
  const query = String(queryUsed || '').toLowerCase();
  const preferred = String(preferredFlair || '').toLowerCase();
  const hay = `${flair} ${title} ${selftext} ${query}`;
  if (preferred && flair === preferred) return { ok: true, reason: 'preferred_flair_exact_match' };
  if (query && /flair(_name)?:/.test(query) && flair && /\bart\b|fan[\s-]?art|illustration|drawing|sketch/i.test(flair)) {
    return { ok: true, reason: 'query_flair_match' };
  }
  if (/\bfan[\s-]?art\b/.test(hay)) return { ok: true, reason: 'fan_art' };
  if (/\billustration\b/.test(hay)) return { ok: true, reason: 'illustration' };
  if (/\bartwork\b/.test(hay)) return { ok: true, reason: 'artwork' };
  if (/\bsketch\b/.test(hay)) return { ok: true, reason: 'sketch' };
  if (/\bdrawing\b/.test(hay)) return { ok: true, reason: 'drawing' };
  if (/\bart\b/.test(flair)) return { ok: true, reason: 'flair_art' };
  return { ok: false, reason: 'no_art_tag' };
}

function extractImageUrlsFromRedditPost(post) {
  const out = [];
  const push = (value) => {
    const normalized = normalizeImageUrl(value);
    if (!normalized) return;
    if (!out.includes(normalized)) out.push(normalized);
  };

  push(post?.url_overridden_by_dest);
  push(post?.preview?.images?.[0]?.source?.url);
  push(post?.thumbnail);

  const mediaMetadata = post?.media_metadata;
  if (mediaMetadata && typeof mediaMetadata === 'object') {
    for (const metadata of Object.values(mediaMetadata)) {
      push(metadata?.s?.u);
      push(metadata?.s?.gif);
    }
  }

  return out.filter(isLikelyImageUrl);
}

function normalizeImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'self' || raw === 'default' || raw === 'nsfw' || raw === 'spoiler') return '';
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/gi, '/');
}

function isLikelyImageUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  if (!value.startsWith('http://') && !value.startsWith('https://')) return false;
  if (/(i\.redd\.it|i\.redditmedia\.com|preview\.redd\.it|imgur\.com|deviantart\.com|artstation\.com)/.test(value)) {
    return true;
  }
  return /\.(png|jpe?g|webp|gif)(\?|$)/.test(value);
}

function buildRedditPostUrl(post) {
  const permalink = String(post?.permalink || '').trim();
  if (permalink) return `https://www.reddit.com${permalink}`;
  const fallback = String(post?.url || '').trim();
  return fallback || null;
}

function dedupeLowerStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = String(value || '')
      .trim()
      .replace(/^\/?r\//i, '')
      .replace(/[^a-zA-Z0-9_]/g, '')
      .toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function dedupeQueryStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = String(value || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function buildSeriesSpecificFallbackSubreddits(series) {
  const tokens = tokenizeSeriesTerms(series);
  const out = [];
  for (const token of tokens) {
    out.push(token);
    out.push(`${token}series`);
    out.push(`${token}books`);
    out.push(`${token}audiobook`);
  }
  return dedupeLowerStrings(out).slice(0, 8);
}

function buildFallbackSubreddits(series) {
  const seriesName = String(series?.series_name || '').toLowerCase();
  const out = [
    'fanart',
    'digitalart',
    'characterdrawing',
    'imaginarynetwork',
    'fantasy',
    'books',
    'litrpg',
    'progressionfantasy'
  ];
  if (seriesName.includes('warhammer')) out.unshift('warhammer40k');
  if (seriesName.includes('dungeon')) out.unshift('dungeoncrawlercarl');
  return dedupeLowerStrings(out).slice(0, 12);
}

function buildFallbackQueries(series) {
  const seriesName = String(series?.series_name || '').trim();
  const authorName = String(series?.author_name || '').trim();
  const firstBookTitle = String(series?.first_book_title || '').trim();
  const out = [];
  if (seriesName) out.push(seriesName);
  if (seriesName && authorName) out.push(`${seriesName} ${authorName}`);
  if (firstBookTitle) out.push(firstBookTitle);
  if (firstBookTitle && seriesName) out.push(`${firstBookTitle} ${seriesName}`);
  if (seriesName) {
    out.push(`${seriesName} fan art`);
    out.push(`${seriesName} fanart`);
    out.push(`${seriesName} illustration`);
    out.push(`${seriesName} flair_name:\"Fan Art\"`);
  }
  return dedupeQueryStrings(out).slice(0, 10);
}

function buildRedditSearchQueries(baseQueries) {
  const out = [];
  for (const query of baseQueries || []) {
    const cleaned = String(query || '').trim();
    if (!cleaned) continue;
    out.push(cleaned);
    out.push(`${cleaned} fan art`);
    out.push(`${cleaned} fanart`);
    out.push(`${cleaned} flair_name:\"Fan Art\"`);
    out.push(`${cleaned} flair_name:art`);
  }
  return dedupeQueryStrings(out).slice(0, 12);
}

function buildFlairFocusedQueries(flairs) {
  const out = [];
  const artFlairs = (Array.isArray(flairs) ? flairs : [])
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .filter(v => /\bart\b|fan[\s-]?art|illustration|drawing|sketch/i.test(v))
    .slice(0, 8);
  for (const flair of artFlairs) {
    out.push(`flair_name:\"${flair}\"`);
    out.push(`flair:\"${flair}\"`);
  }
  if (!out.length) {
    out.push('flair_name:\"Art\"');
    out.push('flair_name:\"Fan Art\"');
    out.push('flair_name:\"Fanart\"');
  }
  return dedupeQueryStrings(out).slice(0, 12);
}

function tokenizeSeriesTerms(series) {
  const raw = String(series?.series_name || '').toLowerCase();
  const out = [];
  for (const token of raw.split(/[^a-z0-9]+/g)) {
    if (token.length >= 3) out.push(token);
  }
  const collapsed = raw.replace(/[^a-z0-9]/g, '');
  if (collapsed.length >= 4) out.push(collapsed);
  return Array.from(new Set(out));
}

function isSeriesSpecificSubreddit(subreddit, tokens) {
  const normalized = String(subreddit || '').toLowerCase();
  if (!normalized) return false;
  for (const token of (tokens || [])) {
    if (normalized.includes(token)) return true;
  }
  return false;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 10000));
  try {
    return await fetch(url, {
      ...(init || {}),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseRssItems(xml) {
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  return itemBlocks.map(parseRssItem).filter(Boolean);
}

function parseRssItem(raw) {
  const title = decodeHtml(getTag(raw, 'title'));
  const link = getTag(raw, 'link');
  const guid = getTag(raw, 'guid');
  const creator = decodeHtml(getDcCreator(raw));
  const pubDate = getTag(raw, 'pubDate');
  const descriptionHtml = getTag(raw, 'description');
  const mediaContent = getMediaTag(raw, 'media:content');
  const mediaThumbnail = getMediaTag(raw, 'media:thumbnail');
  const descImage = getImageFromDescription(descriptionHtml);
  const descriptionText = decodeHtml(stripHtml(descriptionHtml));

  const imageUrl = mediaContent.url || descImage || mediaThumbnail.url;
  const urlDimensions = extractDimensionsFromUrl(imageUrl);
  const imageWidth = mediaContent.width || mediaThumbnail.width || urlDimensions.width || null;
  const imageHeight = mediaContent.height || mediaThumbnail.height || urlDimensions.height || null;

  if (!title || !link || !imageUrl) return null;
  return {
    title,
    link,
    creator: creator || null,
    published_at: pubDate || null,
    image_url: imageUrl,
    deviation_id: parseDeviationId(guid),
    description_text: descriptionText,
    image_width: imageWidth,
    image_height: imageHeight,
    creator_key: deriveCreatorKey(creator, link)
  };
}

function getTag(raw, tag) {
  const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? stripCdata(match[1]).trim() : '';
}

function getDcCreator(raw) {
  const match = raw.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/i);
  return match ? stripCdata(match[1]).trim() : '';
}

function getMediaTag(raw, tagName) {
  const match = raw.match(new RegExp(`<${tagName}([^>]*)\\/?>`, 'i'));
  if (!match) return { url: '', width: null, height: null };
  const attrs = match[1] || '';
  const url = (attrs.match(/url="([^"]+)"/i) || [])[1] || '';
  const widthRaw = (attrs.match(/width="([^"]+)"/i) || [])[1];
  const heightRaw = (attrs.match(/height="([^"]+)"/i) || [])[1];
  const width = widthRaw ? Number(widthRaw) : null;
  const height = heightRaw ? Number(heightRaw) : null;
  return {
    url,
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null
  };
}

function getImageFromDescription(description) {
  if (!description) return '';
  const match = description.match(/<img[^>]*src="([^"]+)"/i);
  return match ? match[1] : '';
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

async function urlLooksLikeImage(url) {
  try {
    let res = await fetch(url, { method: 'HEAD' });
    if (!res.ok || res.status === 405) {
      res = await fetch(url, { method: 'GET' });
      if (!res.ok) return false;
    }
    const contentType = res.headers.get('content-type') || '';
    return contentType.includes('image/');
  } catch {
    return false;
  }
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function extractDimensionsFromUrl(url) {
  const str = String(url || '');
  const match = str.match(/(?:w_|width=)(\d+).*(?:h_|height=)(\d+)/i) || str.match(/(?:h_|height=)(\d+).*(?:w_|width=)(\d+)/i);
  if (!match) return { width: null, height: null };
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { width: null, height: null };
  // If the regex hit h_ first branch, this still works because we only need edge sizes.
  return { width: a, height: b };
}

function passesQualityFloor(item, minEdge) {
  const width = Number(item.image_width);
  const height = Number(item.image_height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return Math.max(width, height) >= minEdge;
}

function passesTimeWindow(item, timeWindow) {
  if (timeWindow === 'all') return true;
  const ms = parsePublishedAtMs(item.published_at);
  if (!ms) return true; // keep unknowns instead of over-filtering
  const now = Date.now();
  const cutoff = now - timeWindowToMs(timeWindow);
  return ms >= cutoff;
}

function parseDeviationId(value) {
  const str = String(value || '').trim();
  const match = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0].toUpperCase() : null;
}

function computePopularityScore(stats) {
  if (!stats) return 0;
  const views = Number(stats.views) || 0;
  const favourites = Number(stats.favourites) || 0;
  const comments = Number(stats.comments) || 0;
  const downloads = Number(stats.downloads) || 0;
  return (
    Math.log1p(views) * 1.6 +
    Math.log1p(favourites) * 3.2 +
    Math.log1p(comments) * 1.3 +
    Math.log1p(downloads) * 1.8
  );
}

function computeQualityScore(item) {
  const width = Number(item.image_width) || 0;
  const height = Number(item.image_height) || 0;
  const edge = Math.max(width, height);
  if (!edge) return 0;
  return Math.log1p(edge) * 1.8;
}

function sortFanartItems(items, sortMode) {
  const arr = [...items];
  if (sortMode === 'newest') {
    arr.sort((a, b) => {
      const ams = parsePublishedAtMs(a.published_at) || 0;
      const bms = parsePublishedAtMs(b.published_at) || 0;
      if (bms !== ams) return bms - ams;
      return (b.score || 0) - (a.score || 0);
    });
    return arr;
  }
  arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  return arr;
}

async function getAccessToken() {
  if (!DEVIANTART_CLIENT_ID || !DEVIANTART_CLIENT_SECRET) return null;
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAtMs > now + 30000) return tokenCache.accessToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: DEVIANTART_CLIENT_ID,
    client_secret: DEVIANTART_CLIENT_SECRET
  });
  const res = await fetch(DEVIANTART_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) return null;
  const data = await res.json();
  const expiresInSec = Number(data.expires_in) || 3600;
  tokenCache = {
    accessToken: data.access_token || null,
    expiresAtMs: Date.now() + Math.max(60, expiresInSec - 60) * 1000
  };
  return tokenCache.accessToken;
}

async function fetchDeviationMetadata(deviationIds, allowMature) {
  const token = await getAccessToken();
  const result = new Map();
  if (!token || !deviationIds.length) return result;

  const uniqueIds = Array.from(new Set(deviationIds.filter(Boolean)));
  const chunkSize = 10; // API limit for ext_stats

  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const params = new URLSearchParams();
    params.set('access_token', token);
    params.set('ext_stats', 'true');
    params.set('mature_content', allowMature ? 'true' : 'false');
    for (const deviationId of chunk) params.append('deviationids[]', deviationId);

    const res = await fetch(`${DEVIANTART_API_BASE}/deviation/metadata?${params.toString()}`);
    if (!res.ok) continue;
    const data = await res.json();
    const metadataRows = data.metadata || [];
    for (const row of metadataRows) {
      if (!row?.deviationid) continue;
      result.set(String(row.deviationid).toUpperCase(), row);
    }
  }

  return result;
}

function diversifyByCreator(items, limit, perCreatorCap) {
  if (!Array.isArray(items) || !items.length) return [];
  const byCreator = new Map();
  const selected = [];

  for (const item of items) {
    let key = normalizeCreator(item.creator_key || item.creator);
    if (key === '__unknown_creator__') {
      // Don't collapse all unknown creators into one bucket.
      key = `__unknown_creator__:${item.deviation_id || item.link || Math.random()}`;
    }
    const count = byCreator.get(key) || 0;
    if (count < perCreatorCap) {
      selected.push(item);
      byCreator.set(key, count + 1);
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

function normalizeCreator(creator) {
  const raw = String(creator || '').trim().toLowerCase();
  return raw || '__unknown_creator__';
}

function deriveCreatorKey(creator, link) {
  const fromCreator = normalizeCreator(creator);
  if (fromCreator && fromCreator !== '__unknown_creator__') return fromCreator;
  const str = String(link || '');
  const match = str.match(/https?:\/\/([a-z0-9-]+)\.deviantart\.com/i);
  if (match) {
    const subdomain = String(match[1] || '').toLowerCase();
    if (subdomain && subdomain !== 'www') return subdomain;
  }
  const pathMatch = str.match(/https?:\/\/(?:www\.)?deviantart\.com\/([a-z0-9-]+)\//i);
  if (pathMatch) return String(pathMatch[1] || '').toLowerCase();
  return '__unknown_creator__';
}

function evaluateRelevance(item, profiles, anchorPhrases) {
  if (!profiles.length) return { pass: true, reason: 'no_profiles', score: 0 };
  const noisy = normalizeSearchText(`${item.title} ${item.description_text}`);
  if (/\b(pdf|script|movie\s+review|review)\b/i.test(noisy)) return { pass: false, reason: 'noise_term', score: -10 };

  const hayTitleTags = normalizeSearchText([
    item.title,
    ...(item.tags || []),
    item.creator
  ].join(' '));
  const hayTitleTagsLoose = normalizeLooseText(hayTitleTags);
  const hayDescription = normalizeSearchText([
    item.description_text
  ].join(' '));
  const anchorTokens = tokenize((anchorPhrases || []).join(' '))
    .filter(token => token.length >= 4)
    .filter(token => !isNoiseToken(token));
  const anchorTokenHitCount = anchorTokens.reduce((acc, token) => acc + (hayTitleTags.includes(token) ? 1 : 0), 0);
  const anchorStrongHitCount = anchorTokens.reduce((acc, token) => acc + (hayTitleTags.includes(token) && !isWeakFranchiseToken(token) ? 1 : 0), 0);
  let score = 0;
  let reason = 'weak_signal';
  let hasStrongSignal = false;

  // First, prefer direct phrase anchoring against the intended series/book strings.
  for (const anchor of (anchorPhrases || [])) {
    const normalizedAnchor = normalizeSearchText(anchor);
    const looseAnchor = normalizeLooseText(anchor);
    if (!normalizedAnchor) continue;
    if (hayTitleTags.includes(normalizedAnchor) || (looseAnchor && hayTitleTagsLoose.includes(looseAnchor))) {
      score += 4.5;
      reason = `anchor:${anchor}`;
      hasStrongSignal = true;
      break;
    }
  }

  score += Math.min(3, anchorTokenHitCount) * 0.9;
  if (anchorStrongHitCount >= 1) score += 0.6;

  for (const profile of profiles) {
    const phrase = normalizeSearchText(profile.phrase || '');
    const loosePhrase = normalizeLooseText(profile.phrase || '');
    if (phrase && phrase.length >= 8 && (hayTitleTags.includes(phrase) || (loosePhrase && hayTitleTagsLoose.includes(loosePhrase)))) {
      score += 3;
      reason = `phrase:${profile.phrase}`;
      hasStrongSignal = true;
      break;
    }

    const matchedTokens = profile.tokens.filter(token => hayTitleTags.includes(token));
    const matchesInTitleTags = matchedTokens.length;
    const strongMatchesInTitleTags = matchedTokens.filter(token => !isWeakFranchiseToken(token)).length;
    if (matchesInTitleTags >= 2) {
      score += Math.min(3, matchesInTitleTags) * 0.8;
      reason = `title_tokens:${matchesInTitleTags}`;
      if (strongMatchesInTitleTags >= 1) hasStrongSignal = true;
    }
  }

  // Description text is noisy, keep it weak.
  const descMatches = profiles.reduce((best, profile) => {
    const matches = profile.tokens.reduce((acc, token) => acc + (hayDescription.includes(token) ? 1 : 0), 0);
    return Math.max(best, matches);
  }, 0);
  if (descMatches >= 4 && anchorTokenHitCount >= 2) {
    score += 1.2;
    if (reason === 'weak_signal') reason = `desc_tokens:${descMatches}`;
  }

  // Require at least one meaningful anchor/profile signal.
  if (!hasStrongSignal) {
    return { pass: false, reason: 'weak_relevance', score: Number(score.toFixed(3)) };
  }

  // Require a minimum relevance score even for strong-ish matches.
  if (score < 2.2) {
    return { pass: false, reason: 'weak_relevance', score: Number(score.toFixed(3)) };
  }

  return { pass: true, reason, score: Number(score.toFixed(3)) };
}

function tokenize(value) {
  return normalizeSearchText(value).split(' ').filter(Boolean);
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeLooseText(value) {
  return normalizeSearchText(value)
    .split(' ')
    .filter(Boolean)
    .filter(token => !['a', 'an', 'the'].includes(token))
    .join(' ');
}

function isNoiseToken(token) {
  return [
    'fan', 'art', 'series', 'book', 'books', 'review', 'movie', 'pdf',
    'the', 'and', 'with', 'from', 'for', 'this', 'that', 'one', 'last',
    'hosts', 'morning'
  ].includes(token);
}

function isWeakFranchiseToken(token) {
  return [
    'wheel', 'time', 'ice', 'fire', 'song', 'world'
  ].includes(String(token || '').toLowerCase());
}

function buildRelevanceProfile(query) {
  const tokens = tokenize(query)
    .filter(token => token.length >= 3)
    .filter(token => !isNoiseToken(token));
  const strongTokens = tokens.filter(token => token.length >= 5);
  const phrase = String(query || '').toLowerCase().trim();
  return { query, tokens, strongTokens, phrase };
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function stripFanArtSuffix(value) {
  return String(value || '').replace(/\s+fan\s+art\s*$/i, '').trim();
}

function stripBookSubtitle(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // "The Eye of the World: Book One of The Wheel of Time" => "The Eye of the World"
  const colonSplit = raw.split(':')[0].trim();
  return colonSplit || raw;
}

function buildSeriesAcronym(seriesName) {
  const words = String(seriesName || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .map(w => w.trim())
    .filter(Boolean)
    .filter(w => !['the', 'of', 'and', 'a', 'an'].includes(w));
  if (words.length < 3) return '';
  const acronym = words.map(w => w[0]).join('');
  return acronym.length >= 3 ? acronym.toUpperCase() : '';
}

function normalizeSortMode(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'newest' ? 'newest' : 'popular';
}

function normalizeTimeWindow(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['1y', '3y', '5y', '10y', 'all'].includes(v)) return v;
  return 'all';
}

function timeWindowToMs(windowKey) {
  const day = 24 * 60 * 60 * 1000;
  const map = { '1y': 365 * day, '3y': 3 * 365 * day, '5y': 5 * 365 * day, '10y': 10 * 365 * day };
  return map[windowKey] || Number.MAX_SAFE_INTEGER;
}

function parsePublishedAtMs(raw) {
  const ts = Date.parse(String(raw || ''));
  return Number.isNaN(ts) ? null : ts;
}

function normalizeTags(tags) {
  return tags
    .map(tag => (typeof tag === 'string' ? tag : tag?.tag_name))
    .map(tag => String(tag || '').trim())
    .filter(Boolean);
}

function looksLikeAiArt(item) {
  const hay = [
    item.title,
    ...(item.tags || []),
    item.query
  ].join(' ').toLowerCase();

  return /(^|\W)(ai|midjourney|stable\s*diffusion|dall[\s-]?e|generative|ai[-\s]?generated|sdxl|novelai)(\W|$)/i.test(hay);
}

module.exports = router;
