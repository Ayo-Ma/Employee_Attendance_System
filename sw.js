/**
 * Service worker: makes the app installable and lets it open instantly.
 * The app's own files are served from the phone and refreshed in the
 * background, so a new version shows up the next time the app is opened.
 * Requests to the Google Sheet are never touched or stored.
 */
const CACHE = 'pdn-app-v1';

const SHELL = [
    './',
    'index.html',
    'manifest.webmanifest',
    'css/style.css',
    'css/print.css',
    'js/config.js',
    'js/util.js',
    'js/qrCodeLib.js',
    'js/soundFX.js',
    'js/storage.js',
    'js/sheetsSync.js',
    'js/appsScript.js',
    'js/clockEngine.js',
    'js/badges.js',
    'js/qrScanner.js',
    'js/app.js',
    'icons/icon-192.png',
    'icons/icon-512.png'
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const ownFile = url.origin === self.location.origin;
    if (!ownFile && !FONT_HOSTS.includes(url.hostname)) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request, { ignoreSearch: ownFile && request.mode === 'navigate' });

        const refresh = fetch(request)
            .then(response => {
                if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
                return response;
            })
            .catch(() => null);

        // Fonts never change: use the stored copy and skip the network
        if (cached && !ownFile) return cached;

        if (cached) {
            event.waitUntil(refresh);
            return cached;
        }
        return (await refresh) || new Response('Offline', { status: 503, statusText: 'Offline' });
    })());
});
