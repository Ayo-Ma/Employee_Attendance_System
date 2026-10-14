/**
 * Minimal Firestore client over the REST API, signed with the service
 * account key. No dependencies, so the server functions start quickly.
 *
 * The key comes from the FIREBASE_SERVICE_ACCOUNT environment variable
 * (the whole JSON file as text). For local testing, FIREBASE_SERVICE_ACCOUNT_FILE
 * can point at the file instead.
 */
const crypto = require('crypto');
const fs = require('fs');

const PREFIX = process.env.PDN_PREFIX || '';   // lets tests use separate collections
let account = null;
let token = null;

function setupError(message) {
    const err = new Error(message);
    err.code = 'setup';
    return err;
}

function getAccount() {
    if (account) return account;
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw && process.env.FIREBASE_SERVICE_ACCOUNT_FILE) raw = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8');
    if (!raw) throw setupError('The server is missing its Firebase key. Add FIREBASE_SERVICE_ACCOUNT in Vercel (Settings › Environment Variables) and redeploy.');
    try {
        account = JSON.parse(raw);
    } catch (err) {
        throw setupError('The Firebase key in FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole contents of the downloaded key file.');
    }
    return account;
}

async function accessToken() {
    if (token && token.expires > Date.now() + 60000) return token.value;
    const acc = getAccount();
    const now = Math.floor(Date.now() / 1000);
    const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
        iss: acc.client_email,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(acc.private_key).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${signature}`
    });
    const data = await res.json();
    if (!data.access_token) throw setupError(`Firebase did not accept the key: ${data.error_description || data.error || res.status}`);
    token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    return token.value;
}

const root = () => `projects/${getAccount().project_id}/databases/(default)/documents`;
const docName = (collection, id) => `${root()}/${PREFIX}${collection}/${id}`;

// --- Converting between plain objects and Firestore's typed values ---
function encode(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    return { stringValue: String(value) };
}

function decodeValue(v) {
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    return null;
}

function fieldsOf(obj) {
    const fields = {};
    for (const key of Object.keys(obj)) {
        if (obj[key] !== undefined) fields[key] = encode(obj[key]);
    }
    return fields;
}

function decode(doc) {
    if (!doc || !doc.fields) return doc ? {} : null;
    const out = {};
    for (const key of Object.keys(doc.fields)) out[key] = decodeValue(doc.fields[key]);
    return out;
}

async function call(method, path, body) {
    const res = await fetch(`https://firestore.googleapis.com/v1/${path}`, {
        method,
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 404 && method === 'GET') return null;
    const data = await res.json();
    if (!res.ok) {
        const err = new Error((data.error && data.error.message) || `Firestore error ${res.status}`);
        err.status = data.error && data.error.status;
        throw err;
    }
    return data;
}

// --- Reads ---
async function get(collection, id, tx) {
    const query = tx ? `?transaction=${encodeURIComponent(tx)}` : '';
    return decode(await call('GET', `${docName(collection, id)}${query}`));
}

// Several documents of one collection in one request; missing ones are left out
async function getMany(collection, ids, tx) {
    if (!ids.length) return {};
    const body = { documents: ids.map(id => docName(collection, id)) };
    if (tx) body.transaction = tx;
    const results = await call('POST', `${root()}:batchGet`, body);
    const out = {};
    results.forEach(r => {
        if (r.found) out[r.found.name.split('/').pop()] = decode(r.found);
    });
    return out;
}

const OPS = { '==': 'EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', '<': 'LESS_THAN' };

// filters: [['field', '==', value], ...]
async function query(collection, filters = [], tx) {
    const fieldFilters = filters.map(([field, op, value]) => ({
        fieldFilter: { field: { fieldPath: field }, op: OPS[op], value: encode(value) }
    }));
    const structuredQuery = { from: [{ collectionId: PREFIX + collection }] };
    if (fieldFilters.length === 1) structuredQuery.where = fieldFilters[0];
    if (fieldFilters.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters: fieldFilters } };
    const body = { structuredQuery };
    if (tx) body.transaction = tx;
    const rows = await call('POST', `${root()}:runQuery`, body);
    return rows.filter(r => r.document).map(r => decode(r.document));
}

// --- Writes ---
const set = (collection, id, obj) => ({ update: { name: docName(collection, id), fields: fieldsOf(obj) } });
const create = (collection, id, obj) => ({ ...set(collection, id, obj), currentDocument: { exists: false } });
const patch = (collection, id, obj) => ({ ...set(collection, id, obj), updateMask: { fieldPaths: Object.keys(obj) } });
const remove = (collection, id) => ({ delete: docName(collection, id) });

async function commit(writes, tx) {
    for (let i = 0; i < writes.length || (tx && i === 0); i += 400) {
        const body = { writes: writes.slice(i, i + 400) };
        if (tx) body.transaction = tx;
        await call('POST', `${root()}:commit`, body);
        if (tx) break;
    }
}

// Run `work(tx, writes)` as one all-or-nothing transaction, retrying on conflicts
async function transaction(work) {
    for (let attempt = 0; ; attempt++) {
        const { transaction: tx } = await call('POST', `${root()}:beginTransaction`, { options: { readWrite: {} } });
        try {
            const writes = [];
            const result = await work(tx, writes);
            await commit(writes, tx);
            return result;
        } catch (err) {
            await call('POST', `${root()}:rollback`, { transaction: tx }).catch(() => {});
            if (err.status === 'ABORTED' && attempt < 4) continue;
            throw err;
        }
    }
}

module.exports = { get, getMany, query, set, create, patch, remove, commit, transaction, getAccount, PREFIX };
