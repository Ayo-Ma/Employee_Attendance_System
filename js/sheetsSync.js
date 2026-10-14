/**
 * Connection to the app's server (Firebase behind a Vercel function).
 * Handles sign-in, punches, and keeping this device's copy of the data in step.
 *
 * Supervisors' edits are saved on the device first and queued here; nothing
 * leaves the queue until the server confirms it. Punches go straight to the
 * server, which stamps the time itself. Each reply carries only what changed
 * since this device last asked, so keeping in step is cheap.
 */
class AppSync {
    constructor() {
        this.STATE_KEY = 'pdn_sync_state_v3';
        this.QUEUE_KEY = 'pdn_sync_queue_v2';
        this.SESSION_KEY = 'pdn_session_v1';
        this.ROSTER_KEY = 'pdn_roster_v1';
        this.WINDOW_DAYS = 35;      // how far back records are kept on the device
        this.TIMEOUT_MS = 20000;
        this.MIN_VERSION = 5;

        this.busy = false;
        this.again = false;
        this.error = null;
        this.completed = 0;         // sync attempts finished, successful or not
        this.onStatusChange = null;
        this.onSessionChange = null;    // role or name changed on the server
        this.onAuthLost = null;         // the server no longer accepts this sign-in
        this.flushTimer = null;
        this.lastNudge = 0;

        this.forgetOldBackend();
    }

    get config() {
        return window.PDN_CONFIG || {};
    }

    get storage() {
        return window.clockStorage;
    }

    get url() {
        return String(this.config.apiUrl || '').trim();
    }

    // With a server, people sign in and the server enforces the rules.
    // Without one the app runs open, on this device only.
    get authOn() {
        return !!this.url;
    }

    // Data cached from the Google Sheets version belongs to a different database
    forgetOldBackend() {
        if (!this.authOn || this.getState().backend === 'firebase') return;
        [this.storage.EMPLOYEES_KEY, this.storage.RECORDS_KEY].forEach(key => this.storage.write(key, []));
        [this.QUEUE_KEY].forEach(key => this.storage.write(key, []));
        [this.SESSION_KEY, this.ROSTER_KEY].forEach(key => this.storage.write(key, null));
        this.storage.write(this.STATE_KEY, { backend: 'firebase', cursor: 0, lastSyncAt: null, shared: {} });
    }

    getState() {
        return this.storage.read(this.STATE_KEY, null) || { cursor: 0, lastSyncAt: null, shared: {} };
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

    fail(message, code) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    async request(body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
        let text;
        try {
            const response = await fetch(this.url, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            text = await response.text();
        } catch (err) {
            throw this.fail(err.name === 'AbortError'
                ? 'The server took too long to answer. Try again.'
                : 'Could not reach the server. Check the internet connection.', 'network');
        } finally {
            clearTimeout(timer);
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (err) {
            throw this.fail('The server is not running at this address. Open the app from its Vercel link.', 'setup');
        }

        if (data && data.ok && data.version >= this.MIN_VERSION) return data;
        if (data && data.ok === false && data.code) throw this.fail(data.error || 'The server reported an error.', data.code);
        throw this.fail('The server is out of date. Redeploy the app on Vercel.', 'outdated');
    }

    // One request to the server, signed with this device's sign-in
    async call(action, payload = {}, { signed = true } = {}) {
        if (!navigator.onLine) throw this.fail('No internet connection.', 'network');
        const session = this.getSession();
        const body = { action, since: this.since(), ...payload };
        if (signed && session) {
            body.token = session.token;
            body.cursor = this.getState().cursor || 0;
        }
        try {
            return await this.request(body);
        } catch (err) {
            if (err.code === 'auth' && signed) this.signOut(true);
            throw err;
        }
    }

    // Take in what the server says is true now
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
        if (res.full) this.storage.applyRemote(res, pending, this.since());
        else this.storage.applyChanges(res, pending);

        this.saveState({
            // A new person or role sees different data, so start over with a full download
            cursor: sessionChanged && !res.full ? 0 : res.cursor,
            lastSyncAt: Date.now(),
            shared: res.settings || this.shared
        });
        this.error = null;
        if (sessionChanged) {
            if (!res.full) setTimeout(() => this.sync(), 0);
            if (typeof this.onSessionChange === 'function') this.onSessionChange();
        }
    }

    // A request that changes something and returns the new state
    async act(action, payload, options) {
        const res = await this.call(action, payload, options);
        this.applyState(res);
        this.notify();
        this.nudgeSheet();
        return res;
    }

    // Ask the Google Sheet copy to catch up now instead of within the minute
    nudgeSheet() {
        const sheet = String(this.config.sheetUrl || '').trim();
        if (!sheet || Date.now() - this.lastNudge < 5000) return;
        this.lastNudge = Date.now();
        fetch(`${sheet}?action=pull`, { mode: 'no-cors', keepalive: true }).catch(() => {});
    }

    // --- Sign-in ---
    async roster() {
        const res = await this.call('roster', {}, { signed: false });
        this.storage.write(this.ROSTER_KEY, { needsSetup: res.needsSetup, people: res.people });
        return res;
    }

    rememberedRoster() {
        return this.storage.read(this.ROSTER_KEY, null);
    }

    login(id, pin) {
        return this.act('login', { id, pin }, { signed: false });
    }

    setup(details) {
        let timeZone = '';
        try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* older browser */ }
        return this.act('setup', { ...details, timeZone }, { signed: false });
    }

    signOut(lost = false) {
        this.storage.write(this.SESSION_KEY, null);
        this.saveState({ cursor: 0 });
        this.notify();
        if (typeof this.onAuthLost === 'function') this.onAuthLost(lost);
    }

    // --- Actions the server carries out itself ---
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

    async sheetScript() {
        return (await this.call('sheetScript')).script;
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

    async sync() {
        if (!this.url || !this.getSession()) return;
        if (!navigator.onLine) return this.notify();
        if (this.busy) {
            this.again = true;
            return;
        }

        this.busy = true;
        this.again = false;
        this.notify();

        try {
            if (!this.isSupervisor) this.saveQueue([]);
            const sent = this.getQueue();
            const res = await this.call('sync', { items: sent });

            // Only what the server confirmed is removed; anything queued while
            // the request was in flight stays for the next round.
            const sentIds = new Set(sent.map(item => item.qid));
            this.saveQueue(this.getQueue().filter(item => !sentIds.has(item.qid)));
            this.applyState(res);
            if (sent.length) this.nudgeSheet();
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
        if (this.getQueue().length) throw this.fail(this.error || 'Could not reach the server.', 'network');
    }

    start() {
        window.addEventListener('online', () => this.sync());
        window.addEventListener('offline', () => this.notify());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.sync();
        });
        const every = Math.max(15, Number(this.config.syncIntervalSec) || 30) * 1000;
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
            lastSyncAt: state.lastSyncAt,
            mirrorAt: this.shared.mirrorAt || null
        };
    }

    notify() {
        if (typeof this.onStatusChange === 'function') this.onStatusChange(this.getStatus());
    }
}

window.sheetsSync = new AppSync();
