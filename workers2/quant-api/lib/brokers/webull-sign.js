// Webull OpenAPI request signing (Batch 4): used by lib/brokers/webull.js (sandbox trading) and
// lib/webull-probe.js. The scheme tradeboard-api uses: HMAC-SHA1 of the URL-encoded
// "path&sorted(query+signing headers)[&MD5(body)]" with key "secret&".
const enc = new TextEncoder();
async function hmacSha1B64(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))));
}
// MD5 in plain JS: Workers' WebCrypto has MD5 but Node's (the tests) does not, so one code path for both.
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
export function md5Upper(str) {
  const msg = enc.encode(str), n = ((msg.length + 8) >>> 6) + 1, w = new Uint32Array(n * 16);
  for (let i = 0; i < msg.length; i++) w[i >> 2] |= msg[i] << ((i % 4) * 8);
  w[msg.length >> 2] |= 0x80 << ((msg.length % 4) * 8);
  w[n * 16 - 2] = (msg.length * 8) >>> 0; w[n * 16 - 1] = Math.floor(msg.length / 0x20000000);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < w.length; o += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; } else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const t = d; d = c; c = b;
      const x = (a + f + MD5_K[i] + w[o + g]) >>> 0, s = MD5_S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0; a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((v) => [0, 8, 16, 24].map((s) => ((v >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('').toUpperCase();
}

/** Webull's signature (the same scheme tradeboard-api uses): HMAC-SHA1 of the URL-encoded
 *  "path&sorted(query+signing headers)[&MD5(body)]" with key "secret&". Exported for the test. */
export async function signedHeaders({ host, path, query = {}, body = null, key, secret, token = null, version = 'v2', now = new Date(), nonce = crypto.randomUUID().replace(/-/g, '') }) {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sh = { host, 'x-app-key': key, 'x-signature-algorithm': 'HMAC-SHA1', 'x-signature-nonce': nonce, 'x-signature-version': '1.0', 'x-timestamp': ts };
  const all = { ...query, ...sh };
  const s1 = Object.keys(all).sort().map((k) => `${k}=${all[k]}`).join('&');
  const bodyStr = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const s3 = bodyStr ? `${path}&${s1}&${md5Upper(bodyStr)}` : `${path}&${s1}`;
  const h = { 'x-app-key': key, 'x-timestamp': ts, 'x-signature': await hmacSha1B64(secret + '&', encodeURIComponent(s3)),
    'x-signature-algorithm': 'HMAC-SHA1', 'x-signature-version': '1.0', 'x-signature-nonce': nonce, 'x-version': version };
  if (token) h['x-access-token'] = token;
  if (bodyStr) h['Content-Type'] = 'application/json';
  return h;
}

