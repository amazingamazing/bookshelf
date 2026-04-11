# Bookshelf App - Current State

## What's built
- Goodreads + Audible import
- Visual bookshelf cover grid
- Book detail pages with series backlink
- Series tier list with drag and drop
- Discover page with AI recommendations
- Multi-source cover waterfall (Google Books -> Open Library -> LibraryThing -> Internet Archive)
- Edition browser (Open Library works/editions) with selectable alternate covers
- Fan art on series pages (DeviantArt RSS + optional API metadata ranking)
- Fan art controls: mature toggle, quality floor, sort mode, time window, AI exclusion, artist diversity cap
- Fan art debug tools (stage counts + copy debug payload button)
- Fan art scoring pipeline now uses broad discovery + weighted ranking (quality + optional engagement + relevance), with stricter relevance gating to reduce weak token collisions
- Shelf Cinema ambient mode (fullscreen API support, weighted tier rotation, attribution-aware fan art display, overlay auto-hide, click/ESC exit)
- Shelf Cinema now supports three viewing modes: Cinema (Ken Burns + cross-fade), Gallery (framed wall drift), Mosaic (living cover wall)
- Shelf Cinema control panel page with persisted settings (view mode, image count, image duration, series whitelist/blacklist, genre whitelist/blacklist)
- Cinema image aggregator endpoint: GET /api/cinema/series-images/:seriesId (series covers + edition/alternate covers + fan art + low-count supplemental sources + configurable image_limit)
- Cinema sequencing now intentionally mixes media as cover -> 1-3 fan art when available (falls back to covers-only if fan art is unavailable)
- Tier list hides series with zero associated books; series view hides rating when a series has no books
- Deployed on Render

## Current issues
- [ ] Relevance tuning is intentionally paused for now (good enough for current milestone / first-step feature)
- [ ] Validate latest stricter relevance update on Render once deploy finishes (Wheel of Time + ASOIAF spot checks)
- [ ] Later direction: add character-driven search seeds (popular character names per series) to improve precision/recall
- [ ] Validate Shelf Cinema behavior on Render across all view modes (Cinema/Gallery/Mosaic), including fullscreen entry reliability by browser
- [ ] Tune Shelf Cinema mode ergonomics (especially Mosaic density/speed and Gallery framing on different screen sizes)
- [ ] Tune fan art-to-cover blend ratio and add optional user-facing "fan art intensity" control
- [ ] improve creator extraction consistency from DeviantArt links/metadata
- [ ] add spoiler-aware fan art mode using read progress + next unread publication date
- [ ] using js not typescript
- [ ] using inline styling not CSS files
- [ ] reduce need for DB resets while iterating on imports/cover data
- [ ] improve fan art source quality/ranking signals and result variety

## Key decisions
- series are ranked not individual books
- fan art feature is series-level (not book-level)
- do not download/store fan art binaries; only store and render external links/pointers
- keep debug instrumentation visible and easy to copy while tuning fan art retrieval
- prioritize shipping the next feature milestone over deeper relevance iteration right now
- Shelf Cinema settings are local-first (persisted in localStorage) and control eligibility + playback without storing image binaries

## Product direction
- Exploring commercial release as a paid app (one-time purchase or low-cost subscription)
- Core differentiator: "Plex for books" — beautiful ambient display of personal reading history
- Target hardware: iPad or TV in kiosk/ambient mode (similar to Samsung Frame TV aesthetic)
- Ambient display is the flagship feature that doesn't exist elsewhere as a polished product

## Data and legal decisions
- Book covers: use official APIs with licensing agreements (Google Books, Open Library, ISBNdb)
- Fan art model: search-engine/inline-linking approach (display from source URL, never store binaries)
- Always show artist name + clickable link back to original when displaying fan art
- Safe to store in DB: ISBNs, URLs/pointers, metadata, artist names, attribution links
- Safe to cache on device: thumbnails, recently viewed (treated as browser cache)
- Never store: image files, full-res covers or fan art on server
- Building curated ISBN-to-editions mapping over time (ISBNs are just numbers, safe to own)
- Fan art sources: DeviantArt API (primary, official, attribution-ready), Bing Image Search (fallback)
- Commercial fan art use requires rethinking — current inline-linking model is most defensible

## Cover art sources (waterfall order)
1. Google Books API (by ISBN) — fast, free, good quality
2. Open Library (by ISBN) — current primary source
3. LibraryThing covers API — good for edition variants
4. Internet Archive — last resort for obscure titles
- Open Library Works API used for edition browsing (groups all ISBNs for a work)
- ISBNdb (~$15/mo) identified as best commercial-grade source if app goes paid

## Planned features (priority order)
1. Shelf Cinema polish — blurred backdrop technique, slower transitions (45-60s), minimum image resolution filter, subtle darkening/desaturation for cohesion
2. Non-fiction / no-fan-art content strategy:
   - Self-help/business: quote cards (sources: Goodreads Quotes, Quotable.io, Wikiquote API)
   - Biography/memoir: subject photography (Wikipedia API, Wikimedia Commons, Getty embed)
   - Travel/lifestyle: location photography (Unsplash API — free, commercially licensed)
   - Science/history: Smithsonian Open Access API, NASA Image API, NYPL Digital Collections
   - Content type detector: picks strategy automatically based on genre tags
3. Tagging system — flexible tags not fixed genres
   - Split when each modifier is meaningful alone (Fantasy + Epic = two tags)
   - Keep combined when neither stands alone (Action & Adventure = one tag, Sword & Sorcery = one tag)
4. Read-next queue
5. Series completion tracking improvements
6. New release tracker improvements (character-driven search seeds for fan art)

## Shelf Cinema visual references (best-in-class)
- Samsung Frame TV Art Mode: hold images 30-90s, near-invisible Ken Burns (1.0→1.05 scale), no text during viewing
- Apple TV Aerial: purposeful movement, 60-90s per clip, cinematic pacing
- Google Chromecast Ambient: minimal text overlay, fades in/out, clean
- Key technique: blurred backdrop (same image blurred+darkened full-screen behind crisp foreground) — biggest single quality improvement possible, used by Plex/Spotify/Apple Music
- Ken Burns correct range: scale 1.0 to 1.05-1.08 max, 15-20s duration — movement felt not seen
- Common quality problems to fix: transitions too fast, Ken Burns too aggressive, inconsistent image resolution, no color treatment, pure black background (#0a0806 preferred), text overlay too prominent

## Shelf Cinema view modes
- Cinema: Ken Burns + crossfade (default, best for TV/large display)
- Gallery: framed art on wall, slow horizontal drift (cozy, best for tablet on shelf)
- Mosaic: living cover wall, slowly shifting (best for showing library breadth)
- Future: Parallax layers (modern, used in Apple iOS wallpapers)

## Tagging / genre decisions
- Action & Adventure: keep combined (neither word useful alone as a book genre tag)
- Sword & Sorcery: keep combined (same reasoning)
- Fantasy, Epic, Urban: split (each meaningful independently)
- Thriller, Mystery, Suspense: split (distinct reader expectations)
- Romance, Paranormal: split (a book can be paranormal without being romantic)
- Science Fiction, Space Opera, Hard Sci-Fi: split
- Rule: if a tag is useful to a reader in isolation, it stands alone

## Tooling decisions
- Editor: Cursor Pro ($20/mo) — chosen over Windsurf/VS Code+Copilot
- AI subscription: Claude Pro ($20/mo) for chat/research
- .cursorrules file in project root for project-specific AI behavior
- CLAUDE.md (this file) for persistent state across sessions
- No need for Cowork, agents, or Cursor skills yet — current bottleneck is clarity not tooling
- Workflow: research/plan in Claude chat → generate Cursor prompt → build in Cursor → review diff
- Sketch → upload to Claude → translated to Cursor prompt is a valid design workflow

## Data sources investigated
- Bowker Book Data (proquest): official US ISBN agency, 50M+ records including audiobooks, series data, readalikes — enterprise pricing, worth revisiting if app goes commercial
- DeviantArt: registered app, have client_id, using RSS + optional API metadata
- Goodreads Quotes / Quotable.io / Wikiquote: planned for quote cards
- Unsplash API: free, commercially licensed, for travel/lifestyle/food imagery
- NASA Image API: free, for science/space books
- Smithsonian Open Access API: millions of historical images, free commercial use