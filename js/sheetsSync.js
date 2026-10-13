/**
 * Google Sheets connection.
 * Talks to the sheet's Apps Script web app: sign-in, punches, and keeping the
 * device's copy of the data in step with the sheet.
 *
 * Supervisors' edits are saved on the device first and queued here; nothing
 * leaves the queue until the sheet confirms it was written. Punches from a
 * signed-in phone go straight to the sheet, which stamps the time itself.
 */
class GoogleSheetsSync {
    constructor() {
        this.STATE_KEY = 'pdn_sync_state_v2';
        this.QUEUE_KEY = 'pdn_sync_queue_v2';
        this.SESSION_KEY = 'pdn_session_v1';
        this.LEGACY_CONFIG_KEY = 'pdn_sheets_config_v1';
        this.WINDOW_DAYS = 35;      // how far back records are kept in step with the sheet
        this.TIMEOUT_MS = 25000;
        this.MIN_VERSION = 3;

        this.busy = false;
        this.again = false;
        this.error = null;
        this.completed = 0;         // sync attempts finished, successful or not
        this.onStatusChange = null;
        this.onSessionChange = null;    // role or name changed on the sheet
        this.onAuthLost = null;         // the sheet no longer accepts this sign-in
        this.flushTimer = null;
    }

    get config() {
        return window.PDN_CONFIG || {};
    }

    get storage() {
        return window.clockStorage;
    }

    getState() {
        const state = this.storage.read(this.STATE_KEY, null);
        if (state) return state;
        // Carry over a URL saved by the first version of the app
        const legacy = this.storage.read(this.LEGACY_CONFIG_KEY, {});
        return { url: legacy.scriptUrl || '', bootUrl: '', lastSyncAt: null, sheetName: '', shared: {} };
    }

    saveState(patch) {
        this.storage.write(this.STATE_KEY, { ...this.getState(), ...patch });
    }

    getQueue() {
        return this.storage.read(this.QUEUE_KEY, []);
    }

    saveQueue(queue) {
        this.storage.write(this.QUEUE_KEY, queue);
    }

    // The URL in js/config.js applies to every device; otherwise use the one
    // saved from Settings on this device.
    get isPreset() {
        return !!String(this.config.sheetsUrl || '').trim();
    }

    get url() {
        return String(this.config.sheetsUrl || '').trim() || this.getState().url || '';
    }

    // With a sheet connected, people sign in and the sheet enforces the rules.
    // Without one the app runs open, on this device only.
    get authOn() {
        return !!this.url;
    }

    // Rules set by supervisors and shared by every device (location, front-desk PIN)
    get shared() {
        return this.getState().shared || {};
    }

    getSession() {
        return this.authOn ? this.storage.read(this.SESSION_KEY, null) : null;
    }

    get isSupervisor() {
        const session = this.getSession();
        return !!session && session.role === 'supervisor';
    }

    since() {
        return U.dateKey(U.addDays(new Date(), -this.WINDOW_DAYS));
    }

    checkUrl(url) {
        const value = String(url || '').trim();
        if (!value) return { ok: false, message: 'Paste the web app URL first.' };
        if (/docs\.google\.com\/spreadsheets/.test(value)) {
            return { ok: false, message: 'That is the link to the spreadsheet itself. The app needs the Web app URL from Deploy, which ends in /exec. Follow the steps below.' };
        }
        if (/^https:\/\/script\.google\.com\/.+\/dev(\?.*)?$/.test(value)) {
            return { ok: false, message: 'That is a test link ending in /dev, which only works for you. Use the Web app URL that ends in /exec.' };
        }
        if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec(\?.*)?$/.test(value)) {
            return { ok: false, message: 'That does not look like a Web app URL. It should start with https://script.google.com/macros/s/ and end in /exec.' };
        }
        return { ok: true, url: value };
    }

    fail(message, code) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    async request(url, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
        let text;
        try {
            // text/plain keeps this a "simple" request, which Apps Script accepts cross-origin
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(body),
                redirect: 'follow',
                signal: controller.signal
            });
            text = await response.text();
        } catch (err) {
            throw this.fail(err.name === 'AbortError'
                ? 'The sheet took too long to answer. Try again.'
                : 'Could not reach the sheet. Check the internet connection.', 'network');
        } finally {
            clearTimeout(timer);
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (err) {
            throw this.fail('The link answered with a web page instead of data. Deploy the script as a Web app with access set to "Anyone".', 'setup');
        }

        if (data && data.ok && data.version >= this.MIN_VERSION) return data;
        if (data && data.ok === false && data.code) throw this.fail(data.error || 'The sheet reported an error.', data.code);
        throw this.fail('The script in the Google Sheet is an older version and needs replacing.', 'outdated');
    }

    // One request to the sheet, signed with this device's sign-in
    async call(action, payload = {}, { signed = true } = {}) {
        if (!navigator.onLine) throw this.fail('No internet connection.', 'network');
        const session = this.getSession();
        const body = { action, since: this.since(), ...payload };
        if (signed && session) body.token = session.token;
        try {
            return await this.request(this.url, body);
        } catch (err) {
            if (err.code === 'auth' && signed) this.signOut(true);
            throw err;
        }
    }

    // Take in what the sheet says is true now
    applyState(res) {
        const session = this.getSession();
        let sessionChanged = false;

        if (res.me) {
            const next = {
                token: res.token || (session && session.token),
                id: res.me.id, name: res.me.name, role: res.me.access
            };
            sessionChanged = !session || session.role !== next.role || session.name !== next.name || session.id !== next.id;
            if (next.token) this.storage.write(this.SESSION_KEY, next);
        }

        const pending = new Set(this.getQueue().map(item => `${item.type}:${item.id}`));
        this.storage.applyRemote(res, pending, this.since());
        this.saveState({
            lastSyncAt: Date.now(),
            sheetName: String(res.sheet || '').trim(),
            shared: res.settings || this.shared
        });
        this.error = null;
        if (sessionChanged && typeof this.onSessionChange === 'function') this.onSessionChange();
    }

    // A request that changes something and returns the new state
    async act(action, payload, options) {
        const res = await this.call(action, payload, options);
        this.applyState(res);
        this.notify();
        return res;
    }

    // --- Sign-in ---
    roster() {
        return this.call('roster', {}, { signed: false });
    }

    login(id, pin) {
        return this.act('login', { id, pin }, { signed: false });
    }

    setup(details) {
        return this.act('setup', details, { signed: false });
    }

    signOut(lost = false) {
        this.storage.write(this.SESSION_KEY, null);
        this.notify();
        if (typeof this.onAuthLost === 'function') this.onAuthLost(lost);
    }

    // --- Actions the sheet carries out itself ---
    punch(details = {}) {
        return this.act('punch', details);
    }

    undo(recordId) {
        return this.act('undo', { recordId });
    }

    changePin(pin, newPin) {
        return this.act('changePin', { pin, newPin });
    }

    setAccess(id, access) {
        return this.act('setAccess', { id, access });
    }

    resetPin(id) {
        return this.act('resetPin', { id });
    }

    saveShared(settings) {
        return this.act('saveSettings', { settings });
    }

    // Test a URL from Settings and start using it (only when none is set in config.js)
    async connect(url) {
        const check = this.checkUrl(url);
        if (!check.ok) throw new Error(check.message);
        const res = await this.request(check.url, { action: 'ping' });
        this.saveState({ url: check.url, sheetName: String(res.sheet || '').trim() });
        this.error = null;
        this.notify();
        return res;
    }

    disconnect() {
        this.storage.write(this.SESSION_KEY, null);
        this.saveState({ url: '', bootUrl: '', sheetName: '', lastSyncAt: null, shared: {} });
        this.error = null;
        this.notify();
    }

    // --- Queue of supervisors' edits ---
    enqueue(type, op, id, data) {
        // Only supervisors may change the timesheet or team; staff devices never queue
        if (this.authOn && !this.isSupervisor) return;

        // A newer change to the same item replaces the older queued one
        const queue = this.getQueue().filter(item => !(item.type === type && item.id === id));
        queue.push({ qid: U.uid('q'), type, op, id, data: data || null });
        this.saveQueue(queue);
        this.notify();

        // Batch quick successive changes into one request
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => this.sync(), 400);
    }

    // Add the human-readable columns the sheet shows
    forSheet(item) {
        if (item.type !== 'record' || !item.data) return item;
        const r = item.data;
        const minutes = r.departureIso ? U.minutesBetween(r.arrivalIso, r.departureIso) : null;
        return {
            ...item,
            data: {
                ...r,
                arrivalTime: U.fmtTime(r.arrivalIso),
                departureTime: U.fmtTime(r.departureIso),
                hours: minutes == null ? '' : Math.round(minutes / 0.6) / 100
            }
        };
    }

    // A supervisor's first sync with a sheet: upload what this device already has
    bootstrap(url) {
        if (this.getState().bootUrl === url) return;
        const queue = this.getQueue();
        const queued = new Set(queue.map(item => `${item.type}:${item.id}`));
        this.storage.read(this.storage.EMPLOYEES_KEY, []).forEach(e => {
            if (!queued.has(`employee:${e.id}`)) queue.push({ qid: U.uid('q'), type: 'employee', op: 'upsert', id: e.id, data: e });
        });
        this.storage.read(this.storage.RECORDS_KEY, []).forEach(r => {
            if (!queued.has(`record:${r.id}`)) queue.push({ qid: U.uid('q'), type: 'record', op: 'upsert', id: r.id, data: r });
        });
        this.saveQueue(queue);
        this.saveState({ bootUrl: url });
    }

    async sync() {
        const url = this.url;
        if (!url || !this.getSession()) return;
        if (!navigator.onLine) return this.notify();
        if (this.busy) {
            this.again = true;
            return;
        }

        this.busy = true;
        this.again = false;
        this.notify();

        try {
            if (this.isSupervisor) this.bootstrap(url);
            else this.saveQueue([]);

            const sent = this.getQueue();
            const res = await this.call('sync', { items: sent.map(item => this.forSheet(item)) });

            // Only what the sheet confirmed is removed; anything queued while
            // the request was in flight stays for the next round.
            const sentIds = new Set(sent.map(item => item.qid));
            this.saveQueue(this.getQueue().filter(item => !sentIds.has(item.qid)));
            this.applyState(res);
        } catch (err) {
            this.error = err.message;
            if (err.code !== 'auth') console.warn('[PDN] Sync failed, will retry:', err.message);
        } finally {
            this.busy = false;
            this.completed++;
            this.notify();
        }

        if (!this.error && this.getSession() && (this.again || this.getQueue().length)) this.sync();
    }

    // Upload anything queued and wait until it is done
    async pushNow() {
        const idle = async () => {
            while (this.busy) await new Promise(resolve => setTimeout(resolve, 80));
        };
        clearTimeout(this.flushTimer);
        await idle();
        await this.sync();
        await idle();
        if (this.getQueue().length) throw this.fail(this.error || 'Could not reach the sheet.', 'network');
    }

    start() {
        window.addEventListener('online', () => this.sync());
        window.addEventListener('offline', () => this.notify());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.sync();
        });
        const every = Math.max(20, Number(this.config.syncIntervalSec) || 60) * 1000;
        setInterval(() => {
            if (document.visibilityState === 'visible') this.sync();
        }, every);
        this.sync();
    }

    getStatus() {
        const state = this.getState();
        const queued = this.getQueue().length;
        let phase = 'ok';
        if (!this.url) phase = 'off';
        else if (!navigator.onLine) phase = 'offline';
        else if (this.busy) phase = 'syncing';
        else if (this.error) phase = 'error';
        else if (queued) phase = 'pending';

        return {
            phase, queued,
            error: this.error,
            url: this.url,
            isPreset: this.isPreset,
            sheetName: state.sheetName,
            lastSyncAt: state.lastSyncAt
        };
    }

    notify() {
        if (typeof this.onStatusChange === 'function') this.onStatusChange(this.getStatus());
    }
}

window.sheetsSync = new GoogleSheetsSync();
