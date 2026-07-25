// ============================================================================
// taskhub-weather-api — Cloudflare Worker
//
// KV-cached proxy for the Open-Meteo forecast API, backing the weather widget
// that sits at the top of both TaskHubs (Tony's and Veda's) in index.html.
//
// Open-Meteo is free and key-less, but each browser resolving its own
// geolocation would hammer it on every poll cycle, so every call lands here
// first and is cached in KV keyed by lat/lon ROUNDED TO 2 DECIMALS (~1.1 km) —
// which is also the only coordinate precision that ever leaves the browser.
//
// Routes:
//   GET /forecast?lat=<n>&lon=<n>[&units=us|metric]
//        → Open-Meteo payload (current + 48h hourly + 16d daily) with an
//          extra `place` field (reverse-geocoded "City, Region" label).
//
// Caching:
//   fc:<lat>:<lon>:<units>        15 min   forecast payload
//   fc:<...>:stale                 ∞       last good copy, served if upstream errors
//   geo:<lat>:<lon>               30 days  reverse-geocoded place label
//
// Bindings (wrangler.toml):
//   WX_CACHE   KV namespace (id b70722a46ddb40d49906e2e4aedc7b4a)
//
// No secrets — neither upstream requires a key.
// ============================================================================

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const REVGEO = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

const TTL_FORECAST = 15 * 60;      // 15 min — matches the client's ~12 min poll
const TTL_PLACE = 30 * 24 * 3600;  // 30 days — a city name doesn't move

const CURRENT_VARS = 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m';
const HOURLY_VARS = 'temperature_2m,weather_code,precipitation_probability';
const DAILY_VARS = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,sunrise,sunset,uv_index_max,precipitation_probability_max,wind_speed_10m_max';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname !== '/forecast') return j({ error: 'Not found' }, 404);

    const lat = num(url.searchParams.get('lat'));
    const lon = num(url.searchParams.get('lon'));
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return j({ error: 'Bad lat/lon' }, 400);

    // Round to 2dp BEFORE anything else: the cache key, the upstream call and
    // the reverse geocode all use the coarsened point, never the raw fix.
    const rlat = lat.toFixed(2), rlon = lon.toFixed(2);
    const units = url.searchParams.get('units') === 'metric' ? 'metric' : 'us';
    const key = `fc:${rlat}:${rlon}:${units}`;

    try {
      const hit = await env.WX_CACHE.get(key);
      if (hit) return new Response(hit, { headers: { ...CORS, 'X-Cache': 'HIT' } });

      const qs = new URLSearchParams({
        latitude: rlat,
        longitude: rlon,
        current: CURRENT_VARS,
        hourly: HOURLY_VARS,
        daily: DAILY_VARS,
        timezone: 'auto',
        forecast_days: '16',
        forecast_hours: '48',
        temperature_unit: units === 'metric' ? 'celsius' : 'fahrenheit',
        wind_speed_unit: units === 'metric' ? 'kmh' : 'mph',
        precipitation_unit: units === 'metric' ? 'mm' : 'inch',
      });

      const [res, place] = await Promise.all([
        fetch(`${OPEN_METEO}?${qs}`),
        placeLabel(env, rlat, rlon),
      ]);

      if (!res.ok) {
        const stale = await env.WX_CACHE.get(key + ':stale');
        if (stale) return new Response(stale, { headers: { ...CORS, 'X-Cache': 'STALE' } });
        return j({ error: 'Upstream ' + res.status }, 502);
      }

      const data = await res.json();
      if (place) data.place = place;
      data.fetched_at = Date.now();
      const body = JSON.stringify(data);

      await Promise.all([
        env.WX_CACHE.put(key, body, { expirationTtl: TTL_FORECAST }),
        env.WX_CACHE.put(key + ':stale', body),
      ]);
      return new Response(body, { headers: { ...CORS, 'X-Cache': 'MISS' } });
    } catch (e) {
      const stale = await env.WX_CACHE.get(key + ':stale').catch(() => null);
      if (stale) return new Response(stale, { headers: { ...CORS, 'X-Cache': 'STALE' } });
      return j({ error: e.message }, 502);
    }
  },
};

// Reverse geocode → "Denver, Colorado". Best-effort: the forecast is still
// useful without a label, so every failure path resolves to null.
async function placeLabel(env, rlat, rlon) {
  const key = `geo:${rlat}:${rlon}`;
  try {
    const hit = await env.WX_CACHE.get(key);
    if (hit !== null) return hit || null;
    const res = await fetch(`${REVGEO}?latitude=${rlat}&longitude=${rlon}&localityLanguage=en`);
    if (!res.ok) return null;
    const g = await res.json();
    const city = g.city || g.locality || '';
    const region = g.principalSubdivision || g.countryName || '';
    const label = [city, region].filter(Boolean).join(', ');
    await env.WX_CACHE.put(key, label, { expirationTtl: TTL_PLACE });
    return label || null;
  } catch (e) {
    return null;
  }
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function j(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: CORS }); }
