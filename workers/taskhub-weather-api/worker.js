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
//   GET /forecast[?lat=<n>&lon=<n>][&units=us|metric]
//        → Open-Meteo payload (current + 48h hourly + 16d daily) with an
//          extra `place` field (reverse-geocoded "City, Region" label).
//
// lat/lon are OPTIONAL. When the browser can't give a fix (permission denied,
// Brave's default geo block, insecure context), the client calls with no coords
// and we fall back to Cloudflare's own IP geolocation (`request.cf.latitude/
// longitude`) — city-accurate and free, no extra upstream request. That beats a
// hardcoded default, which would silently show one city to everyone.
//
// Which path was used comes back in response HEADERS, not the body, so the KV
// entry for a coordinate stays identical no matter who asked for it:
//   X-Wx-Source: client | ip      X-Wx-Lat / X-Wx-Lon: coords actually used
//
// Caching:
//   fc:<lat>:<lon>:<units>         7 days  forecast payload. Fresh for the first
//                                          15 min (metadata.at); past that it is
//                                          the fallback served when upstream is
//                                          down. One key, so one write per miss.
//   geo:<lat>:<lon>               30 days  reverse-geocoded place label
//
// Bindings (wrangler.toml):
//   WX_CACHE   KV namespace (id b70722a46ddb40d49906e2e4aedc7b4a)
//
// No secrets — neither upstream requires a key.
// ============================================================================

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const REVGEO = 'https://api.bigdatacloud.net/data/reverse-geocode-client';

const FRESH_FORECAST = 15 * 60;    // 15 min — matches the client's ~12 min poll
// How long the last-known-good stays available to serve when upstream is down.
// The entry is only FRESH for FRESH_FORECAST; past that it is a stale fallback.
const TTL_FORECAST = 7 * 24 * 3600;
const TTL_PLACE = 30 * 24 * 3600;  // 30 days — a city name doesn't move

const CURRENT_VARS = 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m';
const HOURLY_VARS = 'temperature_2m,weather_code,precipitation_probability';
const DAILY_VARS = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,sunrise,sunset,uv_index_max,precipitation_probability_max,wind_speed_10m_max';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'X-Cache, X-Wx-Source, X-Wx-Lat, X-Wx-Lon',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname !== '/forecast') return j({ error: 'Not found' }, 404);

    let lat = num(url.searchParams.get('lat'));
    let lon = num(url.searchParams.get('lon'));
    let source = 'client';
    if (lat === null || lon === null) {
      // No browser fix — use Cloudflare's IP geolocation for this request.
      const cf = request.cf || {};
      lat = num(cf.latitude); lon = num(cf.longitude);
      source = 'ip';
      if (lat === null || lon === null) return j({ error: 'Location unavailable' }, 400);
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return j({ error: 'Bad lat/lon' }, 400);

    // Round to 2dp BEFORE anything else: the cache key, the upstream call and
    // the reverse geocode all use the coarsened point, never the raw fix.
    const rlat = lat.toFixed(2), rlon = lon.toFixed(2);
    const units = url.searchParams.get('units') === 'metric' ? 'metric' : 'us';
    const key = `fc:${rlat}:${rlon}:${units}`;
    const meta = { 'X-Wx-Source': source, 'X-Wx-Lat': rlat, 'X-Wx-Lon': rlon };

    // One read serves both roles: `cached` is the fresh hit when it is inside
    // the freshness window, and the stale fallback when it isn't.
    let cached = null;
    try {
      const e = await env.WX_CACHE.getWithMetadata(key, 'text');
      if (e && e.value) cached = { body: e.value, at: (e.metadata && e.metadata.at) || 0 };
    } catch (e) {}

    try {
      if (cached && Date.now() - cached.at < FRESH_FORECAST * 1000)
        return new Response(cached.body, { headers: { ...CORS, ...meta, 'X-Cache': 'HIT' } });

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
        if (cached) return new Response(cached.body, { headers: { ...CORS, ...meta, 'X-Cache': 'STALE' } });
        return j({ error: 'Upstream ' + res.status }, 502);
      }

      const data = await res.json();
      if (place) data.place = place;
      data.fetched_at = Date.now();
      const body = JSON.stringify(data);

      await env.WX_CACHE.put(key, body, {
        expirationTtl: TTL_FORECAST,
        metadata: { at: data.fetched_at },
      });
      return new Response(body, { headers: { ...CORS, ...meta, 'X-Cache': 'MISS' } });
    } catch (e) {
      if (cached) return new Response(cached.body, { headers: { ...CORS, ...meta, 'X-Cache': 'STALE' } });
      return j({ error: e.message }, 502);
    }
  },
};

// Reverse geocode → "Longmont, Colorado". Best-effort: the forecast is still
// useful without a label, so every failure path resolves to null.
//
// `locality` before `city`: `city` is the POSTAL city, which swallows suburbs —
// Kennesaw GA comes back as city "Atlanta", locality "Kennesaw". Prefer the
// finer field so people see the town they're actually in. (Key prefix is geo2
// because geo1 entries were cached with the coarse label.)
async function placeLabel(env, rlat, rlon) {
  const key = `geo2:${rlat}:${rlon}`;
  try {
    const hit = await env.WX_CACHE.get(key);
    if (hit !== null) return hit || null;
    const res = await fetch(`${REVGEO}?latitude=${rlat}&longitude=${rlon}&localityLanguage=en`);
    if (!res.ok) return null;
    const g = await res.json();
    const city = g.locality || g.city || '';
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
