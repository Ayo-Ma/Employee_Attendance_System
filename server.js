/**
 * Optional zero-dependency local server.
 * Run with: node server.js
 * Lets phones and tablets on the same Wi-Fi open the app from this computer.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const BASE_DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    let reqPath;
    try {
        reqPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('400 Bad Request');
    }
    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

    const filePath = path.join(BASE_DIR, reqPath);

    // Only serve files inside this folder, and only known web file types
    const inside = filePath === BASE_DIR || filePath.startsWith(BASE_DIR + path.sep);
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()];
    if (!inside || !contentType || reqPath.includes('/_backup-original/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('PDN Attendance is running.');
    console.log(`  This computer:  http://localhost:${PORT}`);

    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`  Phones/tablets: http://${net.address}:${PORT}  (same Wi-Fi)`);
            }
        }
    }
    console.log('Note: phone browsers only allow the camera over HTTPS. On phones, use "My time card" or tap a name.');
});
