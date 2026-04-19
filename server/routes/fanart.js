const router = require('express').Router();
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');

const DEVIANTART_CLIENT_ID = process.env.DEVIANTART_CLIENT_ID || null;
const DEVIANTART_CLIENT_SECRET = process.env.DEVIANTART_CLIENT_SECRET || null;
const DEVIANTART_TOKEN_URL = 'https://www.deviantart.com/oauth2/token';
const DEVIANTART_API_BASE = 'https://www.deviantart.com/api/v1/oauth2';
const ARTSTATION_SEARCH_URL = 'https://www.artstation.com/api/v2/search/projects.json';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

let tokenCache = { accessToken: null, expiresAtMs: 0 };
const aiClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const artstationAliasCache = new Map();

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
    const sourceDeviantart = parseBoolean(req.query.source_deviantart, true);
    const sourceArtstation = parseBoolean(req.query.source_artstation, true);

    let searchText = (rawQuery || '').trim();
    const searchQueries = [];
    const relevanceHints = [];
    let seriesContext = null;
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
      seriesContext = {
        id: null,
        series_name: b.series_name || null,
        author_name: b.author_name || null,
        first_book_title: b.title || null
      };
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
      seriesContext = s;

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
    let anchorPhrases = Array.from(new Set(relevanceHints
      .map(stripFanArtSuffix)
      .map(v => String(v || '').trim())
      .filter(v => v.length >= 4)));
    let relevanceProfiles = dedupedQueries.map(buildRelevanceProfile);
    const debug = {
      sources_enabled: {
        deviantart: sourceDeviantart,
        artstation: sourceArtstation
      },
      queries: dedupedQueries,
      anchor_phrases: anchorPhrases,
      artstation_expanded_terms: [],
      artstation_queries: [],
      artstation_executed_queries: [],
      per_source_counts: {
        merged_raw: { deviantart: 0, artstation: 0 },
        relevance_kept: { deviantart: 0, artstation: 0 },
        live_kept: { deviantart: 0, artstation: 0 },
        final_kept: { deviantart: 0, artstation: 0 }
      },
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
    const perSourceTarget = Math.max(limit * 9, 36);
    if (sourceDeviantart) {
      let mergedDeviant = 0;
      for (const query of dedupedQueries) {
        let itemsForQuery = await searchDeviantArtRss(query, Math.max(20, limit * 3), { allowMature });
        const queryLower = String(query || '').toLowerCase();
        if (!itemsForQuery.length && !/\bfan\s*art\b|\bfanart\b|\billustration\b|\bartwork\b/.test(queryLower)) {
          const fallbackQuery = `${query} fan art`;
          itemsForQuery = await searchDeviantArtRss(fallbackQuery, Math.max(20, limit * 3), { allowMature });
          debug.per_source_counts.merged_raw.deviantart += itemsForQuery.length;
          mergedDeviant += itemsForQuery.length;
          merged.push(...itemsForQuery.map(item => ({ ...item, query: fallbackQuery, source: 'deviantart' })));
        } else {
          debug.per_source_counts.merged_raw.deviantart += itemsForQuery.length;
          mergedDeviant += itemsForQuery.length;
          merged.push(...itemsForQuery.map(item => ({ ...item, query, source: 'deviantart' })));
        }
        if (mergedDeviant >= perSourceTarget) break;
      }
    }
    if (sourceArtstation) {
      const expandedTerms = await getArtStationExpandedTerms({
        series: seriesContext,
        queries: dedupedQueries
      });
      debug.artstation_expanded_terms = expandedTerms;
      const artstationQueries = buildArtStationSearchQueries(dedupedQueries, expandedTerms);
      debug.artstation_queries = artstationQueries;
      let mergedArtstation = 0;
      for (const query of artstationQueries) {
        debug.artstation_executed_queries.push(query);
        const itemsForQuery = await searchArtStationProjects(query, Math.max(20, limit * 3), { allowMature });
        debug.per_source_counts.merged_raw.artstation += itemsForQuery.length;
        mergedArtstation += itemsForQuery.length;
        merged.push(...itemsForQuery.map(item => ({ ...item, query, source: 'artstation' })));
        if (mergedArtstation >= perSourceTarget) break;
      }
      if (expandedTerms.length) {
        anchorPhrases = Array.from(new Set([
          ...anchorPhrases,
          ...expandedTerms.map(v => String(v || '').trim())
        ])).filter(v => v.length >= 4).slice(0, 32);
        const relevanceSeeds = dedupeQueryStrings([
          ...dedupedQueries,
          ...expandedTerms
        ]);
        relevanceProfiles = relevanceSeeds.map(buildRelevanceProfile);
      }
    }
    debug.anchor_phrases = anchorPhrases;
    debug.stage_counts.merged = merged.length;

    const seen = new Set();
    const unique = [];
    let relevanceRejected = 0;
    const relevanceExamples = [];
    for (const item of merged) {
      const dedupeKey = buildFanartDedupeKey(item);
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
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
      const sourceKey = item.source === 'artstation' ? 'artstation' : 'deviantart';
      debug.per_source_counts.relevance_kept[sourceKey] += 1;
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
      const ok = await urlLooksLikeImage(item.image_url, item.source);
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
      const sourceKey = item.source === 'artstation' ? 'artstation' : 'deviantart';
      debug.per_source_counts.live_kept[sourceKey] += 1;
      if (withLiveImages.length >= targetCandidatePool) break;
    }
    debug.stage_counts.live_kept = withLiveImages.length;
    debug.stage_counts.quality_rejected = qualityRejected;
    debug.stage_counts.time_rejected = timeRejected;

    const canEnrich = Boolean(sourceDeviantart && DEVIANTART_CLIENT_ID && DEVIANTART_CLIENT_SECRET);
    let enriched = withLiveImages;
    const deviantItems = withLiveImages.filter(item => item.source === 'deviantart');
    const metadataById = canEnrich && deviantItems.length > 0
      ? await fetchDeviationMetadata(deviantItems.map(item => item.deviation_id).filter(Boolean), allowMature)
      : new Map();
    enriched = withLiveImages.map(item => {
      const relevanceScore = Number(item.relevance_score) || 0;
      const qualityScore = computeQualityScore(item);
      if (item.source === 'artstation') {
        const popularityScore = computeArtStationPopularityScore(item.stats);
        const score = popularityScore + qualityScore + relevanceScore;
        return {
          ...item,
          tags: normalizeTags(item.tags || []),
          quality_score: Number(qualityScore.toFixed(3)),
          popularity_score: Number(popularityScore.toFixed(3)),
          score: Number(score.toFixed(3)),
          metadata_enriched: false
        };
      }
      const metadata = item.deviation_id ? metadataById.get(item.deviation_id) : null;
      const stats = metadata?.stats || null;
      const popularityScore = computePopularityScore(stats);
      const score = popularityScore + qualityScore + relevanceScore;
      return {
        ...item,
        stats,
        tags: normalizeTags((metadata?.tags || item.tags || [])),
        quality_score: Number(qualityScore.toFixed(3)),
        popularity_score: Number(popularityScore.toFixed(3)),
        score: Number(score.toFixed(3)),
        metadata_enriched: Boolean(metadata)
      };
    });

    let filtered = enriched;
    if (excludeAi) {
      const before = filtered.length;
      filtered = filtered.filter(item => !looksLikeAiArt(item));
      debug.stage_counts.ai_rejected = Math.max(0, before - filtered.length);
    }

    const sorted = sortFanartItems(filtered, sortMode);
    const diversified = diversifyByCreator(sorted, limit, perCreatorCap);
    for (const item of diversified) {
      const sourceKey = item.source === 'artstation' ? 'artstation' : 'deviantart';
      debug.per_source_counts.final_kept[sourceKey] += 1;
    }

    res.json({
      source: 'fanart_multi',
      query: dedupedQueries.join(' || '),
      queries: dedupedQueries,
      allow_mature: allowMature,
      quality_floor_min_edge: minEdge,
      sort_mode: sortMode,
      time_window: timeWindow,
      exclude_ai: excludeAi,
      per_creator_cap: perCreatorCap,
      count: diversified.length,
      sources_enabled: {
        deviantart: sourceDeviantart,
        artstation: sourceArtstation
      },
      metadata_enrichment: canEnrich,
      metadata_enrichment_reason: canEnrich ? null : 'DeviantArt engagement enrichment disabled (set DEVIANTART_CLIENT_ID and DEVIANTART_CLIENT_SECRET). ArtStation uses likes/views from search payload.',
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
    const perSubredditBudgetMs = Math.max(5000, Math.min(45000, Number(req.query.per_subreddit_budget_ms) || 18000));
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
        series,
        timeBudgetMs: perSubredditBudgetMs
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

async function searchArtStationProjects(searchText, limit, { allowMature }) {
  const target = Math.max(1, Math.min(120, Number(limit) || 30));
  const perPage = Math.min(100, Math.max(12, target));
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 2; page += 1) {
    const rows = await fetchArtStationSearchPage(searchText, page, perPage);
    if (!rows.length) break;
    for (const row of rows) {
      const item = mapArtStationProject(row, searchText);
      if (!item) continue;
      if (!allowMature && item.is_mature) continue;
      if (seen.has(item.hash_id)) continue;
      seen.add(item.hash_id);
      out.push(item);
      if (out.length >= target) return out;
    }
  }
  return out;
}

async function fetchArtStationSearchPage(searchText, page, perPage) {
  const params = new URLSearchParams({
    page: String(Math.max(1, Number(page) || 1)),
    per_page: String(Math.max(1, Math.min(100, Number(perPage) || 24))),
    query: String(searchText || ''),
    sorting: 'relevance'
  });
  const url = `${ARTSTATION_SEARCH_URL}?${params.toString()}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'bookshelf-fanart-prototype/1.0 (contact: local-dev)',
          'Accept': 'application/json'
        }
      }, 10000);
      if (response.status === 429 && attempt < 3) {
        await sleep(computeRetryDelayMs(response.headers.get('retry-after'), attempt));
        continue;
      }
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload?.data) ? payload.data : [];
    } catch {
      if (attempt < 3) {
        await sleep(computeRetryDelayMs(null, attempt));
        continue;
      }
      return [];
    }
  }
  return [];
}

function mapArtStationProject(row, query) {
  const hashId = String(row?.hash_id || '').trim();
  if (!hashId) return null;
  const cover = row?.cover || {};
  const topLevelCover =
    row?.cover_url ||
    row?.small_image_url ||
    row?.medium_image_url ||
    row?.large_image_url ||
    row?.smaller_square_cover_url ||
    row?.small_square_cover_url ||
    row?.medium_square_cover_url ||
    '';
  const imageUrl = normalizeImageUrl(
    cover.medium_image_url ||
    cover.small_image_url ||
    cover.large_image_url ||
    cover.original_image_url ||
    cover.small_square_url ||
    cover.medium_square_url ||
    topLevelCover
  );
  if (!imageUrl) return null;
  const permalink = String(row?.permalink || row?.url || '').trim();
  const projectUrl = permalink.startsWith('http') ? permalink : (permalink ? `https://www.artstation.com${permalink}` : `https://www.artstation.com/projects/${hashId}`);
  const tags = normalizeTags(row?.tags || []);
  const user = row?.user || {};
  const creator = String(user.full_name || user.username || '').trim() || null;
  const title = String(row?.title || '').trim() || null;
  const descriptionText = String(row?.description || '').trim() || null;
  const likes = Number(row?.likes_count) || 0;
  const views = Number(row?.views_count) || 0;
  const mature = Boolean(row?.is_adult || row?.adult_content || row?.nsfw || row?.hide_as_adult);
  return {
    source: 'artstation',
    hash_id: hashId,
    title,
    link: projectUrl,
    image_url: imageUrl,
    published_at: String(row?.published_at || row?.created_at || '').trim() || null,
    creator,
    creator_key: normalizeCreator(creator || user.username || hashId),
    description_text: descriptionText,
    image_width: Number(cover.width) || null,
    image_height: Number(cover.height) || null,
    tags,
    stats: {
      likes,
      views
    },
    query,
    is_mature: mature
  };
}

function buildFanartDedupeKey(item) {
  if (!item) return '';
  if (item.source === 'artstation') return `artstation:${String(item.hash_id || item.link || '').trim().toLowerCase()}`;
  return `deviantart:${String(item.link || item.image_url || '').trim().toLowerCase()}`;
}

function buildArtStationSearchQueries(baseQueries, expandedTerms) {
  const seeds = dedupeQueryStrings([
    ...(Array.isArray(expandedTerms) ? expandedTerms : []),
    ...(Array.isArray(baseQueries) ? baseQueries : [])
  ]);
  seeds.sort((a, b) => scoreArtStationSeed(a) - scoreArtStationSeed(b));
  const out = [];
  for (const seed of seeds) {
    const cleaned = String(seed || '').trim();
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    out.push(cleaned);
    if (!/\bfan\s*art\b/.test(lower)) out.push(`${cleaned} fan art`);
    if (!/\bfanart\b/.test(lower)) out.push(`${cleaned} fanart`);
    if (!/\billustration\b/.test(lower)) out.push(`${cleaned} illustration`);
    if (!/\bartwork\b/.test(lower)) out.push(`${cleaned} artwork`);
  }
  return dedupeQueryStrings(out).slice(0, 16);
}

function scoreArtStationSeed(seed) {
  const raw = String(seed || '').trim().toLowerCase();
  if (!raw) return 999;
  let score = 0;
  const words = raw.split(/\s+/g).filter(Boolean);
  score += words.length;
  if (raw.includes('j.k. rowling') || raw.includes('jk rowling')) score += 5;
  if (raw.includes(' and the ')) score += 2;
  if (/\bfan\s*art\b|\bfanart\b|\billustration\b|\bartwork\b/.test(raw)) score += 1;
  return score;
}

async function getArtStationExpandedTerms({ series, queries }) {
  const key = buildArtstationCacheKey(series);
  if (!key) return [];
  const now = Date.now();
  const cached = artstationAliasCache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.terms;

  const fallbackTerms = buildArtStationFallbackTerms(series, queries);
  if (!aiClient) {
    artstationAliasCache.set(key, { terms: fallbackTerms, expiresAtMs: now + (180 * 24 * 60 * 60 * 1000) });
    return fallbackTerms;
  }
  try {
    const seriesName = String(series?.series_name || '').trim();
    const authorName = String(series?.author_name || '').trim();
    const firstBookTitle = String(series?.first_book_title || '').trim();
    const prompt = [
      'Generate a compact set of ArtStation search aliases for fan art discovery.',
      `Series: ${seriesName || 'unknown'}`,
      authorName ? `Author: ${authorName}` : null,
      firstBookTitle ? `First book: ${firstBookTitle}` : null,
      `Current search seeds: ${dedupeQueryStrings(queries || []).slice(0, 8).join(' | ')}`,
      'Return ONLY JSON with key: terms.',
      'terms must be an array of 4-10 short strings that artists would realistically tag or title.',
      'Prefer franchise aliases, adaptation names, setting names, and iconic character names.',
      'No subreddit names, no flair syntax, no punctuation-heavy strings.'
    ].filter(Boolean).join('\n');
    const message = await aiClient.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 260,
      messages: [{ role: 'user', content: prompt }]
    });
    const lastContent = message.content[message.content.length - 1];
    const text = lastContent?.type === 'text' ? lastContent.text : '';
    const parsed = parseJsonPayloadLoose(text);
    const terms = sanitizeArtStationAliasTerms(parsed?.terms);
    const merged = dedupeQueryStrings([...fallbackTerms, ...terms]).slice(0, 12);
    artstationAliasCache.set(key, { terms: merged, expiresAtMs: now + (180 * 24 * 60 * 60 * 1000) });
    return merged;
  } catch {
    artstationAliasCache.set(key, { terms: fallbackTerms, expiresAtMs: now + (180 * 24 * 60 * 60 * 1000) });
    return fallbackTerms;
  }
}

function sanitizeArtStationAliasTerms(values) {
  const out = [];
  for (const value of values || []) {
    const cleaned = String(value || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    if (cleaned.length < 2 || cleaned.length > 64) continue;
    if (/(^|\s)flair(_name)?:/i.test(cleaned)) continue;
    out.push(cleaned);
  }
  return dedupeQueryStrings(out);
}

function buildArtstationCacheKey(series) {
  const seriesId = String(series?.id || '').trim();
  if (seriesId) return `series:${seriesId}`;
  const seriesName = normalizeSearchText(String(series?.series_name || '').trim());
  if (!seriesName) return '';
  return `name:${seriesName}`;
}

function buildArtStationFallbackTerms(series, queries) {
  const out = [];
  const seriesName = String(series?.series_name || '').trim();
  const firstBook = stripBookSubtitle(String(series?.first_book_title || '').trim());
  const acronym = buildSeriesAcronym(seriesName);
  if (seriesName) out.push(seriesName);
  if (firstBook) out.push(firstBook);
  if (acronym) out.push(acronym);
  out.push(...dedupeQueryStrings(queries || []).slice(0, 6));
  return dedupeQueryStrings(out).slice(0, 10);
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
  const subredditSignals = buildSubredditSignals(series);
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
      'fanart', 'digitalart', 'characterdrawing', 'imaginarynetwork', 'fantasy', 'books', 'art', 'drawing', 'illustration',
      'litrpg', 'progressionfantasy', 'gamelit'
    ]);
    const candidates = dedupeLowerStrings(data?.subreddits)
      .filter(name => !blockedGeneric.has(name))
      .slice(0, 12);
    const strictMatches = candidates
      .filter(name => isSeriesSpecificSubreddit(name, subredditSignals))
      .slice(0, 12);
    const subreddits = strictMatches.length ? strictMatches : candidates;
    const queries = sanitizeRedditSearchSeedQueries(data?.queries).slice(0, 10);
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
  const timeBudgetMs = Math.max(5000, Math.min(45000, Number(options?.timeBudgetMs) || 18000));
  const startedAtMs = Date.now();
  const safeSubreddit = String(subreddit || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  if (!safeSubreddit) return { items: [], error: 'invalid_subreddit' };

  const out = [];
  const seenUrls = new Set();
  const seenPostUrls = new Set();
  const flairOutputCounts = new Map();
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
    selected_flair_targets: [],
    request_attempts: []
  };
  let lastError = null;
  try {
    const discoveryPasses = [
      { stage: 'top_year', path: `/r/${safeSubreddit}/top.json?t=year&limit=100&raw_json=1` },
      { stage: 'hot_now', path: `/r/${safeSubreddit}/hot.json?limit=100&raw_json=1` }
    ];

    for (const pass of discoveryPasses) {
      if (Date.now() - startedAtMs > timeBudgetMs) {
        lastError = `subreddit_time_budget_exceeded:${timeBudgetMs}`;
        break;
      }
      const path = pass.path;
      const listing = await fetchRedditListingByPath(path);
      if (Array.isArray(listing.trace) && listing.trace.length) {
        stats.request_attempts.push(...listing.trace.map(t => ({ ...t, stage: pass.stage })));
      }
      if (listing.error) {
        lastError = listing.error;
        continue;
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
    }
    if (!stats.flair_discovery_scanned && isRedditAccessBlocked(lastError)) {
      stats.discovered_flairs = sortFlairsByCount(flairCounts);
      stats.flair_counts = mapFlairCounts(flairCounts);
      return { items: out, stats, error: lastError };
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
    const flairQuerySeed = selectRedditArtFlairTargets({
      selectedFlair: pickedFlairName,
      flairCounts,
      discoveredFlairs
    });
    stats.selected_flair_targets = flairQuerySeed;
    const flairQueries = buildFlairFocusedQueries(flairQuerySeed);
    const filteredPickedQueries = filterQueriesForSelectedFlair(pickedQueries, pickedFlairName);
    const queryCandidates = dedupeQueryStrings([...flairQueries, ...filteredPickedQueries]).slice(0, 10);

    for (const query of queryCandidates) {
      if (Date.now() - startedAtMs > timeBudgetMs) {
        lastError = `subreddit_time_budget_exceeded:${timeBudgetMs}`;
        break;
      }
      const path = `/r/${safeSubreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&t=year&limit=100&raw_json=1`;
      const listing = await fetchRedditListingByPath(path);
      if (Array.isArray(listing.trace) && listing.trace.length) {
        stats.request_attempts.push(...listing.trace.map(t => ({ ...t, stage: 'search', query })));
      }
      if (listing.error) {
        lastError = listing.error;
        continue;
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
        seenPostUrls,
        perSubredditLimit,
        subreddit: safeSubreddit,
        queryUsed: query,
        allowMature,
        preferredFlair: pickedFlairName,
        maxImagesPerPost: 1,
        flairOutputCounts,
        maxPerFlair: 3,
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
    if (!out.length && lastError) return { items: out, stats, error: lastError };
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
  let lastError = null;
  for (const host of hosts) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const url = `${host}${path}`;
      try {
        const response = await fetchWithTimeout(url, {
          headers: {
            'User-Agent': 'bookshelf-fanart-prototype/1.0 (contact: local-dev)',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        }, 5000);
        trace.push({ host, status: response.status, attempt });
        if (response.status === 429 && attempt < 2) {
          const waitMs = computeRetryDelayMs(response.headers.get('retry-after'), attempt);
          trace.push({ host, status: 'retrying_429', attempt, wait_ms: waitMs });
          await sleep(waitMs);
          continue;
        }
        if (!response.ok) {
          lastError = `http_${response.status}`;
          break;
        }
        const data = await response.json();
        const posts = (data?.data?.children || []).map(item => item?.data).filter(Boolean);
        return { posts, trace, error: null };
      } catch (err) {
        const message = err?.message || 'request_failed';
        trace.push({ host, status: 'error', error: message, attempt });
        lastError = message;
        if (attempt < 2) {
          const waitMs = computeRetryDelayMs(null, attempt);
          trace.push({ host, status: 'retrying_error', attempt, wait_ms: waitMs });
          await sleep(waitMs);
          continue;
        }
      }
    }
  }
  const statusSummary = trace.map(t => `${t.host}:${t.status}`).join(',');
  return {
    posts: [],
    trace,
    error: `reddit_all_hosts_failed:${statusSummary}${lastError ? `:${lastError}` : ''}`
  };
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
  const seenPostUrls = options?.seenPostUrls || new Set();
  const perSubredditLimit = Math.max(1, Number(options?.perSubredditLimit) || 5);
  const subreddit = String(options?.subreddit || '');
  const queryUsed = String(options?.queryUsed || '');
  const allowMature = Boolean(options?.allowMature);
  const preferredFlair = String(options?.preferredFlair || '').trim().toLowerCase();
  const maxImagesPerPost = Math.max(1, Number(options?.maxImagesPerPost) || 1);
  const flairOutputCounts = options?.flairOutputCounts || new Map();
  const maxPerFlair = Math.max(1, Number(options?.maxPerFlair) || 3);
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
    const flairText = String(post?.link_flair_text || '').trim();
    const flairKey = flairText.toLowerCase();
    if (flairKey) {
      const seenForFlair = Number(flairOutputCounts.get(flairKey) || 0);
      if (seenForFlair >= maxPerFlair) continue;
    }
    const postUrl = buildRedditPostUrl(post);
    if (postUrl && seenPostUrls.has(postUrl)) continue;
    const imageCandidates = extractImageUrlsFromRedditPost(post);
    if (!imageCandidates.length) continue;
    let pushedForPost = 0;
    for (const imageUrl of imageCandidates) {
      if (output.length >= perSubredditLimit) break;
      if (pushedForPost >= maxImagesPerPost) break;
      if (!imageUrl || seenUrls.has(imageUrl)) continue;
      seenUrls.add(imageUrl);
      pushedForPost += 1;
      output.push({
        source: 'reddit',
        image_url: imageUrl,
        post_url: postUrl,
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
    if (pushedForPost > 0) {
      if (flairKey) {
        const seenForFlair = Number(flairOutputCounts.get(flairKey) || 0);
        flairOutputCounts.set(flairKey, seenForFlair + pushedForPost);
      }
      if (postUrl) seenPostUrls.add(postUrl);
      if (stats) stats.kept_posts += 1;
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

function sanitizeRedditSearchSeedQueries(values) {
  const out = [];
  for (const value of values || []) {
    const cleaned = String(value || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    // Flair queries are constructed separately from discovered flair names.
    if (/(^|\s)flair(_name)?:/.test(lower)) continue;
    out.push(cleaned);
  }
  return dedupeQueryStrings(out);
}

function buildSeriesSpecificFallbackSubreddits(series) {
  const tokens = tokenizeSeriesTerms(series);
  const aliases = buildKnownFranchiseAliases(series);
  const out = [];
  for (const alias of aliases) {
    const compactAlias = alias.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (compactAlias) out.push(compactAlias);
  }
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
  const knownAliases = buildKnownFranchiseAliases(series);
  const out = [];
  if (seriesName) out.push(seriesName);
  if (seriesName && authorName) out.push(`${seriesName} ${authorName}`);
  if (firstBookTitle) out.push(firstBookTitle);
  if (firstBookTitle && seriesName) out.push(`${firstBookTitle} ${seriesName}`);
  for (const alias of knownAliases) {
    out.push(alias);
    out.push(`${alias} fan art`);
    out.push(`${alias} fanart`);
    out.push(`${alias} illustration`);
  }
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
    const lower = cleaned.toLowerCase();
    if (/(^|\s)flair(_name)?:/.test(lower)) continue;
    out.push(cleaned);
    if (!/\bfan\s*art\b/.test(lower)) out.push(`${cleaned} fan art`);
    if (!/\bfanart\b/.test(lower)) out.push(`${cleaned} fanart`);
    if (!/\billustration\b/.test(lower)) out.push(`${cleaned} illustration`);
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
    out.push(`flair:\"${flair}\"`);
    out.push(`flair_name:\"${flair}\"`);
  }
  if (!out.length) {
    out.push('flair:\"Art\"');
    out.push('flair_name:\"Art\"');
    out.push('flair:\"Fan Art\"');
    out.push('flair_name:\"Fan Art\"');
    out.push('flair:\"Fanart\"');
    out.push('flair_name:\"Fanart\"');
    out.push('flair:\"Fan Art No Spoilers\"');
    out.push('flair_name:\"Fan Art No Spoilers\"');
    out.push('flair:\"Fan Art Book 1\"');
    out.push('flair_name:\"Fan Art Book 1\"');
    out.push('flair:\"Fan Art Book 2\"');
    out.push('flair_name:\"Fan Art Book 2\"');
    out.push('flair:\"Fan Art Book 3\"');
    out.push('flair_name:\"Fan Art Book 3\"');
  }
  return dedupeQueryStrings(out).slice(0, 12);
}

function selectRedditArtFlairTargets({ selectedFlair, flairCounts, discoveredFlairs }) {
  const selected = String(selectedFlair || '').trim();
  const artLikeByCount = [...(flairCounts || new Map()).entries()]
    .filter(([name]) => /\bart\b|fan[\s-]?art|illustration|drawing|sketch/i.test(String(name || '')))
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => String(name || '').trim())
    .filter(Boolean);
  const discoveredArtLike = (Array.isArray(discoveredFlairs) ? discoveredFlairs : [])
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .filter(v => /\bart\b|fan[\s-]?art|illustration|drawing|sketch/i.test(v));
  const merged = dedupeQueryStrings([
    selected,
    ...artLikeByCount,
    ...discoveredArtLike
  ]).slice(0, 6);
  if (merged.length) return merged;
  return selected ? [selected] : [];
}

function filterQueriesForSelectedFlair(queries, selectedFlair) {
  const selected = String(selectedFlair || '').trim().toLowerCase();
  if (!selected) return dedupeQueryStrings(queries);
  const out = [];
  for (const rawQuery of (Array.isArray(queries) ? queries : [])) {
    const normalized = String(rawQuery || '').trim();
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    const isFlairQuery = /(^|\s)flair(_name)?:/.test(lower);
    if (!isFlairQuery) {
      out.push(normalized);
      continue;
    }
    const mentionsSelected = lower.includes(selected);
    const mentionsFanArtAlias = /fan\s*art|fanart/.test(lower);
    if (mentionsFanArtAlias && !mentionsSelected) continue;
    out.push(normalized);
  }
  return dedupeQueryStrings(out);
}

function tokenizeSeriesTerms(series) {
  const raw = String(series?.series_name || '').toLowerCase();
  const firstBook = String(series?.first_book_title || '').toLowerCase();
  const out = [];
  for (const token of raw.split(/[^a-z0-9]+/g)) {
    if (token.length >= 3) out.push(token);
  }
  for (const token of firstBook.split(/[^a-z0-9]+/g)) {
    if (token.length >= 3) out.push(token);
  }
  const collapsed = raw.replace(/[^a-z0-9]/g, '');
  if (collapsed.length >= 4) out.push(collapsed);
  return Array.from(new Set(out));
}

function isSeriesSpecificSubreddit(subreddit, signals) {
  const normalized = String(subreddit || '').toLowerCase();
  if (!normalized) return false;
  const tokens = signals?.tokens || [];
  const aliases = signals?.aliases || [];
  for (const token of tokens) {
    if (normalized.includes(token)) return true;
  }
  for (const alias of aliases) {
    if (normalized === alias || normalized.includes(alias)) return true;
  }
  return false;
}

function buildSubredditSignals(series) {
  const tokens = tokenizeSeriesTerms(series);
  const aliases = buildKnownFranchiseAliases(series)
    .map(v => String(v || '').toLowerCase().replace(/[^a-z0-9_]/g, ''))
    .filter(Boolean);
  return { tokens, aliases };
}

function buildKnownFranchiseAliases(series) {
  const seriesName = String(series?.series_name || '').toLowerCase();
  const firstBookTitle = String(series?.first_book_title || '').toLowerCase();
  const aliases = new Set();
  if (/song\s+of\s+ice\s+and\s+fire|a\s+song\s+of\s+ice\s+and\s+fire|asoiaf|westeros/.test(seriesName)) {
    aliases.add('asoiaf');
    aliases.add('game of thrones');
    aliases.add('westeros');
    aliases.add('house of the dragon');
    aliases.add('gameofthrones');
    aliases.add('houseofthedragon');
    aliases.add('pureasoiaf');
    aliases.add('freefolk');
    aliases.add('naath');
    aliases.add('iceandfire');
  }
  if (/game\s+of\s+thrones/.test(firstBookTitle)) {
    aliases.add('game of thrones');
    aliases.add('gameofthrones');
  }
  return Array.from(aliases);
}

function computeRetryDelayMs(retryAfterHeader, attempt) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.max(300, Math.min(5000, Math.floor(retryAfterSeconds * 1000)));
  }
  return Math.max(300, Math.min(2500, attempt * 700));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, Number(ms) || 1)));
}

function isRedditAccessBlocked(errorMessage) {
  const raw = String(errorMessage || '').toLowerCase();
  if (!raw) return false;
  return raw.includes('http_403') || raw.includes(':403');
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

async function urlLooksLikeImage(url, source) {
  if (String(source || '') === 'artstation') {
    // ArtStation CDN image URLs often block HEAD/GET probes from servers
    // even when the URL is browser-renderable. Trust known image-like URLs.
    return isLikelyImageUrl(url);
  }
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
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return String(item?.source || '') === 'artstation';
  }
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

function computeArtStationPopularityScore(stats) {
  if (!stats) return 0;
  const likes = Number(stats.likes) || 0;
  const views = Number(stats.views) || 0;
  return (
    Math.log1p(likes) * 3.8 +
    Math.log1p(views) * 2.2
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
