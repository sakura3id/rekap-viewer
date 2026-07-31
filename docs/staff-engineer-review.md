# Staff Engineer Code Review: rekap-viewer

**Reviewer:** Staff Engineer  
**Date:** July 2026  
**Verdict:** Significant rework needed before this can scale beyond a single-tenant hobby project.

---

## Executive Summary

This is a small Express app that proxies Google Sheets data behind Supabase auth. It works — today, for a handful of users. But it accumulates the kind of shortcuts that turn into 3 AM incidents once you have real traffic, real adversaries, or a second developer trying to make changes.

The core issues fall into five buckets:

1. **Security time-bombs** — A single env var typo disables all authentication.
2. **Zero automated testing** — Not a single test. Shipping blind.
3. **Architectural coupling** — Business logic, routing, caching, and auth are knotted together in monolithic files.
4. **Operational fragility** — No health-beyond-200, no graceful shutdown, no structured logging, no alerting.
5. **Performance landmines** — Unbounded in-memory caches, a new Supabase client created per-request, and 1100 lines of DOM manipulation that will choke on larger datasets.

---

## Critical Issues (Must Fix)

### 1. `DEV_BYPASS_AUTH` Is a Production Kill Switch

**File:** `src/middleware/auth.js:10`

```javascript
const DEV_BYPASS_AUTH = process.env.DEV_BYPASS_AUTH === 'true';
```

If anyone sets `DEV_BYPASS_AUTH=true` in production secrets (a single `fly secrets set` typo), **all authentication is globally disabled**. This is evaluated once at module load — there is no runtime guard, no alarm, no log.

**Fix:**

```javascript
// Fail hard if someone tries to use bypass in production
const DEV_BYPASS_AUTH = process.env.DEV_BYPASS_AUTH === 'true';
if (DEV_BYPASS_AUTH && process.env.NODE_ENV === 'production') {
  console.error('FATAL: DEV_BYPASS_AUTH is enabled in production. Refusing to start.');
  process.exit(1);
}
```

Better yet, remove the bypass entirely and use a local test user via a proper auth emulator.

---

### 2. Cookie Parsing Is Fragile and Exploitable

**File:** `src/auth.js:83`

```javascript
const cookieValue = authCookie.split('=')[1];
```

This takes only the part after the *first* `=`. If the URL-encoded JSON contains unescaped `=` (base64 characters in tokens when improperly encoded), parsing silently fails — or worse, truncates the value and passes partial JSON downstream.

**Fix:** Split on the first `=` only, taking everything after it:

```javascript
const eqIndex = authCookie.indexOf('=');
if (eqIndex === -1) return null;
const cookieValue = authCookie.substring(eqIndex + 1);
```

Or just use the `cookie` package (you already have `cookie-parser` in package.json but don't use it).

---

### 3. Unbounded In-Memory Caches = Memory Leak

**File:** `src/auth.js`

Six `Map()` caches with no size limit. The cleanup timer runs every 10 minutes, but between cleanups, a burst of unique users can grow these maps unboundedly. On a 1 GB VM, this is dangerous.

Each cache entry stores full Supabase user objects (~2–5 KB). At scale:
- 10,000 unique users × 6 caches × 3 KB = ~180 MB of stale data between cleanup cycles.

**Fix:**

```javascript
// Use an LRU cache with a hard cap
const { LRUCache } = require('lru-cache');

const jwtCache = new LRUCache({ max: 500, ttl: 45_000 });
const approvalCache = new LRUCache({ max: 500, ttl: 45_000 });
// ... etc
```

This gives you both TTL *and* size eviction, eliminating the memory leak vector.

---

### 4. New Supabase Client Created Per Request

**File:** `src/auth.js:152`, `src/lib/analytics.js:8`

```javascript
function getSupabaseUserClient(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { ... });
}
```

Every call to `fetchIsCommittee`, `fetchUserProfile`, `fetchUserRoles`, `checkNamespacedPermission`, and `analytics.track` creates a brand-new Supabase client. This allocates a WebSocket transport object (you pass `realtime: { transport: require('ws') }`) for each invocation — even though realtime is never used.

On the `/api/rekap` endpoint, a single request can trigger up to 3 client instantiations.

**Fix:**
- Remove `realtime: { transport: require('ws') }` — you don't subscribe to any channels.
- Use a single admin client for service-key operations.
- For user-scoped RPC calls, set the header on the request, not the client:

```javascript
const serviceClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { enabled: false }
});

async function callRpcAsUser(accessToken, rpcName, params) {
  const { data, error } = await serviceClient.rpc(rpcName, params, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return { data, error };
}
```

---

### 5. No CSRF Protection on State-Mutating Endpoints

**Files:** `POST /api/logout`, `POST /api/analytics`

Both endpoints accept POST requests authenticated only by cookie. A malicious page can POST to these endpoints from any origin since there's no CSRF token, no `SameSite` enforcement (cookie is set by a different app), and no `Origin`/`Referer` header validation.

While the blast radius is limited (logout is annoying, analytics is noise), this pattern is a liability as you add more POST endpoints.

**Fix:**

```javascript
// Validate Origin header on state-changing requests
function csrfGuard(req, res, next) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.get('Origin') || req.get('Referer');
    const allowed = ['https://rekap.sr3.my.id', 'https://rekap.sakura3.id', 'http://rekap.localtest.me:3000'];
    if (!origin || !allowed.some(o => origin.startsWith(o))) {
      return res.status(403).json({ error: 'CSRF validation failed' });
    }
  }
  next();
}
app.use(csrfGuard);
```

---

### 6. No Graceful Shutdown

**File:** `src/server.js`

The server does `setInterval(refreshCache, ...)` and `app.listen(...)` with no shutdown handler. When Fly.io sends `SIGTERM` (during deploys), in-flight requests are dropped and the cache refresh may be mid-write to Tigris.

**Fix:**

```javascript
const server = app.listen(PORT, HOST, async () => { /* ... */ });

const shutdown = async (signal) => {
  console.log(`[${signal}] Graceful shutdown initiated...`);
  clearInterval(refreshInterval);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  // Force exit if graceful close stalls
  setTimeout(() => process.exit(1), 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

---

## High Severity (Should Fix Soon)

### 7. Zero Automated Tests

**File:** `package.json`

```json
"test": "echo \"Error: no test specified\" && exit 1"
```

You have non-trivial auth logic, data filtering, cookie parsing, and cache tiering — all untested. The `Nama` column stripping logic alone has edge cases (what if the header is "Nama " with trailing whitespace? What if there are multiple columns matching?).

**Fix:** At minimum, add unit tests for:
- `extractSessionFromCookieHeader` — various malformed inputs
- `buildPortalRedirectUrl` — open redirect prevention
- Column stripping logic in `/api/rekap`
- Cache fallback behavior in `readCache()`

Recommended stack: `vitest` (fast, zero-config, ESM-ready).

---

### 8. Hardcoded Domain Logic Scattered Everywhere

**Files:** `src/auth.js`, `src/middleware/auth.js`, `src/server.js`, `public/app.js`

The portal URL resolution logic is duplicated in **four places** with slightly different implementations:

| Location | Domains Checked |
|----------|----------------|
| `src/auth.js:buildPortalRedirectUrl` | `.sr3.my.id`, `.sakura3.id`, `.localtest.me` |
| `src/middleware/auth.js:handleAuthFailure` | `.sr3.my.id`, `.sakura3.id`, `.localtest.me` |
| `src/server.js:logout` | `.localtest.me`, `.sr3.my.id`, `.sakura3.id` |
| `public/app.js:fetchUser` | `.localtest.me`, `.lvh.me`, `.sr3.my.id`, `.sakura3.id` |
| `public/app.js:signout` | `.localtest.me`, `.lvh.me`, `.sr3.my.id`, `.sakura3.id` |

Notice the frontend knows about `.lvh.me` but the backend doesn't. This will cause subtle auth failures.

**Fix:** Centralize into a single `resolvePortalUrl(hostname)` utility shared across server files. For the frontend, inject the portal URL from the server (e.g., in a `<meta>` tag or from `/api/me` response).

---

### 9. The `/api/rekap` Endpoint Does Too Much

**File:** `src/server.js:140–185`

A single route handler:
1. Reads from cache
2. Sets custom headers
3. Checks committee status (another Supabase RPC call)
4. Conditionally transforms data (column stripping)
5. Handles error responses

This is 45 lines of interleaved I/O, authorization, and data transformation. It's untestable without spinning up a full Express server + mock Supabase.

**Fix:** Extract a pure function for data transformation:

```javascript
// Pure, testable, no I/O
function stripNameColumn(sheetData) {
  if (!sheetData?.values?.length) return sheetData;
  const headerRow = sheetData.values[0];
  const namaIdx = headerRow.findIndex(cell => String(cell).trim() === 'Nama');
  if (namaIdx === -1) return sheetData;

  return {
    ...sheetData,
    values: sheetData.values.map(row =>
      row.length > namaIdx ? [...row.slice(0, namaIdx), ...row.slice(namaIdx + 1)] : row
    )
  };
}
```

---

### 10. `cookie-parser` Is a Dead Dependency

**File:** `package.json`

```json
"cookie-parser": "^1.4.7"
```

This package is installed but **never used** — cookies are parsed manually in `extractSessionFromCookieHeader`. Dead dependencies increase attack surface (supply chain risk) and confuse new developers.

**Fix:** Remove it:
```bash
npm uninstall cookie-parser
```

---

### 11. Frontend Is a 1100-line Single File

**File:** `public/app.js`

A single file contains:
- Analytics wrapper
- Config
- DOM refs
- Sticky column logic
- Column visibility
- Collapse/expand state machine
- Filter logic (4 different filter types)
- Pill-based search with autocomplete
- Chip builders
- Table rendering
- Data fetching
- User profile display
- Dropdown/logout
- Build info fetching

This is approaching the point where any change risks breaking unrelated features. No bundler, no modules, no types.

**Fix (incremental):**
1. Use ES modules with `<script type="module">` (no build step needed).
2. Split into logical modules: `filter.js`, `render.js`, `auth-ui.js`, `analytics.js`.
3. Consider a lightweight reactive layer for filter state (even a simple pub/sub pattern) instead of manually wiring DOM events.

---

### 12. Google Sheets API Key Exposed in Server-Side URL

**File:** `src/server.js:106`

```javascript
const url = `...&key=${GOOGLE_API_KEY}`;
```

The API key is passed as a query parameter. If this URL is ever logged (e.g., if you add request-level logging, or if an error includes the URL), the key leaks into logs. More critically, Google Sheets API keys can be restricted by HTTP referrer — but since this is server-side, anyone who obtains the key can use it from anywhere.

**Fix:**
- Restrict the key to the Sheets API only + your server's IP in Google Cloud Console.
- Avoid logging the full URL. Use a URL builder that masks secrets:

```javascript
console.log(`Fetching sheet ${SHEET_ID}, range ${RANGE}...`); // Not the full URL
```

---

## Medium Severity

### 13. `setInterval` Without Reference = Uncontrollable Refresh

```javascript
setInterval(refreshCache, REFRESH_INTERVAL);
```

The interval has no variable reference, so it can never be cancelled for graceful shutdown or testing.

**Fix:**
```javascript
const refreshInterval = setInterval(refreshCache, REFRESH_INTERVAL);
```

---

### 14. No Request Body Size Limit

**File:** `src/server.js:75`

```javascript
app.post('/api/analytics', express.json(), ...)
```

`express.json()` defaults to a 100 KB body limit, which is reasonable. But it's applied inline only to this one route. If you add more POST routes, you'll forget this. Apply it globally with an explicit limit:

```javascript
app.use(express.json({ limit: '16kb' })); // Apply once, strict limit
```

---

### 15. Health Check Is Too Shallow

**File:** `src/server.js:42`

```javascript
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString(), region: process.env.FLY_REGION });
});
```

This always returns 200. It doesn't check:
- Whether the cache is populated (cold start scenario)
- Whether S3/Tigris is reachable
- Whether Supabase auth is functional

Fly.io will happily route traffic to a machine that has no cached data and can't authenticate anyone.

**Fix:**

```javascript
app.get('/health', async (req, res) => {
  const cache = await readCache().catch(() => null);
  const cacheOk = cache !== null;
  const cacheAge = cache ? Math.floor((Date.now() - new Date(cache.updatedAt).getTime()) / 1000) : null;
  const healthy = cacheOk && cacheAge < 600; // Unhealthy if cache is >10 min stale

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'OK' : 'DEGRADED',
    cache: { populated: cacheOk, ageSeconds: cacheAge },
    region: process.env.FLY_REGION,
    timestamp: new Date().toISOString()
  });
});
```

---

### 16. No Structured Logging

**File:** `src/server.js:31`

```javascript
console.log(`[${region}] ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
```

This is fine for a solo developer tailing `fly logs`. It becomes useless once you want to:
- Alert on error rates
- Correlate requests with auth failures
- Search by userId or statusCode
- Feed into any observability platform

**Fix:** Use JSON structured logging:

```javascript
const log = (level, message, meta = {}) => {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), region: process.env.FLY_REGION, ...meta }));
};
```

Or adopt `pino` (fast, structured, integrates with Fly log drains).

---

### 17. Dockerfile Copies Entire Build Context Into Final Image

**File:** `Dockerfile:40`

```dockerfile
COPY --from=build /app /app
```

This copies **everything** from the build stage — including `node_modules` with native build tooling (`build-essential`, `python-is-python3`), test fixtures, documentation, benchmark logs, and the `.git` directory.

**Fix:** Be explicit about what goes into the final image:

```dockerfile
FROM base
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/src /app/src
COPY --from=build /app/public /app/public
COPY --from=build /app/scripts /app/scripts
COPY --from=build /app/package.json /app/package.json
```

Or add a proper `.dockerignore` that excludes `docs/`, `helpers/`, `.git/`.

---

### 18. `global.WebSocket = require('ws')` Pollutes Global Scope

**File:** `src/auth.js:2`

```javascript
global.WebSocket = require('ws');
```

This is a hack to make the Supabase client's Realtime transport work in Node.js — but you're not using Realtime anywhere. This global mutation can conflict with other libraries and makes it impossible to treeshake the WebSocket code.

**Fix:** Don't set this. Disable Realtime on the Supabase client:

```javascript
const supabase = createClient(url, key, {
  auth: { persistSession: false },
  realtime: { enabled: false }
});
```

Remove `ws` from dependencies entirely.

---

## Low Severity / Code Quality

### 19. Inconsistent Error Handling Patterns

- `fetchApprovalStatus` returns `null` on error (fail-open for non-approved users — safe)
- `fetchIsCommittee` returns `false` on error (fail-closed — safe)
- `checkNamespacedPermission` returns `false` on error (fail-closed — safe)
- `verifyJwt` returns `null` on error (fail-closed — safe)

The inconsistency isn't a bug today, but document the contract: **"Auth functions fail-closed by default. A failure to verify = denial."**

---

### 20. Frontend Avatar XSS Vector

**File:** `public/app.js` (line ~938 in fetchUser)

```javascript
document.getElementById("user-avatar-btn").innerHTML = `<img src="${user.avatar_url}" alt="Avatar" />`;
```

`user.avatar_url` comes from Supabase `user_metadata`. If a user can set their avatar URL to something like `" onerror="alert(1)`, this is an XSS vulnerability.

**Fix:** Use DOM APIs instead of innerHTML:

```javascript
const img = document.createElement('img');
img.src = user.avatar_url;
img.alt = 'Avatar';
document.getElementById("user-avatar-btn").replaceChildren(img);
```

---

### 21. Magic Numbers Everywhere

- `45 * 1000` — cache TTL
- `30 * 1000` — memory cache TTL  
- `10 * 60 * 1000` — cleanup interval
- `5 * 60 * 1000` — refresh interval
- `10000` — fetch timeout
- `640` — mobile breakpoint (in JS)

**Fix:** Extract into a `config.js`:

```javascript
module.exports = {
  AUTH_CACHE_TTL_MS: 45_000,
  MEMORY_CACHE_TTL_MS: 30_000,
  CACHE_CLEANUP_INTERVAL_MS: 600_000,
  SHEETS_REFRESH_INTERVAL_MS: 300_000,
  SHEETS_FETCH_TIMEOUT_MS: 10_000,
};
```

---

### 22. No Rate Limiting

Any authenticated user can hammer `/api/rekap` or `/api/me` with no throttling. The in-memory caches help, but a malicious user can bypass cache by timing requests to land after TTL expiry. The Supabase free tier has RPC rate limits that could be exhausted.

**Fix:** Add a lightweight rate limiter per-user:

```javascript
const rateLimit = require('express-rate-limit');
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60, keyGenerator: (req) => req.user?.id || req.ip }));
```

---

### 23. `min_machines_running = 0` + No Cache Warming = Cold Start Pain

**File:** `fly.toml`, `fly.production.toml`

When the machine scales to zero and a user hits the app:
1. Fly.io cold-starts the VM (~2–4 seconds)
2. Node.js boots and calls `refreshCache()`
3. `refreshCache()` fetches from Google Sheets (up to 10 seconds)
4. Meanwhile, any request to `/api/rekap` gets a 404: `"Data not available yet"`

So the first user after a cold period waits 2–14 seconds and may see an error.

**Fix:** Either:
- Set `min_machines_running = 1` (costs ~$2/month on Fly.io)
- Or serve stale Tigris data immediately on startup (skip waiting for Google Sheets refresh):

```javascript
// On startup, read existing cache from Tigris FIRST
const existingCache = await readCache();
if (existingCache) {
  console.log('Loaded existing cache from Tigris, age:', ...);
}
// THEN trigger background refresh
refreshCache(); // Don't await
```

---

## Summary Table

| # | Issue | Severity | Effort |
|---|-------|----------|--------|
| 1 | DEV_BYPASS_AUTH kill switch | Critical | 5 min |
| 2 | Cookie parsing bug | Critical | 10 min |
| 3 | Unbounded memory caches | Critical | 30 min |
| 4 | Supabase client per-request | Critical | 1 hr |
| 5 | No CSRF protection | Critical | 30 min |
| 6 | No graceful shutdown | Critical | 20 min |
| 7 | Zero automated tests | High | 1–2 days |
| 8 | Duplicated domain logic | High | 1 hr |
| 9 | `/api/rekap` does too much | High | 30 min |
| 10 | Dead dependency | High | 5 min |
| 11 | 1100-line frontend monolith | High | 1 day |
| 12 | API key in URL | High | 20 min |
| 13 | Uncontrollable interval | Medium | 1 min |
| 14 | No body size limit | Medium | 5 min |
| 15 | Shallow health check | Medium | 20 min |
| 16 | No structured logging | Medium | 1 hr |
| 17 | Bloated Docker image | Medium | 15 min |
| 18 | Global WebSocket pollution | Medium | 10 min |
| 19 | Inconsistent error patterns | Low | 30 min |
| 20 | Avatar XSS vector | Low | 5 min |
| 21 | Magic numbers | Low | 20 min |
| 22 | No rate limiting | Low | 30 min |
| 23 | Cold start UX | Low | 30 min |

---

## What's Actually Good

Credit where it's due:

- **Tiered caching design** (memory → Tigris → Google Sheets) is the right pattern.
- **Stale cache fallback** when S3 is down shows operational thinking.
- **Permission model** (approval + namespaced permission) is properly layered.
- **Server-side column stripping** for privacy is correct — never trust the client.
- **Origin allowlist** for redirect URLs prevents open redirect attacks.
- **No-store cache headers** on authenticated pages prevent proxy caching of private data.
- **Build info generation** with git metadata is a nice operational touch.
- **The CSS** is genuinely well-crafted — responsive, custom properties, accessible.

---

## Recommended Priority Order

1. Fix #1 (DEV_BYPASS_AUTH guard) — 5 minutes, prevents catastrophe.
2. Fix #6 (graceful shutdown) — 20 minutes, prevents data corruption on deploy.
3. Fix #2 (cookie parsing) — 10 minutes, prevents auth failures.
4. Fix #20 (XSS vector) — 5 minutes, client-side security.
5. Fix #3 + #4 (memory + client creation) — 1 hour, prevents OOM crashes.
6. Add tests (#7) — 1 day, enables everything else.
7. Everything else — in order of severity.

---

*"Working code is not the same as production-ready code. The gap between the two is where incidents live."*
