/**
 * PDN Attendance server rules.
 * Every request from the app comes through here. This is where sign-in,
 * PINs, supervisor rights, the office-location rule and punch times are
 * enforced; the app in the browser cannot get around them.
 *
 * Firestore collections:
 *   staff/{id}       people, their access level and PIN hash
 *   records/{id}     attendance entries
 *   deleted/{key}    notes of deletions, so other devices and the sheet can follow
 *   config/settings  clock-in rules     config/secret  signing secret
 *   config/mirror    Google Sheet copy  throttle/{id}  wrong-PIN counter
 */
const crypto = require('crypto');
const db = require('./firestore');
const { sheetScript } = require('./sheetScript');

const VERSION = 5;
const TOKEN_DAYS = 90;          // how long a phone stays signed in
const MAX_TRIES = 5;            // wrong PINs before a short lock
const LOCK_MINUTES = 10;
const UNDO_SECONDS = 120;       // how long staff can undo their own punch
const MAX_SHIFT_HOURS = 18;
const OVERLAP_MS = 5000;        // changes are re-sent across this margin so none slip between two syncs
const SAFE_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['CLOCKED_IN', 'COMPLETED', 'MISSED'];
const SETTING_DEFAULTS = { geoOn: false, lat: null, lng: null, radius: 200, kioskPin: true, timeZone: 'UTC' };

class Refusal extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const refuse = (code, message) => { throw new Refusal(code, message); };

// ------------------------------------------------------------------ secrets

let secretValue = null;

async function secret() {
    if (secretValue) return secretValue;
    let doc = await db.get('config', 'secret');
    if (!doc) {
        try {
            await db.commit([db.create('config', 'secret', { value: crypto.randomBytes(32).toString('hex') })]);
        } catch (err) { /* created at the same moment by another request */ }
        doc = await db.get('config', 'secret');
    }
    secretValue = doc.value;
    return secretValue;
}

const validPin = pin => /^[0-9]{4}$/.test(String(pin || ''));
const hashPin = (key, id, pin) => crypto.createHash('sha256').update(`${key}|${id}|${pin}`).digest('hex');
const sign = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');

// A sign-in token is tied to the person's current PIN, so resetting the PIN signs their devices out
function tokenFor(key, emp) {
    const body = `${emp.id}.${Date.now() + TOKEN_DAYS * 86400000}`;
    return `${body}.${sign(key, `${body}.${emp.pinHash}`)}`;
}

async function whoami(key, token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !SAFE_ID.test(parts[0]) || !(Number(parts[1]) > Date.now())) return null;
    const emp = await db.get('staff', parts[0]);
    if (!emp || !emp.pinHash) return null;
    const expected = sign(key, `${parts[0]}.${parts[1]}.${emp.pinHash}`);
    const a = Buffer.from(expected), b = Buffer.from(parts[2]);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? emp : null;
}

async function checkPin(key, emp, pin) {
    const now = Date.now();
    const throttle = (await db.get('throttle', emp.id)) || { tries: 0, lastAt: 0 };
    const recent = now - throttle.lastAt < LOCK_MINUTES * 60000;
    if (recent && throttle.tries >= MAX_TRIES) {
        refuse('locked', `Too many wrong PINs. Wait ${LOCK_MINUTES} minutes, or ask a supervisor to reset it.`);
    }
    if (!emp.pinHash) refuse('nopin', `No PIN has been set for ${emp.name} yet. Ask a supervisor.`);
    if (!validPin(pin) || hashPin(key, emp.id, pin) !== emp.pinHash) {
        await db.commit([db.set('throttle', emp.id, { tries: (recent ? throttle.tries : 0) + 1, lastAt: now })]);
        refuse('pin', 'Wrong PIN.');
    }
    if (throttle.tries) await db.commit([db.remove('throttle', emp.id)]);
}

// ------------------------------------------------------------------ shaping data

function publicEmployee(e) {
    return {
        id: e.id, name: e.name, role: e.role || '', department: e.department || '',
        badgeCode: e.badgeCode || e.id, avatarColor: e.avatarColor || '#3b2fc9',
        updatedAt: e.updatedAt || 0, access: e.access === 'supervisor' ? 'supervisor' : 'staff', hasPin: !!e.pinHash
    };
}

function publicRecord(r, now = Date.now()) {
    let status = r.status;
    // A shift nobody clocked out of stops counting as "in" after MAX_SHIFT_HOURS
    if (status === 'CLOCKED_IN' && !r.departureIso && now - new Date(r.arrivalIso).getTime() >= MAX_SHIFT_HOURS * 3600000) status = 'MISSED';
    return {
        id: r.id, employeeId: r.employeeId, employeeName: r.employeeName, date: r.date,
        arrivalIso: r.arrivalIso, departureIso: r.departureIso || null, status,
        method: r.method || '', notes: r.notes || '', updatedAt: r.updatedAt || 0
    };
}

async function loadSettings() {
    return { ...SETTING_DEFAULTS, ...((await db.get('config', 'settings')) || {}) };
}

function localDate(date, timeZone) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    } catch (err) {
        return date.toISOString().slice(0, 10);
    }
}

const validZone = zone => {
    if (typeof zone !== 'string' || !zone) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
    } catch (err) {
        return false;
    }
};

// What a signed-in person may see. With a cursor, only what changed since then.
async function state(me, body) {
    const now = Date.now();
    const boss = me.access === 'supervisor';
    const cursor = Number(body.cursor) || 0;
    const since = DAY.test(body.since || '') ? body.since : localDate(new Date(now - 35 * 86400000), 'UTC');
    let records, employees, deleted = [];
    // Settings (and, for supervisors, the sheet-copy status) load alongside the data
    const extras = Promise.all([loadSettings(), boss ? db.get('config', 'mirror') : Promise.resolve(null)]);

    if (!cursor) {
        records = boss
            ? await db.query('records', [['date', '>=', since]])
            : (await db.query('records', [['employeeId', '==', me.id]])).filter(r => r.date >= since);
        employees = boss ? await db.query('staff') : [me];
    } else {
        const from = cursor - OVERLAP_MS;
        const [changed, changedStaff, gone] = await Promise.all([
            db.query('records', [['sv', '>', from]]),
            boss ? db.query('staff', [['sv', '>', from]]) : Promise.resolve((me.sv || 0) > from ? [me] : []),
            db.query('deleted', [['sv', '>', from]])
        ]);
        records = boss ? changed : changed.filter(r => r.employeeId === me.id);
        employees = changedStaff;
        deleted = gone
            .filter(d => boss || (d.type === 'record' && d.employeeId === me.id))
            .map(d => ({ type: d.type, id: d.id }));
    }

    const [settings, mirrorDoc] = await extras;
    const shared = boss
        ? { ...settings, mirrorAt: (mirrorDoc || {}).lastPullAt || null }
        : { geoOn: settings.geoOn, kioskPin: settings.kioskPin };

    return {
        me: { id: me.id, name: me.name, access: me.access === 'supervisor' ? 'supervisor' : 'staff' },
        full: !cursor,
        cursor: now,
        employees: employees.map(publicEmployee),
        records: records.map(r => publicRecord(r, now)),
        deleted,
        settings: shared
    };
}

async function session(key, emp, body) {
    const res = await state(emp, { since: body.since });
    res.token = tokenFor(key, emp);
    return res;
}

const supervisorsWithPin = async () => (await db.query('staff', [['access', '==', 'supervisor']])).filter(e => e.pinHash);

// ------------------------------------------------------------------ location

function checkPlace(settings, geo) {
    if (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number') {
        refuse('geo', 'Your location is needed to clock in. Allow location for this site and try again.');
    }
    const accuracy = Number(geo.acc) || 0;
    if (accuracy > 1000) refuse('geo', 'Your phone could not get a precise location. Turn on GPS, step near a window and try again.');
    const rad = Math.PI / 180;
    const dLat = (geo.lat - settings.lat) * rad;
    const dLng = (geo.lng - settings.lng) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(settings.lat * rad) * Math.cos(geo.lat * rad) * Math.sin(dLng / 2) ** 2;
    const metres = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (metres <= Number(settings.radius) + Math.min(accuracy, 150)) return;
    const far = metres >= 1000 ? `${Math.round(metres / 100) / 10} km` : `${Math.round(metres / 10) * 10} m`;
    refuse('geo', `You are about ${far} from the office. You can clock in and out when you are there.`);
}

// ------------------------------------------------------------------ punches

// The server decides clock-in or clock-out and stamps the time itself,
// inside a transaction so two quick taps can never open two shifts.
async function punch(target, method, settings) {
    return db.transaction(async (tx, writes) => {
        const now = Date.now();
        const open = (await db.query('records', [['employeeId', '==', target.id], ['status', '==', 'CLOCKED_IN']], tx))
            .filter(r => !r.departureIso && now - new Date(r.arrivalIso).getTime() < MAX_SHIFT_HOURS * 3600000)
            .sort((a, b) => b.arrivalIso.localeCompare(a.arrivalIso))[0];
        const iso = new Date(now).toISOString();

        if (!open) {
            const id = `punch-${crypto.randomBytes(6).toString('hex')}`;
            writes.push(db.set('records', id, {
                id, employeeId: target.id, employeeName: target.name,
                date: localDate(new Date(now), settings.timeZone),
                arrivalIso: iso, departureIso: null, status: 'CLOCKED_IN',
                method, notes: '', updatedAt: now, sv: now
            }));
            return { action: 'in', recordId: id, employeeId: target.id, at: iso };
        }

        writes.push(db.patch('records', open.id, { departureIso: iso, status: 'COMPLETED', updatedAt: now, sv: now }));
        return { action: 'out', recordId: open.id, employeeId: target.id, at: iso };
    });
}

function tombstone(type, id, employeeId) {
    return db.set('deleted', `${type}_${id}`, { type, id, employeeId: employeeId || '', sv: Date.now() });
}

// ------------------------------------------------------------------ supervisor edits

function cleanRecord(d) {
    if (!d || !SAFE_ID.test(d.id || '') || !SAFE_ID.test(d.employeeId || '') || !DAY.test(d.date || '')) return null;
    if (isNaN(new Date(d.arrivalIso))) return null;
    if (d.departureIso && isNaN(new Date(d.departureIso))) return null;
    return {
        id: d.id, employeeId: d.employeeId, employeeName: String(d.employeeName || '').slice(0, 80), date: d.date,
        arrivalIso: new Date(d.arrivalIso).toISOString(),
        departureIso: d.departureIso ? new Date(d.departureIso).toISOString() : null,
        status: STATUSES.includes(d.status) ? d.status : (d.departureIso ? 'COMPLETED' : 'CLOCKED_IN'),
        method: String(d.method || 'MANUAL').slice(0, 30), notes: String(d.notes || '').slice(0, 200),
        updatedAt: Number(d.updatedAt) || 0
    };
}

async function applyItems(items) {
    const now = Date.now();
    const ok = items.filter(it => it && ['record', 'employee'].includes(it.type) && ['upsert', 'delete'].includes(it.op) && SAFE_ID.test(it.id || ''));
    const recordIds = ok.filter(it => it.type === 'record').map(it => it.id);
    const staffIds = ok.filter(it => it.type === 'employee').map(it => it.id);
    const [records, staff] = await Promise.all([db.getMany('records', recordIds), db.getMany('staff', staffIds)]);
    const writes = [];
    let bosses = null;

    for (const it of ok) {
        const existing = (it.type === 'record' ? records : staff)[it.id];
        const stamp = Number(it.data && it.data.updatedAt) || 0;

        if (it.op === 'delete') {
            if (!existing) continue;
            if (it.type === 'employee' && existing.access === 'supervisor') {
                bosses = bosses || await supervisorsWithPin();
                if (!bosses.some(b => b.id !== it.id)) continue;   // the last supervisor stays
                bosses = bosses.filter(b => b.id !== it.id);
            }
            writes.push(db.remove(it.type === 'record' ? 'records' : 'staff', it.id));
            writes.push(tombstone(it.type, it.id, it.type === 'record' ? existing.employeeId : ''));
            continue;
        }

        // A newer edit from another device wins
        if (existing && (existing.updatedAt || 0) > stamp) continue;

        if (it.type === 'record') {
            const rec = cleanRecord({ ...it.data, id: it.id });
            if (rec) writes.push(db.set('records', it.id, { ...rec, sv: now }));
        } else {
            const d = it.data || {};
            if (!String(d.name || '').trim()) continue;
            // Access and PIN are never taken from the app; they keep what the server already has
            writes.push(db.set('staff', it.id, {
                id: it.id, name: String(d.name).trim().slice(0, 80), role: String(d.role || '').slice(0, 80),
                department: String(d.department || '').slice(0, 80), badgeCode: SAFE_ID.test(d.badgeCode || '') ? d.badgeCode : it.id,
                avatarColor: /^#[0-9a-fA-F]{3,8}$/.test(d.avatarColor || '') ? d.avatarColor : '#3b2fc9',
                updatedAt: stamp, access: existing ? existing.access || 'staff' : 'staff',
                pinHash: existing ? existing.pinHash || '' : '', sv: now
            }));
        }
    }
    await db.commit(writes);
}

function nextId(staff) {
    const highest = staff.reduce((max, e) => Math.max(max, parseInt(String(e.id).replace(/\D/g, ''), 10) || 0), 1000);
    return `EMP-${highest + 1}`;
}

// ------------------------------------------------------------------ requests

async function handle(body, origin) {
    try {
        if (!body || typeof body !== 'object') refuse('error', 'The request was not understood.');
        const res = await route(body, origin || '');
        return { ok: true, version: VERSION, ...res };
    } catch (err) {
        if (err instanceof Refusal || err.code === 'setup') return { ok: false, version: VERSION, code: err.code, error: err.message };
        console.error('[PDN]', err);
        return { ok: false, version: VERSION, code: 'error', error: 'The server hit a problem. Try again in a moment.' };
    }
}

async function route(body, origin) {
    const action = body.action;
    if (action === 'ping') return {};
    if (action === 'mirror') return mirror(body);

    const key = await secret();

    // --- No sign-in needed ---
    if (action === 'roster') {
        const staff = await db.query('staff');
        return {
            needsSetup: !staff.some(e => e.access === 'supervisor' && e.pinHash),
            people: staff
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(e => ({ id: e.id, name: e.name, avatarColor: e.avatarColor || '#3b2fc9' }))
        };
    }

    if (action === 'setup') {
        if (!validPin(body.pin)) refuse('pin', 'Choose a PIN of exactly 4 digits.');
        const first = await db.transaction(async (tx, writes) => {
            const staff = await db.query('staff', [], tx);
            if (staff.some(e => e.access === 'supervisor' && e.pinHash)) refuse('forbidden', 'A supervisor already exists. Sign in instead.');
            const now = Date.now();
            let person = SAFE_ID.test(body.id || '') ? staff.find(e => e.id === body.id) : null;
            if (!person) {
                const name = String(body.name || '').trim().slice(0, 80);
                if (!name) refuse('setup', 'Enter your name.');
                const id = nextId(staff);
                person = { id, name, role: '', department: '', badgeCode: id, avatarColor: '#3b2fc9', updatedAt: now };
            }
            person = { ...person, access: 'supervisor', pinHash: hashPin(key, person.id, body.pin), sv: now };
            writes.push(db.set('staff', person.id, person));
            if (validZone(body.timeZone)) writes.push(db.patch('config', 'settings', { timeZone: body.timeZone }));
            return person;
        });
        return session(key, first, body);
    }

    if (action === 'login') {
        const person = SAFE_ID.test(body.id || '') ? await db.get('staff', body.id) : null;
        if (!person) refuse('auth', 'That person is no longer on the team.');
        await checkPin(key, person, body.pin);
        return session(key, person, body);
    }

    // --- Everything below needs a valid sign-in ---
    const me = await whoami(key, body.token);
    if (!me) refuse('auth', 'Please sign in again.');
    const boss = me.access === 'supervisor';

    if (action === 'sync') {
        if (boss && Array.isArray(body.items) && body.items.length) await applyItems(body.items.slice(0, 500));
        return state(me, body);
    }

    if (action === 'punch') {
        const settings = await loadSettings();
        let target = me;
        let method = 'PHONE';
        if (body.forId && body.forId !== me.id) {
            // A front-desk screen punching for someone who typed their own PIN
            if (!boss) refuse('forbidden', 'Only a supervisor screen can do that.');
            target = SAFE_ID.test(body.forId) ? await db.get('staff', body.forId) : null;
            if (!target) refuse('forbidden', 'That person is no longer on the team.');
            await checkPin(key, target, body.pin);
            method = 'TAP';
        } else if (!boss && settings.geoOn) {
            checkPlace(settings, body.geo);
        }
        const punched = await punch(target, method, settings);
        return { ...(await state(me, body)), punched };
    }

    if (action === 'undo') {
        const rec = SAFE_ID.test(body.recordId || '') ? await db.get('records', body.recordId) : null;
        if (rec) {
            if (!boss && rec.employeeId !== me.id) refuse('forbidden', 'That entry belongs to someone else.');
            const last = new Date(rec.departureIso || rec.arrivalIso).getTime();
            if (!boss && Date.now() - last > UNDO_SECONDS * 1000) refuse('forbidden', 'It is too late to undo that. Ask a supervisor to correct it.');
            const now = Date.now();
            await db.commit(rec.departureIso
                // Undo a clock-out: the shift is open again
                ? [db.patch('records', rec.id, { departureIso: null, status: 'CLOCKED_IN', updatedAt: now, sv: now })]
                : [db.remove('records', rec.id), tombstone('record', rec.id, rec.employeeId)]);
        }
        return state(me, body);
    }

    if (action === 'changePin') {
        await checkPin(key, me, body.pin);
        if (!validPin(body.newPin)) refuse('pin', 'Choose a PIN of exactly 4 digits.');
        const updated = { ...me, pinHash: hashPin(key, me.id, body.newPin), sv: Date.now() };
        await db.commit([db.patch('staff', me.id, { pinHash: updated.pinHash, sv: updated.sv })]);
        return { ...(await state(updated, body)), token: tokenFor(key, updated) };
    }

    // --- Supervisors only ---
    if (!boss) refuse('forbidden', 'Only a supervisor can do that.');

    if (action === 'setAccess') {
        const who = SAFE_ID.test(body.id || '') ? await db.get('staff', body.id) : null;
        if (!who) refuse('forbidden', 'That person is no longer on the team.');
        const makeBoss = body.access === 'supervisor';
        if (!makeBoss && who.access === 'supervisor' && !(await supervisorsWithPin()).some(b => b.id !== who.id)) {
            refuse('forbidden', 'There must always be at least one supervisor. Make someone else a supervisor first.');
        }
        await db.commit([db.patch('staff', who.id, { access: makeBoss ? 'supervisor' : 'staff', sv: Date.now() })]);
        const fresh = who.id === me.id ? await db.get('staff', me.id) : me;
        return state(fresh, body);
    }

    if (action === 'resetPin') {
        const owner = SAFE_ID.test(body.id || '') ? await db.get('staff', body.id) : null;
        if (!owner) refuse('forbidden', 'That person is no longer on the team. Sync and try again.');
        const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
        const pinHash = hashPin(key, owner.id, pin);
        await db.commit([db.patch('staff', owner.id, { pinHash, sv: Date.now() }), db.remove('throttle', owner.id)]);
        if (owner.id === me.id) {
            const updated = { ...me, pinHash };
            return { ...(await state(updated, body)), token: tokenFor(key, updated), pin };
        }
        return { ...(await state(me, body)), pin };
    }

    if (action === 'saveSettings') {
        const patch = body.settings || {};
        const next = await loadSettings();
        if (typeof patch.geoOn === 'boolean') next.geoOn = patch.geoOn;
        if (typeof patch.kioskPin === 'boolean') next.kioskPin = patch.kioskPin;
        if (typeof patch.lat === 'number' && Math.abs(patch.lat) <= 90) next.lat = patch.lat;
        if (typeof patch.lng === 'number' && Math.abs(patch.lng) <= 180) next.lng = patch.lng;
        if ([100, 200, 500].includes(Number(patch.radius))) next.radius = Number(patch.radius);
        if (validZone(patch.timeZone)) next.timeZone = patch.timeZone;
        if (next.geoOn && (typeof next.lat !== 'number' || typeof next.lng !== 'number')) next.geoOn = false;
        await db.commit([db.set('config', 'settings', next)]);
        return state(me, body);
    }

    if (action === 'sheetScript') {
        let mirrorDoc = await db.get('config', 'mirror');
        if (!mirrorDoc || !mirrorDoc.key) {
            mirrorDoc = { ...(mirrorDoc || {}), key: crypto.randomBytes(24).toString('hex') };
            await db.commit([db.set('config', 'mirror', mirrorDoc)]);
        }
        return { script: sheetScript(`${origin}/api/app`, mirrorDoc.key) };
    }

    refuse('error', 'Unknown request.');
}

// The Google Sheet's script asks for everything that changed since it last asked
async function mirror(body) {
    const doc = await db.get('config', 'mirror');
    const given = Buffer.from(String(body.key || ''));
    const known = Buffer.from(String((doc && doc.key) || ''));
    if (!doc || !doc.key || given.length !== known.length || !crypto.timingSafeEqual(given, known)) {
        refuse('auth', 'This sheet script is not connected to the app. Copy a fresh script from the app’s Settings.');
    }
    const now = Date.now();
    const cursor = Number(body.cursor) || 0;
    const from = cursor ? cursor - OVERLAP_MS : -1;
    const [records, staff, deleted] = await Promise.all([
        db.query('records', cursor ? [['sv', '>', from]] : []),
        db.query('staff', cursor ? [['sv', '>', from]] : []),
        cursor ? db.query('deleted', [['sv', '>', from]]) : Promise.resolve([])
    ]);
    await db.commit([db.patch('config', 'mirror', { lastPullAt: now })]);
    return {
        cursor: now,
        records: records.map(r => publicRecord(r, now)),
        employees: staff.map(publicEmployee),
        deleted: deleted.map(d => ({ type: d.type, id: d.id }))
    };
}

module.exports = { handle, VERSION };
