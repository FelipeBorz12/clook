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

app.use(express.static(path.join(process.cwd(), 'public'))); 

// -------------------------------------------
// Config
// -------------------------------------------
app.set('trust proxy', true);

const REMOVE_WWW = String(process.env.REMOVE_WWW || 'true') === 'true';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 300000);
const DEFAULT_LINK_FIELD = (process.env.DEFAULT_LINK_FIELD || 'instagram').toLowerCase();
const SLUG_FORWARD_MODE = (process.env.SLUG_FORWARD_MODE || 'exact').toLowerCase(); // exact | append_path
const BASE_PUBLIC_URL = (process.env.BASE_PUBLIC_URL || 'http://127.0.0.1:3000').replace(/\/+$/,'');

const ALLOWED_FIELDS = new Set(['instagram', 'onlyfans', 'tiktok']);

function normalizeHost(rawHostHeader = '') {
  const host = String(rawHostHeader || '').toLowerCase().split(':')[0].trim();
  if (!host) return '';
  if (REMOVE_WWW && host.startsWith('www.')) return host.slice(4);
  return host;
}
function getRealIp(req) {
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
// el link público apunta a /searchEngine/<slug>
function computePublicUrl(slug) {
  return `${BASE_PUBLIC_URL}/searchEngine/${slug}`;
}

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
const linksCache = new Map(); // key: link_id, value: { row, exp }
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
  data.forEach(row => {
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
// Bot / UA / Rate limit (tu lógica original)
// -------------------------------------------
const requestTimes = {};
const MAX_REQUESTS = 50;
const TIME_WINDOW = 60000;

function rateLimiter(req, res, next) {
  const ip = getRealIp(req);
  const sessionId = req.sessionId || 'anon';
  const key = `${ip}_${sessionId}`;
  const now = Date.now();

  if (!requestTimes[key]) requestTimes[key] = [];
  requestTimes[key] = requestTimes[key].filter(t => now - t < TIME_WINDOW);

  if (requestTimes[key].length >= MAX_REQUESTS) {
    return res.status(429).send('Too Many Requests');
  }
  requestTimes[key].push(now);
  next();
}

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
    'crawler','libwww','unknown','apache-httpclient'
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
  const recent = actions.filter(a => Date.now() - a.timestamp < 10000);
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

// -------------------------------------------
// Middlewares de sesión, rate-limit, captcha, honeypot
// -------------------------------------------
app.use((req, res, next) => {
  if (!req.cookies.sessionId) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie('sessionId', sessionId, { httpOnly: true });
    req.sessionId = sessionId;
  } else {
    req.sessionId = req.cookies.sessionId;
  }
  next();
});
app.use(rateLimiter);

function captchaMiddleware(req, res, next) {
  const ip = getRealIp(req);
  if (isSuspiciousBehavior(ip)) return res.render('captcha');
  next();
}
app.use(captchaMiddleware);

function honeypotMiddleware(req, res, next) {
  if (req.body && req.body.honeypot) {
    console.log('Honeypot triggered → bot');
    return res.render('searchEngine', { id: 'bot', model: {} });
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

    // PUBLIC URL automático apuntando a /searchEngine/<slug>
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

    // Asegura que public_url está correcto (con /searchEngine/)
    await ensurePublicUrlPersisted(slug);

    // Compatibilidad: manda al flujo de la app
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
  if (isBot(req) || isTikTokInAppBrowser(ua) || isInstagramInAppBrowser(ua)) {
    return res.redirect('https://instagram.com/tu_perfil');
  }
  return res.redirect(model.onlyfans);
});

// Health
app.get('/ping', (req, res) => res.status(200).send('pong'));

// -------------------------------------------
app.listen(port, () => console.log(`Server running on port ${port}`));
