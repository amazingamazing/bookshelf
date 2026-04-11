const router = require('express').Router();
const fetch = require('node-fetch');
const { pool } = require('../db');

const FALLBACK_CHAIN = [
  'google_books_isbn',
  'open_library_isbn',
  'librarything_isbn',
  'internet_archive'
];

router.get('/lookup', async (req, res) => {
  try {
    const { isbn, title, author, book_id: bookId } = req.query;
    const candidate = await lookupCoverWaterfall({ isbn, title, author });
    if (candidate?.cover_url && bookId) {
      await saveCoverCandidate({
        bookId: Number(bookId),
        isbn: candidate.isbn || normalizeIsbn(isbn),
        coverUrl: candidate.cover_url,
        source: candidate.source,
        metadata: candidate.metadata || null
      });
    }
    res.json(candidate || { cover_url: null, source: null, attempts: FALLBACK_CHAIN });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/fetch-missing', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.id, b.title, b.isbn, a.name as author
      FROM books b LEFT JOIN authors a ON b.author_id = a.id
      WHERE b.cover_url IS NULL LIMIT 50
    `);

    let updated = 0;
    const notFound = [];
    const fetchErrors = [];

    for (const book of rows) {
      try {
        const candidate = await lookupCoverWaterfall({
          isbn: book.isbn,
          title: book.title,
          author: book.author
        });

        if (candidate?.cover_url) {
          await pool.query('UPDATE books SET cover_url=$1 WHERE id=$2', [candidate.cover_url, book.id]);
          await saveCoverCandidate({
            bookId: book.id,
            isbn: candidate.isbn || normalizeIsbn(book.isbn),
            coverUrl: candidate.cover_url,
            source: candidate.source,
            metadata: candidate.metadata || null
          });
          updated++;
        } else {
          notFound.push({
            title: book.title,
            author: book.author || null,
            reason: 'No cover found via Google Books, Open Library, LibraryThing, or Internet Archive'
          });
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        fetchErrors.push({ title: book.title, error: e.message });
      }
    }

    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM books WHERE cover_url IS NULL');
    const remaining = parseInt(countRows[0].count);
    res.json({ updated, remaining, tried: rows.length, notFound, fetchErrors, chain: FALLBACK_CHAIN });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/editions', async (req, res) => {
  try {
    const { book_id: rawBookId, isbn: rawIsbn, title: rawTitle, author: rawAuthor, debug: rawDebug } = req.query;
    const bookId = rawBookId ? Number(rawBookId) : null;
    const includeDebug = rawDebug === '1' || rawDebug === 'true';
    const debugLog = [];
    const logDebug = (step, details = {}) => {
      if (!includeDebug) return;
      debugLog.push({
        ts: new Date().toISOString(),
        step,
        ...details
      });
    };

    let isbn = rawIsbn;
    let title = rawTitle;
    let author = rawAuthor;
    logDebug('request_received', {
      book_id: bookId || null,
      isbn: normalizeIsbn(isbn),
      title: title || null,
      author: author || null
    });

    if (bookId) {
      const { rows } = await pool.query(`
        SELECT b.title, b.isbn, a.name AS author_name
        FROM books b
        LEFT JOIN authors a ON a.id = b.author_id
        WHERE b.id = $1
      `, [bookId]);
      if (!rows[0]) return res.status(404).json({ error: 'Book not found' });
      if (!isbn) isbn = rows[0].isbn;
      if (!title) title = rows[0].title;
      if (!author) author = rows[0].author_name;
      logDebug('book_hydrated_from_db', {
        isbn: normalizeIsbn(isbn),
        title: title || null,
        author: author || null
      });
    }

    const workKey = await resolveOpenLibraryWork({ isbn, title, author, logDebug });
    logDebug('work_resolution_complete', { work_key: workKey || null });
    if (!workKey) {
      return res.json({
        work_key: null,
        editions: [],
        candidates_saved: 0,
        debug: includeDebug ? debugLog : undefined
      });
    }

    const editionsRaw = await fetchOpenLibraryEditions(workKey, 120, logDebug);
    const editions = editionsRaw
      .map(edition => normalizeEdition(edition))
      .filter(edition => edition && edition.cover_urls.length > 0);
    logDebug('editions_normalized', {
      raw_count: editionsRaw.length,
      with_cover_count: editions.length
    });

    let saved = 0;
    if (bookId) {
      for (const edition of editions) {
        for (const coverUrl of edition.cover_urls) {
          const isbnForEdition = edition.isbns[0] || null;
          await saveCoverCandidate({
            bookId,
            isbn: isbnForEdition,
            coverUrl,
            source: 'open_library_editions',
            metadata: {
              work_key: workKey,
              edition_key: edition.edition_key,
              title: edition.title,
              publish_date: edition.publish_date,
              all_isbns: edition.isbns
            }
          });
          saved++;
        }
      }
    }
    logDebug('candidates_saved', { count: saved });

    res.json({
      work_key: workKey,
      editions,
      candidates_saved: saved,
      debug: includeDebug ? debugLog : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/select', async (req, res) => {
  try {
    const { book_id: rawBookId, cover_url: coverUrl, isbn: rawIsbn, source = 'manual_select', metadata = null } = req.body || {};
    const bookId = Number(rawBookId);
    const isbn = normalizeIsbn(rawIsbn);

    if (!bookId || !coverUrl) {
      return res.status(400).json({ error: 'book_id and cover_url are required' });
    }

    await pool.query(
      'UPDATE books SET cover_url = $1, isbn = COALESCE($2, isbn) WHERE id = $3',
      [coverUrl, isbn, bookId]
    );

    await saveCoverCandidate({ bookId, isbn, coverUrl, source, metadata });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function lookupCoverWaterfall({ isbn, title, author }) {
  const normalizedIsbn = normalizeIsbn(isbn);
  const attempts = [];

  if (normalizedIsbn) {
    const google = await findGoogleBooksCoverByIsbn(normalizedIsbn);
    attempts.push('google_books_isbn');
    if (google?.cover_url) return { ...google, attempts };

    const openLib = await findOpenLibraryCoverByIsbn(normalizedIsbn);
    attempts.push('open_library_isbn');
    if (openLib?.cover_url) return { ...openLib, attempts };

    const libraryThing = await findLibraryThingCoverByIsbn(normalizedIsbn);
    attempts.push('librarything_isbn');
    if (libraryThing?.cover_url) return { ...libraryThing, attempts };
  }

  const archive = await findInternetArchiveCover({ isbn: normalizedIsbn, title, author });
  attempts.push('internet_archive');
  if (archive?.cover_url) return { ...archive, attempts };

  return { cover_url: null, source: null, attempts };
}

async function findGoogleBooksCoverByIsbn(isbn) {
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`);
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.items?.[0];
  const links = item?.volumeInfo?.imageLinks;
  const coverUrl = links?.extraLarge || links?.large || links?.medium || links?.small || links?.thumbnail || links?.smallThumbnail;
  if (!coverUrl) return null;
  return {
    cover_url: toHttps(coverUrl),
    isbn,
    source: 'google_books_isbn',
    metadata: { google_volume_id: item.id || null }
  };
}

async function findOpenLibraryCoverByIsbn(isbn) {
  const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`);
  if (!res.ok) return null;
  const data = await res.json();
  const bookData = data[`ISBN:${isbn}`];
  const coverUrl = bookData?.cover?.large || bookData?.cover?.medium || bookData?.cover?.small || null;
  if (!coverUrl) return null;
  return {
    cover_url: coverUrl,
    isbn,
    source: 'open_library_isbn',
    metadata: { openlibrary_key: bookData?.key || null }
  };
}

async function findLibraryThingCoverByIsbn(isbn) {
  const devKey = process.env.LIBRARYTHING_DEVKEY;
  if (!devKey) return null;
  const coverUrl = `https://covers.librarything.com/devkey/${encodeURIComponent(devKey)}/large/isbn/${encodeURIComponent(isbn)}`;
  const ok = await urlLooksLikeImage(coverUrl);
  if (!ok) return null;
  return {
    cover_url: coverUrl,
    isbn,
    source: 'librarything_isbn',
    metadata: null
  };
}

async function findInternetArchiveCover({ isbn, title, author }) {
  const candidates = [];
  if (isbn) {
    const byIsbn = await fetchArchiveIdentifiers(`isbn:${quoteQueryValue(isbn)}`);
    candidates.push(...byIsbn);
  }
  if (!candidates.length && title) {
    const cleanedTitle = stripSeriesSuffix(title);
    const query = author
      ? `title:(${quoteQueryValue(cleanedTitle)}) AND creator:(${quoteQueryValue(author)})`
      : `title:(${quoteQueryValue(cleanedTitle)})`;
    const byTitle = await fetchArchiveIdentifiers(query);
    candidates.push(...byTitle);
  }
  const identifier = candidates[0];
  if (!identifier) return null;
  return {
    cover_url: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    isbn: normalizeIsbn(isbn),
    source: 'internet_archive',
    metadata: { archive_identifier: identifier }
  };
}

async function fetchArchiveIdentifiers(query) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&rows=5&page=1&output=json`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.response?.docs || []).map(d => d.identifier).filter(Boolean);
}

async function resolveOpenLibraryWork({ isbn, title, author, logDebug = () => {} }) {
  const normalizedIsbn = normalizeIsbn(isbn);
  if (normalizedIsbn) {
    const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(normalizedIsbn)}&format=json&jscmd=data`);
    logDebug('isbn_lookup_attempted', {
      isbn: normalizedIsbn,
      status: res.status
    });
    if (res.ok) {
      const data = await res.json();
      const bookData = data[`ISBN:${normalizedIsbn}`];
      const workKey = bookData?.works?.[0]?.key;
      if (workKey) {
        logDebug('isbn_lookup_work_found', { work_key: workKey });
        return workKey;
      }
      logDebug('isbn_lookup_no_work', {
        has_book_data: Boolean(bookData),
        openlibrary_key: bookData?.key || null
      });
    }
  }

  if (!title) {
    logDebug('title_search_skipped', { reason: 'missing_title' });
    return null;
  }
  const q = author ? `${title} ${author}` : title;
  const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=10&fields=key,title,author_name`);
  logDebug('title_search_attempted', { query: q, status: res.status });
  if (!res.ok) return null;
  const data = await res.json();
  const authorLast = (author || '').toLowerCase().split(' ').filter(Boolean).slice(-1)[0];
  const docs = data.docs || [];
  logDebug('title_search_results', {
    docs_count: docs.length,
    top_hits: docs.slice(0, 5).map(doc => ({
      key: doc.key || null,
      title: doc.title || null,
      author_name: (doc.author_name || []).slice(0, 2)
    }))
  });
  const best = (data.docs || []).find(doc =>
    doc.key?.startsWith('/works/') &&
    (!authorLast || doc.author_name?.some(name => String(name).toLowerCase().includes(authorLast)))
  ) || (data.docs || []).find(doc => doc.key?.startsWith('/works/'));
  logDebug('title_search_selected_work', { work_key: best?.key || null });
  return best?.key || null;
}

async function fetchOpenLibraryEditions(workKey, maxRows, logDebug = () => {}) {
  const editions = [];
  let offset = 0;
  const pageSize = 50;

  while (editions.length < maxRows) {
    const res = await fetch(`https://openlibrary.org${workKey}/editions.json?limit=${pageSize}&offset=${offset}`);
    logDebug('editions_page_requested', { offset, status: res.status });
    if (!res.ok) break;
    const data = await res.json();
    const pageEntries = data.entries || [];
    editions.push(...pageEntries);
    logDebug('editions_page_received', {
      offset,
      page_count: pageEntries.length,
      running_total: editions.length
    });
    if (!pageEntries.length || pageEntries.length < pageSize) break;
    offset += pageSize;
  }

  return editions.slice(0, maxRows);
}

function normalizeEdition(edition) {
  const isbns = Array.from(new Set([
    ...(edition.isbn_13 || []),
    ...(edition.isbn_10 || [])
  ].map(normalizeIsbn).filter(Boolean)));
  const coverUrls = Array.from(new Set((edition.covers || []).map(coverId => (
    `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
  ))));
  if (!coverUrls.length) return null;
  return {
    edition_key: edition.key || null,
    title: edition.title || null,
    publish_date: edition.publish_date || null,
    isbns,
    cover_urls: coverUrls
  };
}

async function saveCoverCandidate({ bookId, isbn, coverUrl, source, metadata }) {
  if (!bookId || !coverUrl || !source) return;
  await pool.query(`
    INSERT INTO book_cover_candidates (book_id, isbn, cover_url, source, metadata)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (book_id, source, cover_url)
    DO UPDATE SET
      isbn = COALESCE(EXCLUDED.isbn, book_cover_candidates.isbn),
      metadata = COALESCE(EXCLUDED.metadata, book_cover_candidates.metadata)
  `, [bookId, normalizeIsbn(isbn), coverUrl, source, metadata ? JSON.stringify(metadata) : null]);
}

function normalizeIsbn(value) {
  if (!value) return null;
  const clean = String(value).toUpperCase().replace(/[^0-9X]/g, '');
  return clean || null;
}

function stripSeriesSuffix(title) {
  return String(title || '').replace(/\s*\([^)]*#[\d.]+[^)]*\)/g, '').trim();
}

function quoteQueryValue(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function toHttps(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://');
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

module.exports = router;
