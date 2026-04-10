const router = require('express').Router();
const fetch = require('node-fetch');
const { pool } = require('../db');

const DEVIANTART_CLIENT_ID = process.env.DEVIANTART_CLIENT_ID || null;
const DEVIANTART_CLIENT_SECRET = process.env.DEVIANTART_CLIENT_SECRET || null;
const DEVIANTART_TOKEN_URL = 'https://www.deviantart.com/oauth2/token';
const DEVIANTART_API_BASE = 'https://www.deviantart.com/api/v1/oauth2';

let tokenCache = { accessToken: null, expiresAtMs: 0 };

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
      const pieces = [b.title, b.series_name, b.author_name, 'fan art'];
      searchText = pieces.filter(Boolean).join(' ');
      searchQueries.push(searchText);
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
          ) AS first_book_title
        FROM series s
        LEFT JOIN authors a ON a.id = s.author_id
        WHERE s.id = $1
      `, [rawSeriesId]);
      if (!rows[0]) return res.status(404).json({ error: 'Series not found' });
      const s = rows[0];

      const seriesQuery = [s.series_name, s.author_name, 'fan art'].filter(Boolean).join(' ');
      searchQueries.push(seriesQuery);
      if (s.series_name) relevanceHints.push(s.series_name);

      if (s.first_book_title) {
        const bookOneQuery = [s.first_book_title, s.author_name, 'fan art'].filter(Boolean).join(' ');
        searchQueries.push(bookOneQuery);
        relevanceHints.push(s.first_book_title);
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
    for (const item of merged) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      const relevance = evaluateRelevance(item, relevanceProfiles, anchorPhrases);
      if (!relevance.pass) {
        relevanceRejected++;
        continue;
      }
      unique.push({ ...item, relevance_reason: relevance.reason });
      if (unique.length >= limit * 12) break;
    }
    debug.stage_counts.unique_links = seen.size;
    debug.stage_counts.relevance_kept = unique.length;
    debug.stage_counts.relevance_rejected = relevanceRejected;

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
        const score = popularityScore + qualityScore;
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
          score: Number(computeQualityScore(item).toFixed(3)),
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

async function searchDeviantArtRss(searchText, limit, { allowMature }) {
  const rssUrl = `https://backend.deviantart.com/rss.xml?q=${encodeURIComponent(searchText)}&type=deviation&mature_content=${allowMature ? 'true' : 'false'}&include_mature=${allowMature ? 'true' : 'false'}`;
  const feedRes = await fetch(rssUrl);
  if (!feedRes.ok) return [];
  const xml = await feedRes.text();
  return parseRssItems(xml)
    .filter(item => item.title && item.link && item.image_url)
    .slice(0, limit);
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
  if (!profiles.length) return { pass: true, reason: 'no_profiles' };
  const noisy = normalizeSearchText(`${item.title} ${item.description_text}`);
  if (/\b(pdf|script|movie\s+review|review)\b/i.test(noisy)) return { pass: false, reason: 'noise_term' };

  const hayTitleTags = normalizeSearchText([
    item.title,
    ...(item.tags || []),
    item.creator
  ].join(' '));
  const hayDescription = normalizeSearchText([
    item.description_text
  ].join(' '));
  const anchorTokens = tokenize((anchorPhrases || []).join(' '))
    .filter(token => token.length >= 4)
    .filter(token => !isNoiseToken(token));
  const anchorTokenHitCount = anchorTokens.reduce((acc, token) => acc + (hayTitleTags.includes(token) ? 1 : 0), 0);

  // First, prefer direct phrase anchoring against the intended series/book strings.
  for (const anchor of (anchorPhrases || [])) {
    const normalizedAnchor = normalizeSearchText(anchor);
    if (!normalizedAnchor) continue;
    if (hayTitleTags.includes(normalizedAnchor)) return { pass: true, reason: `anchor:${anchor}` };
  }

  // Guardrail: require at least some anchor signal in title/tags/creator.
  if (anchorTokenHitCount < 2) return { pass: false, reason: 'anchor_token_miss' };

  for (const profile of profiles) {
    const phrase = normalizeSearchText(profile.phrase || '');
    if (phrase && phrase.length >= 8 && hayTitleTags.includes(phrase)) {
      return { pass: true, reason: `phrase:${profile.phrase}` };
    }

    const matchesInTitleTags = profile.tokens.reduce((acc, token) => acc + (hayTitleTags.includes(token) ? 1 : 0), 0);
    if (matchesInTitleTags >= 2) return { pass: true, reason: `title_tokens:${matchesInTitleTags}` };
  }

  // Description text is noisy, so only allow it as secondary signal once anchors already matched.
  const descMatches = profiles.reduce((best, profile) => {
    const matches = profile.tokens.reduce((acc, token) => acc + (hayDescription.includes(token) ? 1 : 0), 0);
    return Math.max(best, matches);
  }, 0);
  if (descMatches >= 4) return { pass: true, reason: `desc_tokens:${descMatches}` };

  return { pass: false, reason: 'no_anchor_match' };
}

function tokenize(value) {
  return normalizeSearchText(value).split(' ').filter(Boolean);
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isNoiseToken(token) {
  return [
    'fan', 'art', 'series', 'book', 'books', 'review', 'movie', 'pdf',
    'the', 'and', 'with', 'from', 'for', 'this', 'that', 'one', 'last',
    'hosts', 'morning'
  ].includes(token);
}

function buildRelevanceProfile(query) {
  const tokens = tokenize(query)
    .filter(token => token.length >= 3)
    .filter(token => !isNoiseToken(token));
  const strongTokens = tokens.filter(token => token.length >= 5);
  const phrase = String(query || '').toLowerCase().replace(/\s+fan\s+art/g, '').trim();
  return { query, tokens, strongTokens, phrase };
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function stripFanArtSuffix(value) {
  return String(value || '').replace(/\s+fan\s+art\s*$/i, '').trim();
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
