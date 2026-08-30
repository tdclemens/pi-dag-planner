# URL Shortener

A layered web service: schema/storage → API routes → verification. Each layer depends on the one below.

## Prompt

```text
/dag-plan Build a short-URL web service in Node.js using Express and better-sqlite3 (no other deps).
- POST /shorten with JSON { "url": "..." } → 201 with { "code", "shortUrl" }; code is 6-char base62; 400 on invalid input
- GET /:code → 302 to the original URL and increments the hit counter; 404 on unknown code
- GET /stats/:code → 200 with { "code", "url", "hits", "createdAt" }; 404 on unknown code
- Schema in db/schema.sql, auto-applied at startup; database file shortener.db (delete it in tests)
- Server listens on port 4179 (configurable via PORT env); start with `node server.js`
- Tests: node:test in test/ against an ephemeral server instance using global fetch; `npm test` must pass
```
