# Bookshelf App - Current State

## What's built
- Goodreads + Audible import
- Visual bookshelf cover grid
- Series tier list with drag and drop
- Discover page with AI recommendations
- Deployed on Render

## Current issues
- [ ] how to handle adding covers not in open library
- [ ] how to handle duplicate books already added
- [ ] series are grouped incorrectly
- [ ] using js not typescript
- [ ] using inline styling not CSS files
- [ ] series to book fanout has awkward issues
- [ ] a lot of DB resets, want to persist cover urls so no need to refetch

## Key decisions
- series are ranked not individual books