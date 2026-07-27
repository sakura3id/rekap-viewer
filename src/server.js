const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: envFile });
const express = require('express');
const path = require('path');
const { uploadCache, readCache } = require('./storage');
const { requireAuth, requireApprovedResident } = require('./middleware/auth');
const { extractSessionFromCookieHeader, globalLogout, fetchIsCommittee, fetchUserProfile, fetchUserRoles } = require('./auth');
const analytics = require('./lib/analytics');

const app = express();
app.set('trust proxy', true); // Ensure req.protocol correctly reflects HTTPS behind Fly.io proxy

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Configuration from environment variables
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const RANGE = process.env.RANGE || 'Import!A1:ZZ550';
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Middleware for logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        const region = process.env.FLY_REGION || 'local';
        console.log(`[${region}] ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
    });
    next();
});

// Health check (Public)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString(), region: process.env.FLY_REGION });
});

// Auth Denied Page (Public)
app.get('/auth-denied', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'public', 'auth-denied.html'));
});

// Protected main entry point
app.get('/', requireAuth, requireApprovedResident, (req, res) => {
    res.set('Cache-Control', 'no-store'); // Do not cache authenticated views
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// User profile endpoint
app.get('/api/me', requireAuth, requireApprovedResident, async (req, res) => {
    const user = req.user;
    const profile = await fetchUserProfile(req.accessToken, user.id);
    const roles = await fetchUserRoles(req.accessToken, user.id);
    res.json({
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || user.email.split('@')[0],
        avatar_url: user.user_metadata?.avatar_url || null,
        profile: profile ? {
            participant_type: profile.participant_type,
            resident_subtype: profile.resident_subtype,
            requested_affiliation: profile.requested_affiliation
        } : null,
        roles: roles
    });
});

app.post('/api/analytics', express.json(), requireAuth, requireApprovedResident, async (req, res) => {
    const { eventName, properties } = req.body || {};
    if (eventName) {
        analytics.track(req.accessToken, req.user.id, eventName, properties).catch(err => {
            console.error('[server] Analytics track error:', err.message || err);
        });
    }
    res.status(204).end();
});

app.post('/api/logout', async (req, res) => {
    const cookieHeader = req.headers.cookie;
    const session = extractSessionFromCookieHeader(cookieHeader);

    if (session && session.access_token) {
        await globalLogout(session.access_token);
    }

    const hostname = req.hostname;
    const domain = hostname.endsWith('.localtest.me') ? '.localtest.me' :
        hostname.endsWith('.sr3.my.id') ? '.sr3.my.id' :
        hostname.endsWith('.sakura3.id') ? '.sakura3.id' : hostname;

    res.clearCookie('sakura3-auth', { domain: domain, path: '/' });
    res.json({ success: true });
});

// Static assets (CSS, JS, etc. - Cacheable, no sensitive data)
app.use(express.static(path.join(__dirname, '..', 'public')));


/**
 * Fetch and process data from Google Sheets
 */
async function fetchGoogleSheetsData() {
    if (!GOOGLE_API_KEY || !SHEET_ID) {
        throw new Error('Missing GOOGLE_API_KEY or SHEET_ID');
    }

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING&key=${GOOGLE_API_KEY}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout for refresh

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData?.error?.message || `Google API returned ${response.status}`);
        }

        const data = await response.json();
        return data;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Refresh the cache in Tigris
 */
async function refreshCache() {
    const region = process.env.FLY_REGION || 'local';
    console.log(`[${region}] Cache refresh started...`);
    const start = Date.now();

    try {
        const data = await fetchGoogleSheetsData();
        const cacheObject = {
            updatedAt: new Date().toISOString(),
            region: region,
            data: data
        };

        await uploadCache(cacheObject);
        const duration = Date.now() - start;
        console.log(`[${region}] Cache refresh success - ${duration}ms`);
        return true;
    } catch (error) {
        console.error(`[${region}] Cache refresh failed:`, error.message);
        return false;
    }
}

// API endpoint serving from cache
app.get('/api/rekap', requireAuth, requireApprovedResident, async (req, res) => {
    try {
        const cache = await readCache();

        if (!cache) {
            console.error('Cache not found in storage');
            return res.status(404).json({ error: 'Data not available yet. Please try again in a few minutes.' });
        }

        const updatedAt = new Date(cache.updatedAt);
        const ageSeconds = Math.floor((Date.now() - updatedAt.getTime()) / 1000);

        // Add headers
        res.setHeader('X-Fly-Region', cache.region || 'unknown');
        res.setHeader('X-Cache-Updated-At', cache.updatedAt);
        res.setHeader('X-Cache-Age', ageSeconds);

        const sheetData = cache.data;
        const isCommittee = await fetchIsCommittee(req.accessToken, req.user.id);

        if (isCommittee) {
            return res.json(sheetData);
        }

        // For regular residents, dynamically splice the "Nama" column from a shallow-cloned array
        if (sheetData.values && Array.isArray(sheetData.values) && sheetData.values.length > 0) {
            const headerRow = sheetData.values[0];
            const namaIdx = headerRow.findIndex(cell => typeof cell === 'string' && cell.trim() === 'Nama');

            if (namaIdx !== -1) {
                const sanitizedValues = sheetData.values.map(row => {
                    if (row.length > namaIdx) {
                        const newRow = [...row];
                        newRow.splice(namaIdx, 1); // Strip "Nama" column for regular resident privacy
                        return newRow;
                    }
                    return row;
                });
                return res.json({
                    ...sheetData,
                    values: sanitizedValues
                });
            }
        }

        res.json(sheetData);
    } catch (error) {
        console.error('API Error:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Start background refresh
setInterval(refreshCache, REFRESH_INTERVAL);

app.listen(PORT, HOST, async () => {
    console.log(`--------------------------------------------------`);
    console.log(`Rekap Viewer Backend (Cached) is running!`);
    console.log(`Region: ${process.env.FLY_REGION || 'local'}`);
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`--------------------------------------------------`);

    // Initial refresh on startup
    console.log('Performing initial cache refresh...');
    await refreshCache();
});
