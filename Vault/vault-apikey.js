/* ─────────────────────────────────────────────────────────────────────────────
 * vault-apikey.js — Vault · API Keys & Credentials core (pure logic, no DOM)
 *
 * Shared by the web app (vault-apikey-ui.js) and the Vault Launcher extension
 * (vault-apikey-panel.js, vault-pw-core.js), exactly as vault-pay.js is.
 *
 * An API key is just another vault item with `kind:'apikey'`. Like every other
 * kind, `kind` is the ONLY plaintext on the stored doc — the key, its secret,
 * the provider, the notes, all of it lives inside the item's AES-256-GCM
 * ciphertext (see vault-store.js). So this section inherits, unchanged, the
 * vault's DEK, per-item last-write-wins sync, the real-time listener, the
 * master-password / recovery-key / biometric unlock paths, auto-lock and the
 * encrypted backup. Nothing here touches crypto or storage.
 *
 * Item body (all optional except that a name or a key must exist):
 *   title        display name ("OpenAI – production")
 *   provider     service name; matched against PROVIDERS, free text otherwise
 *   keyType      one of KEY_TYPES
 *   environment  one of ENVIRONMENTS
 *   key          the API key / token                      ← secret
 *   secret       a second secret (client / signing secret) ← secret
 *   keyId        public half: key ID, client ID, access-key ID, app ID
 *   account      the account / email / org the key belongs to
 *   envVar       variable name for .env copies (suggested from the provider)
 *   endpoint     base URL the key is used against
 *   consoleUrl   where the key is managed / rotated
 *   scopes       permissions, free text
 *   expiresAt    'YYYY-MM-DD'
 *   rotatedAt    ms — set automatically when the key changes
 *   keyHistory   [{ key, secret, keyId, at }] — previous keys, newest first
 *   category, tags[], notes, favorite, order
 *   customFields [{ label, value, hidden }] — `hidden` renders masked
 * ──────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';
  if (global.VaultApiKey) return;

  var KIND = 'apikey';
  var EXPIRING_DAYS = 30;
  var HISTORY_MAX = 5;

  // ── Provider registry ─────────────────────────────────────────────────────
  // `detect` recognises a key by its published prefix, so pasting a key names
  // the provider and suggests the conventional env var. Most specific first:
  // 'sk-ant-' must win over OpenAI's bare 'sk-'. Providers without a
  // recognisable format still appear in the picker (no `detect`).
  // `domains` lets the launcher surface a provider's keys first while you are
  // on that provider's console.
  var PROVIDERS = [
    { id: 'anthropic', label: 'Anthropic', color: '#d4a27f', env: 'ANTHROPIC_API_KEY', detect: /^sk-ant-/, domains: ['anthropic.com', 'claude.ai'], console: 'https://console.anthropic.com/settings/keys' },
    { id: 'openrouter', label: 'OpenRouter', color: '#8aafe2', env: 'OPENROUTER_API_KEY', detect: /^sk-or-/, domains: ['openrouter.ai'], console: 'https://openrouter.ai/keys' },
    { id: 'openai', label: 'OpenAI', color: '#a9dcb4', env: 'OPENAI_API_KEY', detect: /^sk-(proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}$/, domains: ['openai.com', 'chatgpt.com'], console: 'https://platform.openai.com/api-keys' },
    { id: 'google', label: 'Google / Gemini', color: '#a3c8ec', env: 'GEMINI_API_KEY', detect: /^AIza[0-9A-Za-z_-]{30,}$/, domains: ['aistudio.google.com', 'console.cloud.google.com', 'makersuite.google.com'], console: 'https://aistudio.google.com/app/apikey' },
    { id: 'xai', label: 'xAI', color: '#c3aee6', env: 'XAI_API_KEY', detect: /^xai-/, domains: ['x.ai'], console: 'https://console.x.ai' },
    { id: 'groq', label: 'Groq', color: '#f0ac7e', env: 'GROQ_API_KEY', detect: /^gsk_/, domains: ['groq.com'], console: 'https://console.groq.com/keys' },
    { id: 'perplexity', label: 'Perplexity', color: '#82c6be', env: 'PERPLEXITY_API_KEY', detect: /^pplx-/, domains: ['perplexity.ai'] },
    { id: 'mistral', label: 'Mistral', color: '#f6c29e', env: 'MISTRAL_API_KEY', domains: ['mistral.ai'], console: 'https://console.mistral.ai/api-keys' },
    { id: 'deepseek', label: 'DeepSeek', color: '#8aafe2', env: 'DEEPSEEK_API_KEY', domains: ['deepseek.com'], console: 'https://platform.deepseek.com/api_keys' },
    { id: 'huggingface', label: 'Hugging Face', color: '#f1e19e', env: 'HF_TOKEN', detect: /^hf_/, domains: ['huggingface.co'], console: 'https://huggingface.co/settings/tokens' },
    { id: 'replicate', label: 'Replicate', color: '#e7d07e', env: 'REPLICATE_API_TOKEN', detect: /^r8_/, domains: ['replicate.com'] },
    { id: 'github', label: 'GitHub', color: '#c3aee6', env: 'GITHUB_TOKEN', detect: /^(gh[pousr]_|github_pat_)/, domains: ['github.com'], console: 'https://github.com/settings/tokens' },
    { id: 'gitlab', label: 'GitLab', color: '#f0ac7e', env: 'GITLAB_TOKEN', detect: /^glpat-/, domains: ['gitlab.com'] },
    { id: 'npm', label: 'npm', color: '#e795ae', env: 'NPM_TOKEN', detect: /^npm_/, domains: ['npmjs.com'] },
    { id: 'cloudflare', label: 'Cloudflare', color: '#f6c29e', env: 'CLOUDFLARE_API_TOKEN', domains: ['cloudflare.com'], console: 'https://dash.cloudflare.com/profile/api-tokens' },
    { id: 'firebase', label: 'Firebase', color: '#f1e19e', env: 'FIREBASE_API_KEY', domains: ['firebase.google.com', 'console.firebase.google.com'] },
    { id: 'aws', label: 'AWS', color: '#e7d07e', env: 'AWS_ACCESS_KEY_ID', secretEnv: 'AWS_SECRET_ACCESS_KEY', detect: /^(AKIA|ASIA)[0-9A-Z]{16}$/, domains: ['aws.amazon.com', 'console.aws.amazon.com'] },
    { id: 'digitalocean', label: 'DigitalOcean', color: '#8aafe2', env: 'DIGITALOCEAN_TOKEN', detect: /^do[opr]_v1_/, domains: ['digitalocean.com'] },
    { id: 'stripe', label: 'Stripe', color: '#ab92dc', env: 'STRIPE_SECRET_KEY', detect: /^(sk|rk|pk)_(live|test)_/, domains: ['stripe.com'], console: 'https://dashboard.stripe.com/apikeys' },
    { id: 'slack', label: 'Slack', color: '#e795ae', env: 'SLACK_TOKEN', detect: /^xox[abpors]-/, domains: ['slack.com', 'api.slack.com'] },
    { id: 'discord', label: 'Discord', color: '#8aafe2', env: 'DISCORD_TOKEN', domains: ['discord.com'] },
    { id: 'notion', label: 'Notion', color: '#adadb2', env: 'NOTION_API_KEY', detect: /^(secret_|ntn_)/, domains: ['notion.so', 'notion.com'] },
    { id: 'linear', label: 'Linear', color: '#ab92dc', env: 'LINEAR_API_KEY', detect: /^lin_api_/, domains: ['linear.app'] },
    { id: 'shopify', label: 'Shopify', color: '#b9d683', env: 'SHOPIFY_ACCESS_TOKEN', detect: /^shp(at|ss|ca|pa)_/, domains: ['shopify.com'] },
    { id: 'sendgrid', label: 'SendGrid', color: '#a3c8ec', env: 'SENDGRID_API_KEY', detect: /^SG\.[\w-]{16,}\.[\w-]{16,}$/, domains: ['sendgrid.com'] },
    { id: 'brevo', label: 'Brevo', color: '#8fc99c', env: 'BREVO_API_KEY', detect: /^xkeysib-/, domains: ['brevo.com'] },
    { id: 'resend', label: 'Resend', color: '#adadb2', env: 'RESEND_API_KEY', detect: /^re_[A-Za-z0-9_]{16,}$/, domains: ['resend.com'] },
    { id: 'mailgun', label: 'Mailgun', color: '#e795ae', env: 'MAILGUN_API_KEY', detect: /^key-[0-9a-f]{32}$/, domains: ['mailgun.com'] },
    { id: 'twilio', label: 'Twilio', color: '#d68a7c', env: 'TWILIO_API_KEY', secretEnv: 'TWILIO_API_SECRET', detect: /^SK[0-9a-fA-F]{32}$/, domains: ['twilio.com'] },
    { id: 'riot', label: 'Riot Games', color: '#d68a7c', env: 'RIOT_API_KEY', detect: /^RGAPI-/, domains: ['developer.riotgames.com'], console: 'https://developer.riotgames.com' },
    { id: 'alpaca', label: 'Alpaca', color: '#f1e19e', env: 'APCA_API_KEY_ID', secretEnv: 'APCA_API_SECRET_KEY', domains: ['alpaca.markets'] },
    { id: 'polygon', label: 'Polygon.io', color: '#ab92dc', env: 'POLYGON_API_KEY', domains: ['polygon.io'] },
    { id: 'finnhub', label: 'Finnhub', color: '#8fc99c', env: 'FINNHUB_API_KEY', domains: ['finnhub.io'] },
    { id: 'alphavantage', label: 'Alpha Vantage', color: '#a9dcb4', env: 'ALPHAVANTAGE_API_KEY', domains: ['alphavantage.co'] },
  ];

  var KEY_TYPES = [
    { id: 'api_key', label: 'API key' },
    { id: 'secret_key', label: 'Secret key' },
    { id: 'access_token', label: 'Access token' },
    { id: 'oauth_client', label: 'OAuth client' },
    { id: 'webhook_secret', label: 'Webhook secret' },
    { id: 'service_account', label: 'Service account' },
    { id: 'deploy_key', label: 'Deploy / SSH key' },
    { id: 'other', label: 'Other' },
  ];

  var ENVIRONMENTS = [
    { id: '', label: 'Unspecified' },
    { id: 'production', label: 'Production' },
    { id: 'staging', label: 'Staging' },
    { id: 'development', label: 'Development' },
    { id: 'test', label: 'Test' },
    { id: 'personal', label: 'Personal' },
  ];

  var PALETTE = ['#f1b0c4', '#f6c29e', '#f1e19e', '#cfe39c', '#a9dcb4', '#9bd8d0', '#a3c8ec', '#c3aee6',
    '#e795ae', '#f0ac7e', '#e7d07e', '#b9d683', '#8fc99c', '#82c6be', '#8aafe2', '#ab92dc'];

  function str(v) { return v == null ? '' : String(v); }
  function trim(v) { return str(v).trim(); }
  function lc(v) { return str(v).toLowerCase(); }

  // ── providers ─────────────────────────────────────────────────────────────
  function providerById(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return null;
  }
  function providerByName(name) {
    var n = lc(trim(name));
    if (!n) return null;
    for (var i = 0; i < PROVIDERS.length; i++) {
      var p = PROVIDERS[i];
      if (p.id === n || lc(p.label) === n) return p;
    }
    // "Gemini" / "Google" both mean the google entry; any label word counts.
    for (var j = 0; j < PROVIDERS.length; j++) {
      var words = lc(PROVIDERS[j].label).split(/[\s/.]+/).filter(Boolean);
      if (words.indexOf(n) >= 0) return PROVIDERS[j];
    }
    return null;
  }
  function detectProvider(key) {
    var k = trim(key);
    if (!k) return null;
    for (var i = 0; i < PROVIDERS.length; i++) {
      var p = PROVIDERS[i];
      if (p.detect && p.detect.test(k)) return p;
    }
    return null;
  }
  // The provider to DISPLAY for an item: what the user typed wins (matched to
  // the registry when it can be), then whatever the key's format says, then a
  // generic entry coloured from the name so it still gets a stable badge.
  function providerOf(item) {
    item = item || {};
    var named = providerByName(item.provider);
    if (named) return named;
    if (trim(item.provider)) return customProvider(trim(item.provider));
    var detected = detectProvider(item.key);
    if (detected) return detected;
    return customProvider('');
  }
  function customProvider(label) {
    return { id: 'custom', label: label || 'API key', color: colorFor(label || 'api'), env: '', custom: true };
  }
  function colorFor(s) {
    var h = lc(s), n = 0;
    for (var i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) >>> 0;
    return PALETTE[n % PALETTE.length];
  }
  function initials(label) {
    var words = str(label).replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '#';
    if (words.length === 1) return words[0].slice(0, 2).replace(/^./, function (c) { return c.toUpperCase(); });
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  function escXml(s) { return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  // A small rounded badge with the provider's initials — drawn locally, so no
  // favicon service ever learns which providers you hold keys for.
  function providerMark(p) {
    p = p || customProvider('');
    return '<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true">' +
      '<rect width="32" height="32" rx="8" fill="' + escXml(p.color || '#adadb2') + '"/>' +
      '<text x="16" y="21" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#2e2833" text-anchor="middle">' +
      escXml(initials(p.label)) + '</text></svg>';
  }

  function keyTypeLabel(id) {
    for (var i = 0; i < KEY_TYPES.length; i++) if (KEY_TYPES[i].id === id) return KEY_TYPES[i].label;
    return '';
  }
  function environmentLabel(id) {
    for (var i = 0; i < ENVIRONMENTS.length; i++) if (ENVIRONMENTS[i].id === id) return id ? ENVIRONMENTS[i].label : '';
    return trim(id);
  }

  // ── masking ───────────────────────────────────────────────────────────────
  // Show a recognisable prefix ("sk-ant-", "ghp_", "AKIA") and the last four,
  // the way provider dashboards list keys. Never more than a third of the key
  // leaves the dots, so a short secret stays fully hidden.
  function maskKey(key) {
    var k = trim(key);
    if (!k) return '';
    var dots = '••••••••';
    if (k.length < 12) return dots;
    var budget = Math.floor(k.length / 3);
    var tail = k.slice(-4);
    var m = /^([A-Za-z]{1,8}[-_.](?:[A-Za-z]{1,8}[-_.])?)/.exec(k);
    var head = m ? m[1] : k.slice(0, 4);
    if (head.length + tail.length > budget) head = head.slice(0, Math.max(0, budget - tail.length));
    if (head.length + tail.length > budget) return dots + tail.slice(-Math.max(0, Math.min(4, budget)));
    return head + dots + tail;
  }

  // ── dates ─────────────────────────────────────────────────────────────────
  function normalizeDate(v) {
    var s = trim(v);
    if (!s) return '';
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  // A key "expires on" a date = it stops working at the END of that local day.
  function expiryStatus(dateStr, now) {
    var d = normalizeDate(dateStr);
    if (!d) return { state: 'none', days: null, label: '' };
    var p = d.split('-');
    var end = new Date(+p[0], +p[1] - 1, +p[2] + 1).getTime();
    var t = now == null ? Date.now() : now;
    var days = Math.ceil((end - t) / 86400000) - 1;
    if (end <= t) return { state: 'expired', days: days, label: 'Expired' };
    if (days <= EXPIRING_DAYS) return { state: 'expiring', days: days, label: days <= 0 ? 'Expires today' : 'Expires in ' + days + ' day' + (days === 1 ? '' : 's') };
    return { state: 'valid', days: days, label: '' };
  }
  function formatDate(dateStr) {
    var d = normalizeDate(dateStr);
    if (!d) return '';
    var p = d.split('-');
    try { return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d; }
  }

  // ── env vars ──────────────────────────────────────────────────────────────
  function toEnvName(s) {
    return str(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1');
  }
  function envName(item) {
    item = item || {};
    if (trim(item.envVar)) return toEnvName(item.envVar);
    var p = providerOf(item);
    if (p.env) return p.env;
    var base = toEnvName(item.provider || item.title || 'API');
    if (!base) return 'API_KEY';
    return /(_KEY|_TOKEN|_SECRET)$/.test(base) ? base : base + '_API_KEY';
  }
  function secretEnvName(item) {
    var p = providerOf(item);
    if (p.secretEnv && !trim((item || {}).envVar)) return p.secretEnv;
    return envName(item).replace(/(_API)?_(KEY|TOKEN|KEY_ID)$/, '') + '_SECRET';
  }
  // Quote only when a shell / dotenv parser would otherwise mangle the value.
  function envQuote(v) {
    v = str(v);
    if (/^[A-Za-z0-9_\-.\/:+=@,%]*$/.test(v)) return v;
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }
  function envLine(item) {
    return envName(item) + '=' + envQuote(trim((item || {}).key));
  }
  // Every value of one item as .env lines: key, secret, key ID.
  function envBlock(item) {
    item = item || {};
    var lines = [];
    if (trim(item.key)) lines.push(envLine(item));
    if (trim(item.secret)) lines.push(secretEnvName(item) + '=' + envQuote(trim(item.secret)));
    if (trim(item.keyId) && trim(item.key)) {
      var idName = envName(item).replace(/(_API)?_(KEY|TOKEN|KEY_ID)$/, '') + '_KEY_ID';
      if (idName !== envName(item)) lines.push(idName + '=' + envQuote(trim(item.keyId)));
    }
    return lines.join('\n');
  }

  // Parse a .env file. Handles `export `, comments, single/double quotes, and
  // escaped newlines in double quotes. Returns [{ name, value }].
  function parseDotEnv(text) {
    var out = [];
    str(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line || line.charAt(0) === '#') return;
      line = line.replace(/^export\s+/, '');
      var m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(line);
      if (!m) return;
      var v = m[2];
      if (/^"/.test(v)) {
        var dq = /^"((?:[^"\\]|\\.)*)"/.exec(v);
        v = dq ? dq[1].replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1') : v.slice(1);
      } else if (/^'/.test(v)) {
        var sq = /^'([^']*)'/.exec(v);
        v = sq ? sq[1] : v.slice(1);
      } else {
        v = v.replace(/\s+#.*$/, '').trim();
      }
      out.push({ name: m[1], value: v });
    });
    return out;
  }
  // Turn a parsed .env into items. Only values that look like credentials are
  // taken (by NAME — KEY / TOKEN / SECRET / PASSWORD — or by a recognised
  // key format), so ports, hostnames and feature flags don't become "keys".
  function fromDotEnv(text) {
    var items = [];
    parseDotEnv(text).forEach(function (e) {
      if (!e.value) return;
      var credName = /(KEY|TOKEN|SECRET|PASSWORD|PASS|PAT|CREDENTIAL|AUTH)/i.test(e.name);
      var detected = detectProvider(e.value);
      if (!credName && !detected) return;
      var p = detected;
      if (!p) {
        var stem = e.name.split('_')[0];
        p = providerByName(stem);
      }
      items.push(normalize({
        kind: KIND,
        title: p ? p.label + ' · ' + e.name : e.name,
        provider: p ? p.label : '',
        key: e.value,
        envVar: e.name,
        keyType: /SECRET/i.test(e.name) ? 'secret_key' : /TOKEN|PAT/i.test(e.name) ? 'access_token' : 'api_key',
        category: 'Development',
      }));
    });
    return items;
  }

  // ── urls ──────────────────────────────────────────────────────────────────
  function normalizeUrl(u) {
    var s = trim(u);
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/|$)/i.test(s)) return 'https://' + s;
    return s;
  }
  function hostOf(u) {
    try { return new URL(normalizeUrl(u)).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
  }
  function safeHref(u) {
    var s = normalizeUrl(u);
    return /^https?:\/\//i.test(s) ? s : '';
  }

  // ── items ─────────────────────────────────────────────────────────────────
  function normalizeCustom(list) {
    return (Array.isArray(list) ? list : []).map(function (c) {
      c = c || {};
      var o = { label: trim(c.label), value: str(c.value) };
      if (c.hidden) o.hidden = true;
      return o;
    }).filter(function (c) { return c.label || c.value.trim(); });
  }
  // Shape the plaintext BODY. Secrets are trimmed (a pasted key almost always
  // drags a newline along, and a trailing space breaks every Authorization
  // header), notes are kept verbatim. id/createdAt are the caller's to carry.
  function normalize(item) {
    item = item || {};
    var o = {
      kind: KIND,
      title: trim(item.title),
      provider: trim(item.provider),
      keyType: trim(item.keyType) || 'api_key',
      environment: trim(item.environment),
      key: trim(item.key),
      secret: trim(item.secret),
      keyId: trim(item.keyId),
      account: trim(item.account),
      envVar: item.envVar ? toEnvName(item.envVar) : '',
      endpoint: normalizeUrl(item.endpoint),
      consoleUrl: normalizeUrl(item.consoleUrl),
      scopes: trim(item.scopes),
      expiresAt: normalizeDate(item.expiresAt),
      category: trim(item.category) || 'Development',
      tags: (Array.isArray(item.tags) ? item.tags : str(item.tags).split(',')).map(trim).filter(Boolean),
      notes: str(item.notes).replace(/\s+$/, ''),
      favorite: !!item.favorite,
      customFields: normalizeCustom(item.customFields),
    };
    if (!o.title) {
      var p = providerOf(o);
      o.title = p.custom ? (o.provider || 'API key') : p.label;
    }
    if (typeof item.order === 'number' && isFinite(item.order)) o.order = item.order;
    if (item.rotatedAt) o.rotatedAt = item.rotatedAt;
    if (Array.isArray(item.keyHistory) && item.keyHistory.length) o.keyHistory = item.keyHistory.slice(0, HISTORY_MAX);
    return o;
  }

  // Key rotation: when the key (or its secret) changes on an existing item,
  // keep the old one — you'll want it while old deployments drain — capped at
  // HISTORY_MAX. `prev` is the stored item, `next` the normalised body.
  function withRotation(prev, next, now) {
    next = Object.assign({}, next);
    var hist = prev && Array.isArray(prev.keyHistory) ? prev.keyHistory.slice() : [];
    if (prev && (prev.key || prev.secret) && (prev.key !== next.key || (prev.secret || '') !== (next.secret || ''))) {
      hist.unshift({ key: prev.key || '', secret: prev.secret || '', keyId: prev.keyId || '', at: prev.rotatedAt || prev.modifiedAt || prev.createdAt || 0 });
      next.rotatedAt = now == null ? Date.now() : now;
    } else if (prev && prev.rotatedAt && !next.rotatedAt) {
      next.rotatedAt = prev.rotatedAt;
    }
    if (hist.length) next.keyHistory = hist.slice(0, HISTORY_MAX); else delete next.keyHistory;
    return next;
  }

  function validate(item, now) {
    var errors = [], warnings = [];
    item = item || {};
    if (!trim(item.title) && !trim(item.key)) errors.push('Give it a name or paste a key.');
    var rawKey = str(item.key);
    if (/\s/.test(rawKey.trim())) warnings.push('The key contains spaces or line breaks — check it was pasted whole.');
    if (item.envVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trim(item.envVar))) warnings.push('The variable name will be saved as ' + toEnvName(item.envVar) + '.');
    if (trim(item.expiresAt) && !normalizeDate(item.expiresAt)) errors.push('The expiry date is not a valid date.');
    else if (expiryStatus(item.expiresAt, now).state === 'expired') warnings.push('This key has already expired.');
    ['endpoint', 'consoleUrl'].forEach(function (f) {
      var v = trim(item[f]);
      if (v && !safeHref(v) && !/^[a-z][a-z0-9+.-]*:/i.test(v)) warnings.push((f === 'endpoint' ? 'Endpoint' : 'Console URL') + ' doesn\'t look like a web address.');
    });
    return { ok: !errors.length, errors: errors, warnings: warnings };
  }

  // Everything a list row needs, derived once. `masked` is safe to paint.
  function summarize(item, now) {
    item = item || {};
    var p = providerOf(item);
    var exp = expiryStatus(item.expiresAt, now);
    var env = environmentLabel(item.environment);
    var providerLabel = p.custom ? trim(item.provider) : p.label;
    var sub = [providerLabel && providerLabel !== trim(item.title) ? providerLabel : '', env, trim(item.account)].filter(Boolean);
    return {
      id: item.id,
      title: trim(item.title) || providerLabel || 'API key',
      subtitle: sub.join(' · ') || keyTypeLabel(item.keyType) || 'API key',
      provider: p, providerLabel: providerLabel,
      keyTypeLabel: keyTypeLabel(item.keyType),
      environment: trim(item.environment), environmentLabel: env,
      masked: maskKey(item.key) || (trim(item.secret) ? maskKey(item.secret) : ''),
      maskedSecret: maskKey(item.secret),
      hasKey: !!trim(item.key), hasSecret: !!trim(item.secret), hasKeyId: !!trim(item.keyId),
      envName: envName(item),
      expiresAt: normalizeDate(item.expiresAt), expiry: formatDate(item.expiresAt),
      expiryState: exp.state, expiryLabel: exp.label, expiryDays: exp.days,
      favorite: !!item.favorite,
      historyCount: Array.isArray(item.keyHistory) ? item.keyHistory.length : 0,
    };
  }

  // Values a page-fill may use. The caller (a user's explicit Fill click)
  // decides which one goes where.
  function fillValues(item) {
    item = item || {};
    return {
      key: trim(item.key), secret: trim(item.secret), keyId: trim(item.keyId),
      account: trim(item.account), endpoint: trim(item.endpoint),
    };
  }

  // ── ordering ──────────────────────────────────────────────────────────────
  function hasOrder(i) { return !!i && typeof i.order === 'number' && isFinite(i.order); }
  function autoCompare(now) {
    var rank = { expired: 0, expiring: 1, valid: 2, none: 2 };
    return function (a, b) {
      if (!!b.favorite !== !!a.favorite) return b.favorite ? 1 : -1;
      var ra = rank[expiryStatus(a.expiresAt, now).state], rb = rank[expiryStatus(b.expiresAt, now).state];
      if (ra !== rb) return ra - rb;
      return lc(a.title || a.provider).localeCompare(lc(b.title || b.provider));
    };
  }
  // Manual order first (dragged), then the rest: pinned, then expired/expiring
  // (they need attention), then alphabetical.
  function sortKeys(items, now) {
    var list = (items || []).slice();
    var manual = list.filter(hasOrder).sort(function (a, b) {
      if (a.order !== b.order) return a.order - b.order;
      return lc(a.title).localeCompare(lc(b.title));
    });
    return manual.concat(list.filter(function (i) { return !hasOrder(i); }).sort(autoCompare(now)));
  }
  function reorderPlan(orderedIds, items) {
    var byId = {};
    (items || []).forEach(function (c) { if (c && c.id) byId[c.id] = c; });
    var plan = [];
    (orderedIds || []).forEach(function (id, i) { var c = byId[id]; if (c && c.order !== i) plan.push({ id: id, order: i }); });
    return plan;
  }
  function nextTopOrder(items) {
    var orders = (items || []).filter(hasOrder).map(function (c) { return c.order; });
    return orders.length ? Math.min.apply(null, orders) - 1 : undefined;
  }

  // Plaintext-free filter for the launcher (the web app uses store.search()).
  // Never matches the key or secret themselves, so typing characters can't be
  // used to confirm a key one guess at a time.
  function filterKeys(items, query) {
    var q = lc(trim(query));
    if (!q) return items || [];
    return (items || []).filter(function (c) {
      var p = providerOf(c);
      var hay = [c.title, c.provider, p.label, c.account, c.keyId, envName(c), environmentLabel(c.environment),
        keyTypeLabel(c.keyType), hostOf(c.endpoint), hostOf(c.consoleUrl), c.scopes, c.category,
        Array.isArray(c.tags) ? c.tags.join(' ') : ''].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // Keys relevant to the page you're on: its host matches the item's console /
  // endpoint URL, or one of the provider's own domains.
  function matchHost(items, pageHost) {
    var h = lc(pageHost).replace(/^www\./, '');
    if (!h) return [];
    function hit(d) { d = lc(d); return !!d && (h === d || h.endsWith('.' + d) || d.endsWith('.' + h)); }
    return (items || []).filter(function (c) {
      if (hit(hostOf(c.consoleUrl)) || hit(hostOf(c.endpoint))) return true;
      var p = providerOf(c);
      return !!(p.domains && p.domains.some(hit));
    });
  }

  var api = {
    KIND: KIND, PROVIDERS: PROVIDERS, KEY_TYPES: KEY_TYPES, ENVIRONMENTS: ENVIRONMENTS,
    EXPIRING_DAYS: EXPIRING_DAYS, HISTORY_MAX: HISTORY_MAX,
    providerById: providerById, providerByName: providerByName, detectProvider: detectProvider,
    providerOf: providerOf, providerMark: providerMark, initials: initials,
    keyTypeLabel: keyTypeLabel, environmentLabel: environmentLabel,
    maskKey: maskKey, normalizeDate: normalizeDate, expiryStatus: expiryStatus, formatDate: formatDate,
    toEnvName: toEnvName, envName: envName, secretEnvName: secretEnvName, envQuote: envQuote,
    envLine: envLine, envBlock: envBlock, parseDotEnv: parseDotEnv, fromDotEnv: fromDotEnv,
    normalizeUrl: normalizeUrl, hostOf: hostOf, safeHref: safeHref,
    normalize: normalize, withRotation: withRotation, validate: validate, summarize: summarize, fillValues: fillValues,
    hasOrder: hasOrder, sortKeys: sortKeys, reorderPlan: reorderPlan, nextTopOrder: nextTopOrder,
    filterKeys: filterKeys, matchHost: matchHost,
  };

  global.VaultApiKey = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
