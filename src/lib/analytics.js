const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Cache user-scoped clients to avoid re-creation per analytics call.
// Simple Map with bounded size (analytics calls are infrequent).
const clientCache = new Map();
const MAX_CLIENTS = 50;

function getSupabaseUserClient(accessToken) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
    }

    if (clientCache.has(accessToken)) {
        return clientCache.get(accessToken);
    }

    // Evict oldest entry if at capacity
    if (clientCache.size >= MAX_CLIENTS) {
        const firstKey = clientCache.keys().next().value;
        clientCache.delete(firstKey);
    }

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        global: {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        },
        realtime: { enabled: false }
    });

    clientCache.set(accessToken, client);
    return client;
}

async function track(accessToken, userId, eventName, properties = {}) {
  try {
    if (!accessToken || !userId) return;
    const client = getSupabaseUserClient(accessToken);
    const { error } = await client.from('analytics_events').insert({
      user_id: userId,
      app_slug: 'rekap_viewer',
      event_name: eventName,
      properties: properties || {}
    });
    if (error) {
      console.error('[analytics] Error writing to Supabase:', error.message);
    }
  } catch (error) {
    // Fail silently
    console.error('[analytics] Failed to track event:', error.message || error);
  }
}

module.exports = { track };
