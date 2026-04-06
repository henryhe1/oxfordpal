/**
 * Cloudflare Worker — Anthropic API Proxy
 * 
 * Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
 * Then add an Environment Variable: ANTHROPIC_API_KEY = sk-ant-...
 * 
 * This worker:
 *   - Accepts POST /v1/messages from your GitHub Pages site
 *   - Forwards the request to api.anthropic.com with your API key
 *   - Returns the response with CORS headers
 */

const ALLOWED_ORIGIN = 'https://henryhe.me';  // change if needed
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Only allow requests from your site (and localhost for dev)
    const origin = request.headers.get('Origin') || '';
    if (!isAllowedOrigin(origin)) {
      return new Response('Forbidden', { status: 403 });
    }

    // Validate API key is configured
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: { message: 'API key not configured on worker' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }

    try {
      const body = await request.text();

      // Forward to Anthropic
      const response = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
      });

      const data = await response.text();

      return new Response(data, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(request),
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
  },
};

function isAllowedOrigin(origin) {
  return (
    origin === 'http://localhost:8000' ||   // 👈 add exact match
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin === ALLOWED_ORIGIN ||
    origin === 'https://www.henryhe.me'
  );
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
