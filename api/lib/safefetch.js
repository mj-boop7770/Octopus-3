// api/lib/safefetch.js
// Lecture de pages web SANS risque SSRF : un modèle (ou une page piégée) ne doit jamais pouvoir
// faire lire à ton serveur une adresse interne (localhost, réseau privé, métadonnées cloud…).
//
// - l'adresse IP est vérifiée au moment de la connexion (hook `lookup`), ce qui bloque aussi
//   les attaques par « DNS rebinding » ;
// - chaque redirection est revérifiée ; ports 80/443 uniquement ; taille et durée limitées.

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

function isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIp(ip) {
  const clean = String(ip || '').replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(clean);
  if (family === 4) return isPrivateIpv4(clean);
  if (family === 6) {
    const l = clean.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateIpv4(mapped[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
      return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b') || l.startsWith('2001:db8');
  }
  return true; // pas une IP valide : on refuse par prudence
}

function makeLookup(allowPrivate) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    dns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return cb(error);
      const allowed = addresses.filter(a => allowPrivate || !isPrivateIp(a.address));
      if (!allowed.length) return cb(new Error('adresse non autorisée'));
      if (opts.all) return cb(null, allowed);
      return cb(null, allowed[0].address, allowed[0].family);
    });
  };
}

function fetchSafe(urlString, { allowPrivate = false, timeoutMs = 10000, maxBytes = 600000, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (e) { return reject(new Error('URL invalide')); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Error('seuls http et https sont autorisés'));
    if (url.username || url.password) return reject(new Error('URL avec identifiants refusée'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate) {
      const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
      if (port !== 80 && port !== 443) return reject(new Error('port non autorisé'));
      if (net.isIP(host) && isPrivateIp(host)) return reject(new Error('adresse non autorisée'));
      if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return reject(new Error('adresse non autorisée'));
    }

    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };

    const req = lib.request(url, {
      method: 'GET',
      lookup: makeLookup(allowPrivate),
      headers: {
        'User-Agent': 'Octopus/3 (lecteur de pages)',
        Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'identity'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return finish(reject, new Error('trop de redirections'));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return finish(reject, new Error('redirection invalide')); }
        return fetchSafe(next, { allowPrivate, timeoutMs, maxBytes, maxRedirects: maxRedirects - 1 }).then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error)
        );
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes))); res.destroy(); return; }
        chunks.push(chunk);
      });
      const done = () => finish(resolve, {
        status,
        contentType: String(res.headers['content-type'] || ''),
        text: Buffer.concat(chunks).toString('utf8'),
        finalUrl: url.toString()
      });
      res.on('end', done);
      res.on('close', done);
      res.on('error', (error) => finish(reject, error));
    });

    const timer = setTimeout(() => { req.destroy(); finish(reject, new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s)`)); }, timeoutMs);
    req.on('error', (error) => finish(reject, error));
    req.end();
  });
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 31 && c < 65536 ? String.fromCharCode(c) : ' '; });
}

function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { title: decodeEntities(title).replace(/\s+/g, ' ').trim(), text: body };
}

module.exports = { fetchSafe, isPrivateIp, htmlToText };
