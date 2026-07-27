const {
    extractSessionFromCookieHeader,
    verifyJwt,
    fetchApprovalStatus,
    buildPortalRedirectUrl,
    fetchUserProfile,
    checkNamespacedPermission
} = require('../auth');

const DEV_BYPASS_AUTH = process.env.DEV_BYPASS_AUTH === 'true';

/**
 * Step 1 — Authentication gate.
 * Reads and verifies the veryresto-auth cookie.
 * SUCCESS → attaches req.user, calls next().
 * FAILURE → 302 to portal (browser requests) or 401 JSON (API/XHR requests).
 */
async function requireAuth(req, res, next) {
    if (DEV_BYPASS_AUTH) {
        req.user = { id: 'dev-bypass-user', email: 'dev@localtest.me' };
        req.accessToken = 'dev-bypass-token';
        return next();
    }

    const cookieHeader = req.headers.cookie;
    const session = extractSessionFromCookieHeader(cookieHeader);

    if (!session || !session.access_token) {
        return handleAuthFailure(req, res);
    }

    const user = await verifyJwt(session.access_token);
    if (!user) {
        return handleAuthFailure(req, res);
    }

    req.user = user;
    req.accessToken = session.access_token;
    next();
}

function handleAuthFailure(req, res) {
    const isApiRequest = req.path.startsWith('/api/');

    if (isApiRequest) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Must use req.originalUrl to preserve query strings.
    const currentUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
    const redirectUrl = buildPortalRedirectUrl(currentUrl);

    if (!redirectUrl) {
        // Fallback to portal root if origin isn't allowed (auth failure)
        let portal = process.env.PORTAL_URL;
        if (!portal) {
            const host = req.get('host') || '';
            if (host.endsWith('.sakura3.my.id')) {
                portal = 'https://portal.sakura3.my.id';
            } else if (host.endsWith('.sakura3.id')) {
                portal = 'https://portal.sakura3.id';
            } else if (host.endsWith('.localtest.me')) {
                portal = 'http://portal.localtest.me:5173';
            } else {
                portal = 'https://portal.veryresto.com';
            }
        }
        return res.redirect(portal);
    }

    res.redirect(redirectUrl);
}

/**
 * Step 2 — Governance gate.
 * Requires req.user set by requireAuth.
 * SUCCESS → calls next().
 * FAILURE → auth-denied.html?reason= (browser) or 403 JSON (API/XHR requests).
 *           Sets Cache-Control: no-store so the denial page is never cached.
 */
async function requireApprovedResident(req, res, next) {
    if (DEV_BYPASS_AUTH) {
        return next();
    }

    if (!req.user) {
        return handleAuthFailure(req, res);
    }

    // 1. Fetch the user profile (status and classification)
    const profile = await fetchUserProfile(req.accessToken, req.user.id);
    const status = profile?.approval_status || null;

    console.log('[AUTH]', {
        userId: req.user.id,
        authResult: 'success', // At this stage, JWT verification has succeeded
        approvalStatus: status,
        route: req.originalUrl
    });

    if (status !== 'approved') {
        const isApiRequest = req.path.startsWith('/api/');
        if (isApiRequest) {
            return res.status(403).json({ error: 'Access denied', reason: status || 'unknown' });
        }
        res.set('Cache-Control', 'no-store');
        return res.redirect(`/auth-denied?reason=${status || 'unknown'}`);
    }

    // 2. CheckNamespacedPermission for 'rekap_viewer.read_data'
    const hasPermission = await checkNamespacedPermission(req.accessToken, req.user.id, 'rekap_viewer.read_data');
    if (!hasPermission) {
        console.log('[AUTH] User lacks rekap_viewer.read_data permission:', req.user.id);
        const isApiRequest = req.path.startsWith('/api/');
        if (isApiRequest) {
            return res.status(403).json({ error: 'Access denied', reason: 'unauthorized_role' });
        }
        res.set('Cache-Control', 'no-store');
        return res.redirect('/auth-denied?reason=unauthorized_role');
    }

    next();
}

module.exports = {
    requireAuth,
    requireApprovedResident
};
