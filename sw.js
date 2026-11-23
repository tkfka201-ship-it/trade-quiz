/* sw.js — offline shell of the practice app.
   Keeps only the page (index.html) and its hashed assets, so the app opens without a connection.
   data/ is never touched here: the app fetches it itself and keeps its own copy in localStorage.
   build.py app fills in the build id and the asset list below; a new build changes this file, so phones pick it up. */
'use strict';
var BUILD = '8a3d63da81';
var ASSETS = ["assets/app.e7c32d07.css", "assets/core.e89d92f4.js", "assets/app.4e36dcc2.js"];
var PREFIX = 'tq-shell-';
var CACHE = PREFIX + BUILD;
var PAGE = './';
var WAIT_MS = 4000;   // slower than this (subway) -> open the saved page; the network copy still refreshes it
var ASSET_RE = /^assets\/[A-Za-z0-9_-]+\.[0-9a-f]{8}\.(?:css|js)$/;

self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll([PAGE].concat(ASSETS).map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function inScope(url) {
  var base = new URL(self.registration.scope);
  if (url.origin !== base.origin || url.pathname.indexOf(base.pathname) !== 0) return null;
  return url.pathname.slice(base.pathname.length);
}

// Save a fresh page only after every asset it names is saved, so the saved page never points at a missing file.
function savePage(res) {
  return res.clone().text().then(function (html) {
    var urls = [], re = /(?:href|src)="(assets\/[^"]+)"/g, m;
    while ((m = re.exec(html))) urls.push(m[1]);
    return caches.open(CACHE).then(function (c) {
      return Promise.all(urls.map(function (u) {
        return c.match(u).then(function (hit) { return hit || c.add(new Request(u, { cache: 'reload' })); });
      })).then(function () { return c.put(PAGE, res); });
    });
  });
}

// Network first; offline, slow or a server error -> the saved page. No saved page yet -> whatever the network gives.
function page(ev) {
  var net = fetch(ev.request);
  var good = net.then(function (res) {
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    return res;
  });
  // registered before the race below, so the copy is taken before the page body is handed over
  ev.waitUntil(good.then(function (res) { return res.type === 'basic' ? savePage(res.clone()) : null; })
    .catch(function () {}));
  var late = new Promise(function (resolve, reject) { setTimeout(function () { reject(new Error('slow')); }, WAIT_MS); });
  return Promise.race([good, late]).catch(function () {
    return caches.open(CACHE).then(function (c) { return c.match(PAGE); }).then(function (hit) { return hit ? plain(hit) : net; });
  });
}

// A navigation may not be answered with a response that was redirected; hand over a plain copy instead.
function plain(res) {
  if (!res.redirected) return res;
  return res.blob().then(function (body) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}

function asset(req) {
  return caches.open(CACHE).then(function (c) {
    return c.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') c.put(req, res.clone());
        return res;
      });
    });
  });
}

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var path = inScope(new URL(req.url));
  if (path === null) return;
  if (req.mode === 'navigate' && (path === '' || path === 'index.html')) { ev.respondWith(page(ev)); return; }
  if (ASSET_RE.test(path)) { ev.respondWith(asset(req)); return; }
  // everything else (data/, manifest, icons, this file) goes to the network exactly as without a service worker
});
