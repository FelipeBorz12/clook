// index.js
import express from 'express';
import path from 'path';
import 'dotenv/config';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { supabase } from './supabaseClient.js';

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

app.use(morgan('dev'));
app.use('/clook/gif', express.static(path.join(process.cwd(), 'gif')));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(process.cwd(), 'public'))); 

// -------------------------------------------
// Config
// -------------------------------------------
app.set('trust proxy', true);

const REMOVE_WWW       = String(process.env.REMOVE_WWW || 'true') === 'true';
const CACHE_TTL_MS     = Number(process.env.CACHE_TTL_MS || 300000);
const DEFAULT_LINK_FIELD = (process.env.DEFAULT_LINK_FIELD || 'instagram').toLowerCase();
const SLUG_FORWARD_MODE  = (process.env.SLUG_FORWARD_MODE || 'exact').toLowerCase(); // exact | append_path
const BASE_PUBLIC_URL  = (process.env.BASE_PUBLIC_URL || 'http://127.0.0.1:3000').replace(/\/+$/,'');
const FORCE_HTTPS      = String(process.env.FORCE_HTTPS ?? 'true') === 'true';

const ALLOWED_FIELDS = new Set(['instagram', 'onlyfans', 'tiktok']);

function normalizeHost(rawHostHeader = '') {
  const host = String(rawHostHeader || '').toLowerCase().split(':')[0].trim();
  if (!host) return '';
  if (REMOVE_WWW && host.startsWith('www.')) return host.slice(4);
  return host;
}
function getRealIp(req) {
  // Si usas Cloudflare/NGINX/Render, intenta leer estos headers primero
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xri = req.headers['x-real-ip'];
  if (xri) return String(xri).trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip;
}
function isSafeHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
function computePublicUrl(slug) {
  return `${BASE_PUBLIC_URL}/searchEngine/${slug}`;
}
function sha1(x){ return crypto.createHash('sha1').update(String(x)).digest('hex'); }

// HTTPS forzado detrás de proxy
app.use((req, res, next) => {
  if (FORCE_HTTPS && process.env.NODE_ENV === 'production') {
    const xfProto = req.headers['x-forwarded-proto'];
    if (xfProto && xfProto !== 'https') {
      const host = req.headers.host;
      return res.redirect(301, `https://${host}${req.originalUrl}`);
    }
  }
  next();
});

// -------------------------------------------
// Test DB
// -------------------------------------------
try {
  const { error: pingErr } = await supabase.from('links').select('id').limit(1);
  if (pingErr) console.error('Error conectando a Supabase:', pingErr.message);
  else console.log('Conexión exitosa a DB');
} catch (e) {
  console.error('Error conectando a Supabase:', e?.message || e);
}

// -------------------------------------------
// Caché y helpers
// -------------------------------------------
const linksCache = new Map(); // key: link_id, value: { val, exp }
function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { map.delete(key); return null; }
  return hit.val;
}
function cacheSet(map, key, val, ttl = CACHE_TTL_MS) {
  map.set(key, { val, exp: Date.now() + ttl });
}

async function getLinks() {
  const { data, error } = await supabase.from('links').select('*');
  if (error) {
    console.error('Error fetching links from Supabase:', error);
    return {};
  }
  const links = {};
  (data || []).forEach(row => {
    links[row.id] = {
      onlyfans: row.onlyfans,
      instagram: row.instagram,
      tiktok: row.tiktok,
      name: row.name,
      subtitle: row.subtitle,
      photo: row.photo,
      public_url: row.public_url || null
    };
  });
  return links;
}

async function getLinkRow(linkId) {
  const cached = cacheGet(linksCache, linkId);
  if (cached) return cached;

  const { data, error } = await supabase.from('links').select('*').eq('id', linkId).maybeSingle();
  if (error) {
    console.error('DB error (links):', error.message);
    return null;
  }
  cacheSet(linksCache, linkId, data || null);
  return data || null;
}

// Garantiza que public_url esté creado/actualizado en DB
async function ensurePublicUrlPersisted(slug) {
  const desired = computePublicUrl(slug);

  const { data: row, error } = await supabase
    .from('links')
    .select('public_url')
    .eq('id', slug)
    .maybeSingle();

  if (error) {
    console.error('ensurePublicUrlPersisted read error:', error.message);
    return null;
  }
  if (row?.public_url === desired) return desired;

  const { error: upErr } = await supabase
    .from('links')
    .update({ public_url: desired })
    .eq('id', slug);

  if (upErr) {
    console.error('ensurePublicUrlPersisted update error:', upErr.message);
    return row?.public_url || null;
  }

  linksCache.delete(slug);
  return desired;
}

function buildForwardUrl(base, req, mode) {
  if (!base) return '';
  if (mode !== 'append_path') return base;
  try {
    const target = new URL(base);
    const currentPath = req.originalUrl || req.url || '/';
    const needsSlash = !target.pathname.endsWith('/') && !currentPath.startsWith('/');
    const pathCombined = `${target.pathname}${needsSlash ? '/' : ''}${currentPath}`;
    target.pathname = pathCombined;
    return target.toString();
  } catch { return ''; }
}

// -------------------------------------------
// Rate limit por identidad + IP + global (ROBUSTO)
// -------------------------------------------
// ENV afinables:
// RL_IDENTITY_MAX_PER_MIN (por persona): default 80
// RL_IP_MAX_PER_MIN       (por IP):       default 300
// RL_GLOBAL_MAX_PER_MIN   (global):       default 2000
// RL_BURST_WINDOW_MS      (ventana ráfaga): default 2000
// RL_BURST_MAX            (hits/identidad en ventana): default 12
const RL_ID_MAX  = Number(process.env.RL_IDENTITY_MAX_PER_MIN || 80);
const RL_IP_MAX  = Number(process.env.RL_IP_MAX_PER_MIN || 300);
const RL_G_MAX   = Number(process.env.RL_GLOBAL_MAX_PER_MIN || 2000);
const RL_WIN_MS  = 60_000;

const BURST_WIN_MS = Number(process.env.RL_BURST_WINDOW_MS || 2000);
const BURST_MAX    = Number(process.env.RL_BURST_MAX || 12);

const hitsIdentity = new Map(); // key identity -> array timestamps
const hitsIp       = new Map(); // key ip       -> array timestamps
const hitsGlobal   = [];        // array timestamps

function prune(arr, now, windowMs){
  let i=0; const min = now - windowMs;
  while(i < arr.length && arr[i] < min) i++;
  if (i > 0) arr.splice(0, i);
}
function pushHit(map, key, now){
  let arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  arr.push(now);
  return arr;
}
function identityKey(req) {
  const ip  = getRealIp(req) || 'ip?';
  const ua  = req.headers['user-agent'] || '';
  const sid = req.cookies.sessionId || 'anon';
  const uah = sha1(ua).slice(0,16);
  return `${ip}#${sid}#${uah}`;
}

// Sesión (parte de la identidad)
app.use((req, res, next) => {
  if (!req.cookies.sessionId) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie('sessionId', sessionId, { httpOnly: true, sameSite: 'Lax' });
    req.sessionId = sessionId;
  } else {
    req.sessionId = req.cookies.sessionId;
  }
  next();
});

function rateGuard(req, res, next) {
  const now = Date.now();
  const ip  = getRealIp(req);
  const id  = identityKey(req);

  // Global
  hitsGlobal.push(now);
  prune(hitsGlobal, now, RL_WIN_MS);
  if (hitsGlobal.length > RL_G_MAX) return res.status(503).send('Busy');

  // IP
  const ipArr = pushHit(hitsIp, ip, now);
  prune(ipArr, now, RL_WIN_MS);
  if (ipArr.length > RL_IP_MAX) return res.status(429).send('Too Many Requests (IP)');

  // Identidad
  const idArr = pushHit(hitsIdentity, id, now);
  prune(idArr, now, RL_WIN_MS);
  if (idArr.length > RL_ID_MAX) return res.status(429).send('Too Many Requests (Identity)');

  // Ráfaga (burst)
  const burst = idArr.filter(t => now - t <= BURST_WIN_MS).length;
  if (burst > BURST_MAX) {
    // Pequeña penalización de latencia contra scrapers
    const delay = Math.floor(50 + Math.random()*150);
    setTimeout(() => next(), delay);
    return;
  }
  next();
}
app.use(rateGuard);

// -------------------------------------------
// Bot / UA heuristics + Challenge JS (mejorado)
// -------------------------------------------
function isSearchEngine(userAgent) {
  const bots = [
    'googlebot','bingbot','slurp','duckduckbot','baiduspider',
    'yandexbot','sogou','exabot','facebot','applebot',
    'facebookexternalhit','twitterbot','linkedinbot','embedly',
    'quora link preview','showyoubot','outbrain','pinterest',
    'vkshare','w3c_validator'
  ];
  const ua = (userAgent || '').toLowerCase();
  return bots.some(b => ua.includes(b));
}
function isTikTokInAppBrowser(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  return ua.includes('tiktok') || ua.includes('musically');
}
function isInstagramInAppBrowser(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  const patterns = ['instagram','fban/instagram','fb_iab','fbav','instagramapp','instagram 3','version/0'];
  return patterns.some(p => ua.includes(p));
}
function isMissingUserAgent(userAgent) { return !userAgent || userAgent.trim() === ''; }
function isSuspiciousUserAgent(userAgent) {
  if (!userAgent) return true;
  const ua = userAgent.toLowerCase();
  const suspicious = [
    'python-requests','axios/','curl/','wget','node-fetch',
    'httpclient','java/','go-http','scrapy','spider','bot',
    'crawler','libwww','unknown','apache-httpclient','okhttp','httpx'
  ];
  return suspicious.some(p => ua.includes(p));
}

const userActions = {};
function trackUserAction(ip, action) {
  if (!userActions[ip]) userActions[ip] = [];
  userActions[ip].push({ action, timestamp: Date.now() });
}
function isSuspiciousBehavior(ip) {
  if (!userActions[ip]) return false;
  const actions = userActions[ip];
  const recent = actions.filter(a => Date.now() - a.timestamp < 10_000);
  return recent.length > 5;
}
function isBot(req) {
  const ua = req.headers['user-agent'];
  const ip = getRealIp(req);
  return (
    isMissingUserAgent(ua) ||
    isSearchEngine(ua) ||
    isSuspiciousUserAgent(ua) ||
    isSuspiciousBehavior(ip)
  );
}

// Reto JS para subir confianza de navegador real
const KNOWN_SEARCH_BOTS = [
  'googlebot','bingbot','slurp','duckduckbot','baiduspider','yandexbot','sogou','exabot',
  'facebot','facebookexternalhit','applebot','twitterbot','linkedinbot','embedly',
  'quora link preview','pinterest','vkshare','w3c_validator','semrushbot','ahrefsbot',
  'mj12bot','ccbot','dotbot','qwantify','redditbot','discordbot','telegrambot','petalbot'
];
const GENERIC_BOT_TOKENS = [
  'crawler','spider','bot','fetch','httpclient','apache-httpclient','libwww','python-requests',
  'axios/','curl/','wget','go-http','java/','scrapy','node-fetch','perl','php','httpx','okhttp'
];
const HEADLESS_HINTS = ['headlesschrome','puppeteer','playwright','phantomjs','electron','nwjs'];
const JS_CHALLENGE_COOKIE = 'js_challenge';
const JS_CHALLENGE_TTL_S  = 10 * 60;

function uaMatches(list, ua) { const s = String(ua || '').toLowerCase(); return list.some(t => s.includes(t)); }
function headerAnomalies(req) {
  let score = 0;
  const h = req.headers;
  const ua     = String(h['user-agent'] || '').toLowerCase();
  const accept = String(h['accept'] || '');
  const al     = String(h['accept-language'] || '');
  const enc    = String(h['accept-encoding'] || '');
  const secua  = String(h['sec-ch-ua'] || '');
  if (!ua || ua.length < 10) score += 2;
  if (!accept.includes('text/html') && !accept.includes('*/*')) score += 1;
  if (!al) score += 0.5;
  if (!enc) score += 0.5;
  if (!secua) score += 0.5;
  if (HEADLESS_HINTS.some(t => ua.includes(t))) score += 2;
  return score;
}
function recentBurstPenalty(req) {
  const now = Date.now();
  const arr = hitsIdentity.get(identityKey(req)) || [];
  const last = arr.filter(t => now - t <= BURST_WIN_MS).length;
  return last > BURST_MAX ? 3 : last >= Math.ceil(BURST_MAX*0.75) ? 1 : 0;
}
function botScore(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  let score = 0;
  if (uaMatches(KNOWN_SEARCH_BOTS, ua))  score += 6;
  if (uaMatches(GENERIC_BOT_TOKENS, ua)) score += 3;
  score += headerAnomalies(req);
  score += recentBurstPenalty(req);
  return score;
}

const BOT_BLOCK_THRESHOLD     = Number(process.env.BOT_BLOCK_THRESHOLD ?? 10);
const BOT_CHALLENGE_THRESHOLD = Number(process.env.BOT_CHALLENGE_THRESHOLD ?? 7);
const PATH_OK_FOR_BOTS = /^\/(clook|public|assets|favicon\.ico|robots\.txt|ping|admin|api|challenge|instructions|searchEngine|loading|secret)/i;

app.get('/challenge', (req, res) => {
  const back = req.query.back || '/';
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Verificación</title></head>
<body style="font-family:system-ui;background:#0b0f14;color:#e7f0f7">
  <p>Verificando tu navegador…</p>
  <script>
    try {
      document.cookie = "${JS_CHALLENGE_COOKIE}=1; path=/; max-age=${JS_CHALLENGE_TTL_S}; samesite=Lax";
      location.replace(${JSON.stringify(back)});
    } catch(e) { document.body.innerHTML = "<h1>Enable JavaScript</h1>"; }
  </script>
  <noscript><h1>Enable JavaScript</h1></noscript>
</body></html>`);
});

function botShield(req, res, next) {
  const score = botScore(req);
  if (score >= BOT_BLOCK_THRESHOLD && !PATH_OK_FOR_BOTS.test(req.path)) {
    return res.status(403).send('Forbidden');
  }
  const hasJS = Boolean(req.cookies[JS_CHALLENGE_COOKIE]);
  if (score >= BOT_CHALLENGE_THRESHOLD && !hasJS && !PATH_OK_FOR_BOTS.test(req.path)) {
    const back = encodeURIComponent(req.originalUrl || req.url || '/');
    return res.redirect(302, `/challenge?back=${back}`);
  }
  next();
}
app.use(botShield);

// -------------------------------------------
// Middlewares captcha/honeypot (tuyos)
// -------------------------------------------
function captchaMiddleware(req, res, next) {
  const ip = getRealIp(req);
  if (isSuspiciousBehavior(ip)) return res.render('captcha');
  next();
}
app.use(captchaMiddleware);

function honeypotMiddleware(req, res, next) {
  if (req.body && req.body.honeypot) {
    console.log('Honeypot triggered → bot');
    return res.status(204).end();
  }
  next();
}
app.use(honeypotMiddleware);

// -------------------------------------------
// ADMIN: Generador de link
// -------------------------------------------
app.get('/admin/new', (_req, res) => {
  res.type('html').send(`
    <html><body style="font-family: system-ui; max-width:680px; margin:24px auto;">
      <h1>Generar link</h1>
      <form method="POST" action="/admin/new">
        <label>Slug (id): <input name="slug" required pattern="[a-zA-Z0-9_-]{3,}"/></label><br/><br/>
        <label>Nombre visible: <input name="display_name" required /></label><br/><br/>
        <label>Campo destino:
          <select name="field">
            <option value="instagram">instagram</option>
            <option value="onlyfans">onlyfans</option>
            <option value="tiktok">tiktok</option>
          </select>
        </label><br/><br/>
        <label>URL destino (https://...): <input name="target_url" required style="width:100%"/></label><br/><br/>
        <button type="submit">Crear</button>
      </form>
      <p style="margin-top:16px;"><a href="/admin/list">Ver listado</a></p>
    </body></html>
  `);
});

app.post('/admin/new', async (req, res) => {
  try {
    const slug = String(req.body.slug || '').trim();
    const displayName = String(req.body.display_name || '').trim();
    const field = String(req.body.field || DEFAULT_LINK_FIELD).toLowerCase();
    const targetUrl = String(req.body.target_url || '').trim();

    if (!/^[a-zA-Z0-9_-]{3,}$/.test(slug)) {
      return res.status(400).send('Slug inválido (mín 3, alfanumérico, _ o -)');
    }
    if (!ALLOWED_FIELDS.has(field)) {
      return res.status(400).send('Campo destino inválido');
    }
    if (!isSafeHttpUrl(targetUrl)) {
      return res.status(400).send('URL destino inválida (http/https requerido)');
    }

    const publicUrl = computePublicUrl(slug);

    const insertObj = {
      id: slug,
      name: displayName,
      public_url: publicUrl,
      instagram: null,
      onlyfans: null,
      tiktok: null
    };
    insertObj[field] = targetUrl;

    const { error } = await supabase
      .from('links')
      .upsert(insertObj, { onConflict: 'id' });

    if (error) {
      console.error('Error upsert links:', error.message);
      return res.status(500).send('No se pudo guardar el link');
    }

    linksCache.delete(slug);

    res.type('html').send(`
      <html><body style="font-family: system-ui; max-width:680px; margin:24px auto;">
        <h1>Creado ✅</h1>
        <p><b>Slug:</b> ${slug}</p>
        <p><b>Nombre:</b> ${displayName}</p>
        <p><b>Campo:</b> ${field}</p>
        <p><b>Destino:</b> <a href="${targetUrl}">${targetUrl}</a></p>
        <p><b>URL pública:</b> <a href="${publicUrl}">${publicUrl}</a></p>
        <p style="margin-top:16px;">
          <a href="/searchEngine/${slug}">Probar /searchEngine/${slug}</a> |
          <a href="/admin/new">Crear otro</a> |
          <a href="/admin/list">Ver listado</a>
        </p>
      </body></html>
    `);
  } catch (e) {
    console.error('POST /admin/new error:', e?.message || e);
    return res.status(500).send('Error interno');
  }
});

// Listado simple
app.get('/admin/list', async (_req, res) => {
  const { data, error } = await supabase
    .from('links')
    .select('id,name,instagram,onlyfans,tiktok,public_url')
    .order('id');

  if (error) return res.status(500).send('Error listando');

  const rows = (data || []).map(r => `
    <tr>
      <td>${r.id}</td>
      <td>${r.name || ''}</td>
      <td>${r.instagram || ''}</td>
      <td>${r.onlyfans || ''}</td>
      <td>${r.tiktok || ''}</td>
      <td>${r.public_url ? `<a href="${r.public_url}">${r.public_url}</a>` : ''}</td>
    </tr>`).join('');

  res.type('html').send(`
    <html><body style="font-family: system-ui; max-width:980px; margin:24px auto;">
      <h1>Links</h1>
      <p><a href="/admin/new">Crear nuevo</a></p>
      <table border="1" cellspacing="0" cellpadding="6">
        <thead><tr>
          <th>id (slug)</th><th>name</th><th>instagram</th><th>onlyfans</th><th>tiktok</th><th>public_url</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </body></html>
  `);
});

// -------------------------------------------
// SLUG router: compat → redirige a /searchEngine/<slug>
// -------------------------------------------
const RESERVED_PREFIXES = new Set([
  'clook', 'ping', 'c', 'instructions', 'searchengine', 'loading', 'secret',
  'favicon.ico', 'robots.txt', 'healthz', 'admin', 'private' // ← incluye private
]);
function looksLikeSlug(s) { return /^[a-zA-Z0-9_-]{3,}$/.test(s); }

app.get('/:slug', async (req, res, next) => {
  try {
    const slug = (req.params.slug || '').trim();
    const low = slug.toLowerCase();
    if (RESERVED_PREFIXES.has(low)) return next();
    if (!looksLikeSlug(slug)) return next();

    await ensurePublicUrlPersisted(slug);
    return res.redirect(302, `/searchEngine/${slug}`);
  } catch (e) {
    console.error('Error en slug router:', e?.message || e);
    return res.status(500).send('Error interno');
  }
});

// -------------------------------------------
// Rutas originales (tu flujo de vistas)
// -------------------------------------------
app.get("/", async (req, res) => {
  const links = await getLinks();
  const defaultId = Object.keys(links)[0] || "default";
  return res.redirect(`/instructions/${defaultId}`);
});

app.get("/c/:id", async (req, res) => {
  const links = await getLinks();
  const id = req.params.id;
  if (!links[id]) return res.status(404).send("Invalid link");
  return res.redirect(`/instructions/${id}`);
});

app.get('/instructions/:id', async (req, res) => {
  const links = await getLinks();
  const id = req.params.id;
  const model = links[id];
  if (!model) return res.status(404).send("Invalid link");

  const ip = getRealIp(req);
  trackUserAction(ip, 'visit_instructions');

  const ua = req.headers['user-agent'] || '';
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);

  if ((isTikTokInAppBrowser(ua) || isInstagramInAppBrowser(ua)) && isMobile) {
    return res.render('instructions', { id });
  }
  return res.redirect(`/searchEngine/${id}`);
});

app.get('/searchEngine/:id', async (req, res) => {
  const links = await getLinks();
  const id = req.params.id;
  const model = links[id];
  if (!model) return res.status(404).send("Invalid link");

  const ip = getRealIp(req);
  trackUserAction(ip, 'visit_searchEngine');

  return res.render('searchEngine', { id, model });
});

app.get('/loading/:id', async (req, res) => {
  const links = await getLinks();
  const id = req.params.id;
  const model = links[id];
  if (!model) return res.status(404).send("Invalid link");

  const ip = getRealIp(req);
  trackUserAction(ip, 'visit_loading');

  const ua = req.headers['user-agent'] || '';
  if (isBot(req) || isTikTokInAppBrowser(ua) || isInstagramInAppBrowser(ua)) {
    return res.redirect('https://instagram.com/tu_perfil');
  }
  return res.render('loading', { id });
});

app.get('/secret/:id', async (req, res) => {
  const links = await getLinks();
  const id = req.params.id;
  const model = links[id];
  if (!model) return res.status(404).send("Invalid link");

  const ip = getRealIp(req);
  trackUserAction(ip, 'visit_secret');

  const ua = req.headers['user-agent'] || '';

  // Bot shield final (incluye reto JS si aplica)
  const score  = botScore(req);
  const hasJS  = Boolean(req.cookies['js_challenge']);
  if (isTikTokInAppBrowser(ua) || isInstagramInAppBrowser(ua)) {
    // En IAB bloqueamos/mandamos a Instagram perfil
    return res.redirect('https://instagram.com/tu_perfil');
  }
  if (score >= BOT_BLOCK_THRESHOLD) {
    return res.status(403).send('Forbidden');
  }
  if (score >= BOT_CHALLENGE_THRESHOLD && !hasJS) {
    const back = encodeURIComponent(req.originalUrl || req.url || '/');
    return res.redirect(302, `/challenge?back=${back}`);
  }

  return res.redirect(model.onlyfans);
});

// Health
app.get('/ping', (req, res) => res.status(200).send('pong'));

// Debug de límites (activar con DEBUG_RATE=1)
if (String(process.env.DEBUG_RATE || '0') === '1') {
  app.get('/debug/rate', (req, res) => {
    const now = Date.now();
    const ip  = getRealIp(req);
    const id  = identityKey(req);
    const idArr = (hitsIdentity.get(id) || []).filter(t => now - t <= RL_WIN_MS);
    const ipArr = (hitsIp.get(ip) || []).filter(t => now - t <= RL_WIN_MS);
    res.json({
      ip,
      identity: id,
      lastMin: {
        identityHits: idArr.length,
        ipHits: ipArr.length,
        globalHits: hitsGlobal.filter(t => now - t <= RL_WIN_MS).length
      }
    });
  });
}

// -------------------------------------------
app.listen(port, () => console.log(`Server running on port ${port}`));
