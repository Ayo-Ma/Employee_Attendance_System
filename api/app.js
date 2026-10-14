/**
 * The app's one server endpoint (a Vercel function): POST /api/app
 * The browser sends { action, ... } and gets back { ok, ... }.
 */
const { handle } = require('./_lib/logic');

function readBody(req) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return Promise.resolve(parse(String(req.body)));
    return new Promise(resolve => {
        let text = '';
        req.on('data', chunk => {
            text += chunk;
            if (text.length > 2e6) req.destroy();
        });
        req.on('end', () => resolve(parse(text)));
        req.on('error', () => resolve(null));
    });
}

function parse(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        return null;
    }
}

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
    const body = req.method === 'POST' ? await readBody(req) : { action: 'ping' };

    const result = await handle(body, `${proto}://${host}`);
    res.statusCode = 200;
    res.end(JSON.stringify(result));
};
