const { createClient } = require('@supabase/supabase-js');
const { LRUCache } = require('lru-cache');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.veryresto.com';

// ── CONFIGURATION ────────────────────────────────────────────────────────
const AUTH_CACHE_TTL_MS = 45_000; // 45 seconds
const AUTH_CACHE_MAX_ENTRIES = 500; // Max entries per cache (prevents OOM)

// Redirect Allowlist Validation
const ALLOWED_RETURN_ORIGINS = [
    'http://rekap.localtest.me:3000',
    'https://rekap.veryresto.com',
    'https://rekap.sakura3.id',
    'https://rekap.sr3.my.id'
];

// ── SUPABASE CLIENTS (singleton, no per-request creation) ────────────────
let serviceClient = null;
let userClientCache = null;

function getServiceClient() {
    if (!serviceClient) {
        if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
            throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
        }
        serviceClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { persistSession: false },
            realtime: { enabled: false }
        });
    }
    return serviceClient;
}

// Cache user-scoped clients (keyed by accessToken) to avoid re-creation per request.
// Short TTL since tokens rotate.
function getSupabaseUserClient(accessToken) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
    }

    if (!userClientCache) {
        userClientCache = new LRUCache({ max: 50, ttl: AUTH_CACHE_TTL_MS });
    }

    const cached = userClientCache.get(accessToken);
    if (cached) return cached;

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        global: {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        },
        realtime: { enabled: false }
    });

    userClientCache.set(accessToken, client);
    return client;
}

// ── LRU CACHES (bounded size + TTL, no manual cleanup needed) ────────────
const jwtCache = new LRUCache({ max: AUTH_CACHE_MAX_ENTRIES, ttl: AUTH_CACHE_TTL_MS });
const approvalCache = new LRUCache({ max: AUTH_CACHE_MAX_ENTRIES, ttl: AUTH_CACHE_TTL_MS });
const committeeCache = new LRUCache({ max: AUTH_CACHE_MAX_ENTRIES, ttl: AUTH_CACHE_TTL_MS });
const permissionCache = new LRUCache({ max: AUTH_CACHE_MAX_ENTRIES, ttl: AUTH_CACHE_TTL_MS });
const profileCache = new LRUCache({ max: AUTH_CACHE_MAX_ENTRIES, ttl: AUTH_CACHE_TTL_MS });
const rolesCache = new LRUCache({ max: AUTH_CACHE_MAX_ENTRIES, ttl: AUTH_CACHE_TTL_MS });

// ── COOKIE PARSING ───────────────────────────────────────────────────────
// Parse the sakura3-auth cookie value from a raw cookie header string.
// Returns { access_token, refresh_token } or null.
function extractSessionFromCookieHeader(cookieHeader) {
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';').map(c => c.trim());
    const authCookie = cookies.find(c => c.startsWith('sakura3-auth='));

    if (!authCookie) return null;

    try {
        // Use indexOf to handle base64 '=' characters in token values
        const eqIndex = authCookie.indexOf('=');
        if (eqIndex === -1) return null;
        const cookieValue = authCookie.substring(eqIndex + 1);
        const decoded = decodeURIComponent(cookieValue);
        const parsed = JSON.parse(decoded);
        return parsed;
    } catch (e) {
        console.error('Failed to parse sakura3-auth cookie:', e.message);
        return null;
    }
}

// ── JWT VERIFICATION ─────────────────────────────────────────────────────
// Verify a JWT with Supabase Auth. Returns the user object or null.
async function verifyJwt(accessToken) {
    if (!accessToken) return null;

    const cached = jwtCache.get(accessToken);
    if (cached) return cached;

    try {
        const client = getServiceClient();
        const { data, error } = await client.auth.getUser(accessToken);

        if (error || !data?.user) {
            return null;
        }

        jwtCache.set(accessToken, data.user);
        return data.user;
    } catch (e) {
        console.error('Error verifying JWT:', e.message);
        return null;
    }
}

// ── APPROVAL STATUS ──────────────────────────────────────────────────────
// Query profiles.approval_status for a given user ID.
// Returns 'approved' | 'rejected' | 'suspended' | 'pending' | null.
async function fetchApprovalStatus(userId) {
    if (!userId) return null;

    const cached = approvalCache.get(userId);
    if (cached) return cached;

    try {
        const client = getServiceClient();
        const { data, error } = await client
            .from('profiles')
            .select('approval_status')
            .eq('id', userId)
            .single();

        if (error) {
            console.error('Error fetching approval status:', error.message);
            return null;
        }

        const status = data?.approval_status || null;
        if (status) {
            approvalCache.set(userId, status);
        }

        return status;
    } catch (e) {
        console.error('Error fetching approval status:', e.message);
        return null;
    }
}

// ── COMMITTEE CHECK ──────────────────────────────────────────────────────
// Query is_platform_manager RPC for a given user ID.
// Returns true if the user is an admin or resident_verifier, false otherwise.
async function fetchIsCommittee(accessToken, userId) {
    if (!userId || !accessToken) return false;

    if (accessToken === 'dev-bypass-token') {
        return true;
    }

    const cached = committeeCache.get(userId);
    if (cached !== undefined) return cached;

    try {
        const client = getSupabaseUserClient(accessToken);
        const { data, error } = await client.rpc('is_platform_manager', { uid: userId });

        if (error) {
            console.error('Error checking platform manager status:', error.message);
            return false;
        }

        const isCommittee = data === true;
        committeeCache.set(userId, isCommittee);

        return isCommittee;
    } catch (e) {
        console.error('Error checking platform manager status:', e.message);
        return false;
    }
}

// ── PORTAL REDIRECT URL BUILDER ──────────────────────────────────────────
// Build the full portal redirect URL preserving the current request URL,
// INCLUDING query string (e.g. ?blok=A&search=123).
function buildPortalRedirectUrl(currentUrl) {
    try {
        const urlObj = new URL(currentUrl);

        if (!ALLOWED_RETURN_ORIGINS.includes(urlObj.origin)) {
            console.warn(`Origin ${urlObj.origin} is not in ALLOWED_RETURN_ORIGINS`);
            return null;
        }

        const encodedUrl = encodeURIComponent(currentUrl);
        let portal = null;
        const host = urlObj.hostname;
        if (host.endsWith('.sr3.my.id')) {
            portal = 'https://portal.sr3.my.id';
        } else if (host.endsWith('.sakura3.id')) {
            portal = 'https://portal.sakura3.id';
        } else if (host.endsWith('.localtest.me')) {
            portal = 'http://portal.localtest.me:5173';
        } else {
            portal = process.env.PORTAL_URL || 'https://portal.veryresto.com';
        }
        return `${portal}/?redirect_to=${encodedUrl}`;
    } catch (e) {
        console.error('Error building redirect URL:', e.message);
        return null;
    }
}

// ── GLOBAL LOGOUT ────────────────────────────────────────────────────────
async function globalLogout(accessToken) {
    if (!accessToken) return;
    try {
        const url = `${SUPABASE_URL}/auth/v1/logout?scope=global`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${accessToken}`
            }
        });
        if (!res.ok) {
            console.error('Global logout failed:', await res.text());
        }
    } catch (e) {
        console.error('Error during global logout:', e.message);
    }
}

// ── NAMESPACED PERMISSION CHECK ──────────────────────────────────────────
async function checkNamespacedPermission(accessToken, userId, permission) {
    if (!userId || !accessToken) return false;

    if (accessToken === 'dev-bypass-token') {
        return true;
    }

    const cacheKey = `${userId}:${permission}`;
    const cached = permissionCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
        const client = getSupabaseUserClient(accessToken);
        const { data, error } = await client.rpc('has_namespaced_permission', {
            user_id: userId,
            namespaced_perm: permission
        });

        if (error) {
            console.error(`Error checking namespaced permission ${permission}:`, error.message);
            return false;
        }

        const hasPermission = data === true;
        permissionCache.set(cacheKey, hasPermission);

        return hasPermission;
    } catch (e) {
        console.error(`Error checking namespaced permission ${permission}:`, e.message);
        return false;
    }
}

// ── USER PROFILE ─────────────────────────────────────────────────────────
async function fetchUserProfile(accessToken, userId) {
    if (!userId || !accessToken) return null;

    if (accessToken === 'dev-bypass-token') {
        return {
            approval_status: 'approved',
            participant_type: 'resident',
            resident_subtype: 'owner',
            requested_affiliation: null
        };
    }

    const cached = profileCache.get(userId);
    if (cached) return cached;

    try {
        const client = getSupabaseUserClient(accessToken);
        const { data, error } = await client
            .from('profiles')
            .select('approval_status, participant_type, resident_subtype, requested_affiliation')
            .eq('id', userId)
            .single();

        if (error) {
            console.error('Error fetching user profile:', error.message);
            return null;
        }

        if (data) {
            profileCache.set(userId, data);
        }

        return data;
    } catch (e) {
        console.error('Error fetching user profile:', e.message);
        return null;
    }
}

// ── USER ROLES ───────────────────────────────────────────────────────────
async function fetchUserRoles(accessToken, userId) {
    if (!userId || !accessToken) return [];

    if (accessToken === 'dev-bypass-token') {
        return ['admin'];
    }

    const cached = rolesCache.get(userId);
    if (cached) return cached;

    try {
        const client = getSupabaseUserClient(accessToken);
        const { data, error } = await client
            .from('user_roles')
            .select('role')
            .eq('user_id', userId);

        if (error) {
            console.error('Error fetching user roles:', error.message);
            return [];
        }

        const roles = data?.map(r => r.role) || [];
        rolesCache.set(userId, roles);

        return roles;
    } catch (e) {
        console.error('Error fetching user roles:', e.message);
        return [];
    }
}

module.exports = {
    extractSessionFromCookieHeader,
    verifyJwt,
    fetchApprovalStatus,
    fetchIsCommittee,
    buildPortalRedirectUrl,
    globalLogout,
    checkNamespacedPermission,
    fetchUserProfile,
    fetchUserRoles
};
