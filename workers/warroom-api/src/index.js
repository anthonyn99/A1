export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // Riot API proxy
    if (url.pathname.startsWith('/api/riot')) {
      const endpoint = url.searchParams.get('endpoint');
      const region   = url.searchParams.get('region') || 'na1';
      if (!endpoint) return new Response('Missing endpoint', { status: 400, headers: cors });
      const riotUrl = `https://${region}.api.riotgames.com${endpoint}${endpoint.includes('?') ? '&' : '?'}api_key=${env.RIOT_API_KEY}`;
      const resp = await fetch(riotUrl);
      const data = await resp.text();
      return new Response(data, { status: resp.status, headers: cors });
    }

    // DDragon version proxy
    if (url.pathname === '/api/ddragon-version') {
      const resp = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
      const data = await resp.text();
      return new Response(data, { status: resp.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Debug
    if (url.pathname === '/debug') {
      return new Response(JSON.stringify({ key: env.RIOT_API_KEY ? 'set' : 'missing' }), { headers: cors });
    }

    return new Response('WarRoom API ready', { status: 200, headers: cors });
  }
}
