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
- Fan art scoring pipeline now uses broad discovery + weighted ranking (quality + optional engagement + relevance)
- Deployed on Render

## Current issues
- [ ] Wheel of Time still needs better relevance precision (tail results can drift off-topic)
- [ ] continue tuning relevance weighting and hard-negative filtering (reduce false positives without starving results)
- [ ] improve creator extraction consistency from DeviantArt links/metadata
- [ ] add spoiler-aware fan art mode using read progress + next unread publication date
- [ ] using js not typescript
- [ ] using inline styling not CSS files
- [ ] reduce need for DB resets while iterating on imports/cover data
- [ ] design a fun gallery mode to re-experience my bookshelf
- [ ] improve fan art source quality/ranking signals and result variety

## Key decisions
- series are ranked not individual books
- fan art feature is series-level (not book-level)
- do not download/store fan art binaries; only store and render external links/pointers
- keep debug instrumentation visible and easy to copy while tuning fan art retrieval