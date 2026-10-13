/**
 * App controller — PDN Attendance
 * Sign-in, the three sections (Clock in, Timesheet, Team) and Settings, wired
 * to storage, the clock engine, the scanner and the Google Sheet.
 *
 * Who sees what:
 *   staff       their own time card only
 *   supervisor  everything, and can make others supervisors
 *   open        no sheet connected: everything, on this device only
 */
document.addEventListener('DOMContentLoaded', () => {
    const storage = window.clockStorage;
    const engine = window.clockEngine;
    const sound = window.soundFX;
    const badges = window.badgeManager;
    const scanner = window.qrScanner;
    const sheets = window.sheetsSync;
    const config = window.PDN_CONFIG || {};

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const esc = U.esc;
    const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // --- State ---
    let settings = storage.getSettings();
    if (!settings.deviceMode) {
        // Phones start on the personal time card, bigger screens as the front desk
        settings = storage.saveSettings({
            deviceMode: window.matchMedia('(max-width: 720px)').matches ? 'personal' : 'kiosk'
        });
    }

    const state = {
        view: 'clock',
        range: 'today',
        tsQuery: '',
        staffQuery: '',
        flash: null,          // the punch that was just made, for the stamp animation
        editingRecordId: null,
        editingStaffId: null
    };
    let flashTimer = null;
    const lastTap = {};

    const METHOD_LABELS = {
        QR: 'Badge scan', QR_SCAN: 'Badge scan', SIMULATED_QR: 'Badge scan',
        TAP: 'Front desk', '1_TAP_KIOSK': 'Front desk',
        PHONE: 'Phone', MOBILE_PUNCH: 'Phone',
        MANUAL: 'Added by hand', MANUAL_ENTRY: 'Added by hand'
    };

    $('#brandName').textContent = config.shortName || 'PDN';
    sound.setEnabled(settings.sound !== false);

    // =========================================================================
    // Who is using this device
    // =========================================================================
    const appEl = $('.app');
    const gate = $('#gate');

    function role() {
        if (!sheets.authOn) return 'open';
        const session = sheets.getSession();
        return session ? session.role : 'out';
    }

    // A supervisor can lock a shared screen so only clocking in is possible
    const isLocked = () => role() === 'supervisor' && !!settings.kioskLocked;
    const canManage = () => (role() === 'open' || role() === 'supervisor') && !isLocked();

    function deviceMode() {
        if (role() === 'staff') return 'personal';
        if (isLocked()) return 'kiosk';
        return settings.deviceMode;
    }

    // Whose time card "My time card" shows
    function myId() {
        if (!sheets.authOn) return settings.me || '';
        const session = sheets.getSession();
        return session ? session.id : '';
    }

    function applyRole() {
        document.body.dataset.role = role();
        document.body.dataset.locked = String(isLocked());
        $('#unlockBtn').hidden = !isLocked();
        if (!canManage() && state.view !== 'clock') showView('clock');
    }

    // =========================================================================
    // Toasts, dialogs, confirm
    // =========================================================================
    const toastsEl = $('#toasts');

    function toast(message, options = {}) {
        const el = document.createElement('div');
        el.className = `toast${options.tone ? ` is-${options.tone}` : ''}`;
        el.innerHTML = `<span class="toast-text">${esc(message)}</span>`;

        const dismiss = () => {
            clearTimeout(timer);
            el.classList.add('is-leaving');
            setTimeout(() => el.remove(), 200);
        };
        if (options.action) {
            const button = document.createElement('button');
            button.className = 'toast-action';
            button.textContent = options.action.label;
            button.addEventListener('click', () => {
                options.action.run();
                dismiss();
            });
            el.appendChild(button);
        }

        // One message at a time, so nothing piles up over the screen
        toastsEl.replaceChildren(el);
        const timer = setTimeout(dismiss, options.duration || 4500);
    }

    const alertToast = (err) => toast(err.message || String(err), { tone: 'alert', duration: 7000 });

    $$('dialog').forEach(dialog => {
        // Click on the dimmed backdrop closes
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.close();
        });
        $$('[data-close]', dialog).forEach(button => button.addEventListener('click', () => dialog.close()));
    });

    function confirmAction(title, text, yesLabel) {
        const dialog = $('#confirmDialog');
        $('#confirmTitle').textContent = title;
        $('#confirmText').textContent = text;
        $('#confirmYes').textContent = yesLabel;
        return new Promise(resolve => {
            const finish = (answer) => {
                $('#confirmYes').onclick = $('#confirmNo').onclick = dialog.onclose = null;
                if (dialog.open) dialog.close();
                resolve(answer);
            };
            $('#confirmYes').onclick = () => finish(true);
            $('#confirmNo').onclick = () => finish(false);
            dialog.onclose = () => { if (!dialog.open) finish(false); };
            dialog.showModal();
        });
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            // Clipboard API needs HTTPS; fall back for file:// and LAN addresses
            const area = document.createElement('textarea');
            area.value = text;
            area.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(area);
            area.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
            area.remove();
            return ok;
        }
    }

    // --- PIN pad ---
    // Resolves with whatever `submit` returns once it accepts a PIN, or null if closed.
    // `submit` throws to reject a PIN; its message is shown and the pad clears.
    const pinDialog = $('#pinDialog');
    const pinDots = $$('#pinDots i');

    function askPin({ title, text, submit }) {
        return new Promise(resolve => {
            let digits = '';
            let busy = false;
            let done = false;

            const paint = () => pinDots.forEach((dot, i) => dot.classList.toggle('is-on', i < digits.length));
            const finish = (value) => {
                if (done) return;
                done = true;
                $('#pinPad').onclick = pinDialog.onkeydown = pinDialog.onclose = null;
                if (pinDialog.open) pinDialog.close();
                resolve(value);
            };

            const press = async (key) => {
                if (busy || done) return;
                if (key === 'back') {
                    digits = digits.slice(0, -1);
                    return paint();
                }
                if (!/^\d$/.test(key) || digits.length >= 4) return;
                digits += key;
                $('#pinError').textContent = '';
                paint();
                if (digits.length < 4) return;

                busy = true;
                pinDialog.classList.add('is-busy');
                try {
                    const value = await submit(digits);
                    finish(value === undefined ? true : value);
                } catch (err) {
                    $('#pinError').textContent = err.message;
                    digits = '';
                    paint();
                    $('#pinDots').classList.remove('is-wrong');
                    void $('#pinDots').offsetWidth;
                    $('#pinDots').classList.add('is-wrong');
                } finally {
                    busy = false;
                    pinDialog.classList.remove('is-busy');
                }
            };

            $('#pinTitle').textContent = title;
            $('#pinText').textContent = text;
            $('#pinError').textContent = '';
            $('#pinDots').classList.remove('is-wrong');
            paint();

            $('#pinPad').onclick = (e) => {
                const key = e.target.closest('[data-key]');
                if (key) press(key.dataset.key);
            };
            pinDialog.onkeydown = (e) => {
                if (/^\d$/.test(e.key)) press(e.key);
                else if (e.key === 'Backspace') press('back');
            };
            // A close event from the previous use of the pad can arrive late; ignore it while open
            pinDialog.onclose = () => { if (!pinDialog.open) finish(null); };
            pinDialog.showModal();
        });
    }

    // Ask for a new PIN twice. Resolves with the PIN, or null if cancelled.
    async function chooseNewPin(title) {
        let first = '';
        const entered = await askPin({
            title,
            text: 'Choose a 4-digit PIN. You will use it to sign in.',
            submit: async (pin) => { first = pin; }
        });
        if (entered === null) return null;
        const confirmed = await askPin({
            title,
            text: 'Enter the same PIN again to confirm.',
            submit: async (pin) => {
                if (pin !== first) throw new Error('That does not match the first one. Try again.');
            }
        });
        return confirmed === null ? null : first;
    }

    function showNewPin(name, pin) {
        $('#newPinTitle').textContent = `PIN for ${name}`;
        $('#newPinValue').textContent = pin;
        $('#newPinText').textContent = `Give this PIN to ${name}. They sign in with it on their phone and can change it in Settings. It is not shown again.`;
        $('#newPinDialog').showModal();
    }

    // --- Location ---
    function getLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('This browser cannot share its location.'));
            navigator.geolocation.getCurrentPosition(
                pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) }),
                err => reject(new Error(err.code === 1
                    ? 'Location is switched off for this site. Allow location in your browser settings, then try again.'
                    : 'Could not get your location. Turn on GPS and try again.')),
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
            );
        });
    }

    // =========================================================================
    // Sign-in screen
    // =========================================================================
    function gateHtml(inner) {
        return `
            <div class="gate-card">
                <div class="gate-brand">
                    <span class="brand-mark" aria-hidden="true">${icon('clock')}</span>
                    <span>${esc(config.orgName || 'Attendance')}</span>
                </div>
                ${inner}
            </div>`;
    }

    const personButton = (person, attr) => `
        <button class="who-pick" ${attr}="${esc(person.id)}">
            <span class="avatar" style="--c:${esc(person.avatarColor)}">${esc(U.initials(person.name))}</span>
            <span class="tile-text"><b>${esc(person.name)}</b></span>
        </button>`;

    const ROSTER_KEY = 'pdn_roster_v1';

    async function showGate() {
        stopCamera();
        $$('dialog[open]').forEach(dialog => dialog.close());
        appEl.hidden = true;
        gate.hidden = false;
        // Show the names this phone saw last time straight away, then refresh them
        const remembered = storage.read(ROSTER_KEY, null);
        if (remembered) renderGate(remembered);
        else gate.innerHTML = gateHtml('<p class="gate-note">Loading…</p>');

        let res;
        try {
            res = await sheets.roster();
        } catch (err) {
            if (remembered && err.code === 'network') return;
            const outdated = err.code === 'outdated';
            gate.innerHTML = gateHtml(`
                <h1>${outdated ? 'The sheet needs one update' : 'Could not connect'}</h1>
                <p>${esc(outdated
                    ? 'This version of the app adds sign-in. The script inside your Google Sheet has to be replaced once before anyone can sign in.'
                    : err.message)}</p>
                ${outdated ? `
                    <ol class="gate-steps">
                        <li>Press <b>Copy script</b> below.</li>
                        <li>In the Google Sheet open <b>Extensions › Apps Script</b>, delete the code, paste, and save.</li>
                        <li>Choose <b>Deploy › Manage deployments › Edit › Version: New version › Deploy</b>.</li>
                    </ol>
                    <button class="btn" data-gate="copy">${icon('download')}<span>Copy script</span></button>` : ''}
                <button class="btn btn-primary" data-gate="retry">Try again</button>`);
            return;
        }

        const latest = { needsSetup: res.needsSetup, people: res.people };
        storage.write(ROSTER_KEY, latest);
        if (gate.hidden) return;
        if (!remembered || JSON.stringify(remembered) !== JSON.stringify(latest)) renderGate(latest);
    }

    function renderGate(res) {
        if (res.needsSetup) {
            gate.innerHTML = gateHtml(`
                <h1>Set up the first supervisor</h1>
                <p>A supervisor can correct the timesheet, manage the team and make other people supervisors. Do this before sharing the app with staff.</p>
                ${res.people.length ? `
                    <h2 class="gate-label">Choose yourself</h2>
                    <div class="who-list">${res.people.map(p => personButton(p, 'data-setup')).join('')}</div>
                    <h2 class="gate-label">Or add yourself</h2>` : ''}
                <label class="field"><span>Your full name</span><input type="text" id="setupName" maxlength="60" autocomplete="name"></label>
                <p id="setupError" class="field-error" role="alert"></p>
                <button class="btn btn-primary" data-gate="setup-new">Continue</button>`);
            return;
        }

        gate.innerHTML = gateHtml(`
            <h1>Who are you?</h1>
            <p>Pick your name, then enter your PIN.</p>
            ${res.people.length > 8 ? `
                <label class="search">${icon('search')}<input type="search" id="gateSearch" placeholder="Find your name" autocomplete="off" aria-label="Find your name"></label>` : ''}
            <div class="who-list" id="gateList">${res.people.map(p => personButton(p, 'data-login')).join('')}</div>`);
    }

    function enterApp() {
        gate.hidden = true;
        gate.innerHTML = '';
        appEl.hidden = false;
        applyRole();
        showView('clock');
        renderConnection(sheets.getStatus());
    }

    gate.addEventListener('input', (e) => {
        if (e.target.id !== 'gateSearch') return;
        const query = e.target.value.trim().toLowerCase();
        $$('#gateList .who-pick').forEach(button => {
            button.hidden = !button.textContent.toLowerCase().includes(query);
        });
    });

    gate.addEventListener('click', async (e) => {
        const login = e.target.closest('[data-login]');
        if (login) {
            const name = $('b', login).textContent;
            const ok = await askPin({
                title: name,
                text: 'Enter your PIN.',
                submit: pin => sheets.login(login.dataset.login, pin)
            });
            if (ok) enterApp();
            return;
        }

        const setup = e.target.closest('[data-setup]');
        const action = e.target.closest('[data-gate]');
        if (setup || (action && action.dataset.gate === 'setup-new')) {
            const details = {};
            let name;
            if (setup) {
                details.id = setup.dataset.setup;
                name = $('b', setup).textContent;
            } else {
                name = $('#setupName').value.trim();
                if (!name) {
                    $('#setupError').textContent = 'Enter your name.';
                    return $('#setupName').focus();
                }
                details.name = name;
            }
            const pin = await chooseNewPin(name);
            if (!pin) return;
            try {
                await sheets.setup({ ...details, pin });
                enterApp();
                toast('You are the supervisor. Add your team in the Team section.', { duration: 7000 });
            } catch (err) {
                alertToast(err);
                showGate();
            }
            return;
        }

        if (!action) return;
        if (action.dataset.gate === 'retry') showGate();
        if (action.dataset.gate === 'copy') {
            const ok = await copyText(window.PDN_APPS_SCRIPT);
            toast(ok ? 'Script copied. Paste it into Apps Script.' : 'Could not copy. Open js/appsScript.js and copy the script from there.', ok ? {} : { tone: 'alert' });
        }
    });

    sheets.onAuthLost = (lost) => {
        showGate();
        if (lost) toast('Please sign in again.');
    };

    sheets.onSessionChange = () => {
        if (!gate.hidden) return;
        applyRole();
        render();
    };

    // =========================================================================
    // Navigation
    // =========================================================================
    function showView(view) {
        state.view = canManage() ? view : 'clock';
        $$('.view').forEach(section => { section.hidden = section.id !== `view-${state.view}`; });
        $$('.tab').forEach(tab => {
            if (tab.dataset.view === state.view) tab.setAttribute('aria-current', 'page');
            else tab.removeAttribute('aria-current');
        });
        render();
    }

    function setView(view) {
        if (view === state.view || !canManage()) return;
        if (view !== 'clock') stopCamera();
        if (document.startViewTransition && !reducedMotion.matches) {
            document.startViewTransition(() => showView(view));
        } else {
            showView(view);
        }
    }

    $$('.tab').forEach(tab => tab.addEventListener('click', () => setView(tab.dataset.view)));

    // =========================================================================
    // Live clock and today's tally
    // =========================================================================
    const clockHM = $('#clockHM');
    const clockSec = $('#clockSec');
    const clockAmPm = $('#clockAmPm');
    const clockDate = $('#clockDate');
    let lastMinute = -1;

    function setText(el, text) {
        if (el.textContent !== text) el.textContent = text;
    }

    function tick() {
        const now = new Date();
        const h = now.getHours();
        setText(clockHM, `${h % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')}`);
        setText(clockSec, String(now.getSeconds()).padStart(2, '0'));
        setText(clockAmPm, h >= 12 ? 'PM' : 'AM');
        setText(clockDate, now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }));

        // Once a minute: refresh running durations and close forgotten shifts
        if (now.getMinutes() !== lastMinute) {
            if (lastMinute !== -1) {
                engine.sweepStale();
                render();
            }
            lastMinute = now.getMinutes();
        }
    }
    setInterval(tick, 1000);

    function renderTally() {
        const m = engine.getMetrics();
        $('#tally').innerHTML = `
            <li class="is-in"><b>${m.in}</b><span>in now</span></li>
            <li><b>${m.done}</b><span>left</span></li>
            <li><b>${m.out}</b><span>not in yet</span></li>`;
    }

    // =========================================================================
    // Punching
    // =========================================================================
    function stampAngle(seed) {
        return ((U.hash(seed) % 60) - 30) / 10;
    }

    // Turn the sheet's reply to a punch into the same shape a local punch has
    function fromSheet(res) {
        const p = res.punched;
        return {
            ok: true,
            action: p.action,
            employee: storage.getEmployeeById(p.employeeId) || { id: p.employeeId, name: '' },
            record: storage.getRecord(p.recordId),
            at: new Date(p.at),
            sheetStamped: true
        };
    }

    function handlePunch(result, source) {
        if (!result.ok) {
            if (result.reason !== 'recent') sound.playNotice();
            if (source === 'qr') showScanResult(result);
            else toast(result.message, { tone: 'alert' });
            return;
        }

        if (result.action === 'in') sound.playClockIn();
        else sound.playClockOut();

        state.flash = { empId: result.employee.id, action: result.action, at: result.at };
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
            state.flash = null;
            render();
        }, 2000);
        render();

        const time = U.fmtTime(result.at);
        const minutes = result.record ? engine.minutesWorked(result.record) : null;
        const worked = result.action === 'out' && minutes != null ? ` · ${U.fmtDuration(minutes)}` : '';
        toast(`${result.employee.name} clocked ${result.action} at ${time}${worked}`, {
            duration: 7000,
            action: {
                label: 'Undo',
                run: async () => {
                    state.flash = null;
                    try {
                        if (result.sheetStamped) await sheets.undo(result.record.id);
                        else engine.undo(result);
                        toast('Undone');
                    } catch (err) {
                        alertToast(err);
                    }
                    render();
                }
            }
        });

        if (source === 'qr') showScanResult(result);
        if (source === 'phone') celebrate(result);
    }

    // Finding a phone's position can take a few seconds, so start as soon as the app
    // is opened; by the time the blob is tapped the answer is usually already there.
    let lastFix = null;
    let seenCompleted = sheets.completed;
    const needsLocation = () => !!sheets.shared.geoOn && role() === 'staff';

    function warmLocation() {
        if (!needsLocation() || (lastFix && Date.now() - lastFix.at < 30000)) return;
        getLocation().then(fix => { lastFix = { fix, at: Date.now() }; }).catch(() => {});
    }

    async function currentLocation() {
        if (!needsLocation()) return undefined;
        if (lastFix && Date.now() - lastFix.at < 60000) return lastFix.fix;
        const fix = await getLocation();
        lastFix = { fix, at: Date.now() };
        return fix;
    }

    // The blob's confirmation: squeeze, burst, tick, then settle into the new state
    let celebrateTimer = null;

    function celebrate(result) {
        const blob = $('#punchBtn');
        if (!blob) return;
        const isIn = result.action === 'in';
        const minutes = result.record ? engine.minutesWorked(result.record) : null;
        $('.blob-done-text', blob).textContent = isIn ? 'Clocked in' : 'Clocked out';
        $('.blob-done-time', blob).textContent = isIn || minutes == null
            ? U.fmtTime(result.at)
            : `${U.fmtTime(result.at)} · ${U.fmtDuration(minutes)}`;

        blob.classList.remove('is-celebrating');
        void blob.offsetWidth;      // restart the animation if it was still running
        blob.classList.add('is-celebrating');
        try {
            if (navigator.vibrate) navigator.vibrate(isIn ? 40 : [30, 70, 30]);
        } catch (e) { /* not allowed here */ }

        clearTimeout(celebrateTimer);
        celebrateTimer = setTimeout(() => blob.classList.remove('is-celebrating'), 2400);
    }

    // =========================================================================
    // Clock in — front desk
    // =========================================================================
    const staffGrid = $('#staffGrid');

    function emptyTeamHtml() {
        // A device that has never synced has no staff list yet; that is not the same as an empty team
        const status = sheets.getStatus();
        if (status.url && !status.lastSyncAt) {
            let title = 'Loading the team…';
            let text = 'Getting the staff list from the sheet.';
            if (status.phase === 'offline') {
                title = 'No connection';
                text = 'Connect to the internet and the team will load by itself.';
            } else if (status.phase === 'error') {
                title = 'Could not load the team';
                text = status.error;
            }
            return `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
        }
        return `
            <div class="empty">
                <h2>No staff yet</h2>
                <p>Add the people who clock in here. Each one gets a name tile, a PIN and a QR badge.</p>
                ${canManage() ? `<button class="btn btn-primary" data-action="add-staff">${icon('plus')}<span>Add staff</span></button>` : ''}
            </div>`;
    }

    function renderGrid() {
        $('#lockBtn').hidden = role() !== 'supervisor' || isLocked();

        const all = storage.getEmployees();
        if (!all.length) {
            staffGrid.innerHTML = emptyTeamHtml();
            return;
        }

        const query = state.staffQuery.toLowerCase();
        const list = all.filter(e => `${e.name} ${e.role} ${e.department} ${e.id}`.toLowerCase().includes(query));
        if (!list.length) {
            staffGrid.innerHTML = `<div class="empty"><p>Nobody matches “${esc(state.staffQuery)}”.</p></div>`;
            return;
        }

        staffGrid.innerHTML = list.map(emp => {
            const status = engine.getStatus(emp.id);
            const isIn = status.state === 'in';
            let line = 'Not in yet';
            if (isIn) line = `In since ${U.fmtTime(status.record.arrivalIso)}`;
            else if (status.state === 'done') line = `Left ${U.fmtTime(status.record.departureIso)}`;

            const flash = state.flash && state.flash.empId === emp.id ? state.flash : null;
            const side = flash
                ? `<span class="stamp is-fresh" style="--r:${stampAngle(emp.id + flash.at)}deg">${flash.action === 'in' ? 'IN' : 'OUT'} ${esc(U.fmtTime(flash.at))}</span>`
                : `<span class="tile-action">${isIn ? 'Clock out' : 'Clock in'}</span>`;

            return `
                <button class="tile ${isIn ? 'is-in' : ''}" data-emp="${esc(emp.id)}" title="${esc([emp.role, emp.department].filter(Boolean).join(' · '))}">
                    <span class="avatar" style="--c:${esc(emp.avatarColor)}">${esc(U.initials(emp.name))}<i class="presence"></i></span>
                    <span class="tile-text"><b>${esc(emp.name)}</b><small>${esc(line)}</small></span>
                    ${side}
                </button>`;
        }).join('');
    }

    staffGrid.addEventListener('click', async (e) => {
        if (e.target.closest('[data-action="add-staff"]')) return openStaffDialog();
        const tile = e.target.closest('.tile');
        if (!tile) return;
        const id = tile.dataset.emp;
        // Ignore an accidental double tap, which would clock straight back out
        if (Date.now() - (lastTap[id] || 0) < 1200) return;
        lastTap[id] = Date.now();

        // With a sheet connected, each person proves it is them with their PIN
        if (sheets.authOn && sheets.shared.kioskPin !== false) {
            const emp = storage.getEmployeeById(id);
            if (!emp) return;
            const isIn = engine.getStatus(id).state === 'in';
            const res = await askPin({
                title: emp.name,
                text: `Enter your PIN to clock ${isIn ? 'out' : 'in'}.`,
                submit: pin => sheets.punch({ forId: id, pin })
            });
            if (res) handlePunch(fromSheet(res), 'tap');
            return;
        }
        handlePunch(engine.punch(id, 'TAP'), 'tap');
    });

    $('#staffSearch').addEventListener('input', (e) => {
        state.staffQuery = e.target.value.trim();
        renderGrid();
    });

    // --- Lock a shared screen ---
    $('#lockBtn').addEventListener('click', () => {
        settings = storage.saveSettings({ kioskLocked: true });
        applyRole();
        showView('clock');
        toast('Screen locked. Only clocking in and out works until a supervisor unlocks it.', { duration: 6000 });
    });

    $('#unlockBtn').addEventListener('click', async () => {
        const session = sheets.getSession();
        if (!session) return;
        const ok = await askPin({
            title: 'Unlock',
            text: `Enter ${session.name}'s supervisor PIN.`,
            submit: pin => sheets.login(session.id, pin)
        });
        if (!ok) return;
        settings = storage.saveSettings({ kioskLocked: false });
        applyRole();
        render();
    });

    // --- Camera ---
    const scannerEl = $('#scanner');
    const scannerStatus = $('#scannerStatus');
    const cameraBtn = $('#cameraBtn');
    const flipBtn = $('#flipBtn');
    const scanResult = $('#scanResult');
    let scanResultTimer = null;

    scanner.init($('#scannerVideo'), (code) => handlePunch(engine.punch(code, 'QR'), 'qr'));

    function setCameraUi(on, message) {
        scannerEl.dataset.state = on ? 'on' : 'off';
        $('span', cameraBtn).textContent = on ? 'Stop camera' : 'Start camera';
        flipBtn.hidden = !on;
        scannerStatus.textContent = message || '';
    }

    function applyCameraResult(result) {
        if (result.ok) {
            scannerEl.classList.toggle('is-mirrored', result.mirrored);
            setCameraUi(true, 'Hold your badge up to the camera.');
        } else {
            setCameraUi(false, result.error);
        }
    }

    function stopCamera() {
        if (!scanner.isScanning && scannerEl.dataset.state === 'off') return;
        scanner.stop();
        setCameraUi(false, '');
    }

    cameraBtn.addEventListener('click', async () => {
        if (scanner.isScanning) return stopCamera();
        cameraBtn.disabled = true;
        scannerStatus.textContent = 'Starting the camera…';
        applyCameraResult(await scanner.start());
        cameraBtn.disabled = false;
    });

    flipBtn.addEventListener('click', async () => applyCameraResult(await scanner.flip()));

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') stopCamera();
        else {
            warmLocation();
            render();
        }
    });

    function showScanResult(result) {
        clearTimeout(scanResultTimer);
        if (result.ok) {
            scanResult.className = 'scan-result';
            scanResult.innerHTML = `
                <span class="stamp stamp-lg is-fresh" style="--r:-4deg">${result.action === 'in' ? 'IN' : 'OUT'} ${esc(U.fmtTime(result.at))}</span>
                <b>${esc(result.employee.name)}</b>`;
        } else {
            scanResult.className = `scan-result ${result.reason === 'recent' ? '' : 'is-alert'}`;
            scanResult.innerHTML = `<b>${esc(result.message)}</b>`;
        }
        scanResult.hidden = false;
        scanResultTimer = setTimeout(() => { scanResult.hidden = true; }, 2600);
    }

    // =========================================================================
    // Clock in — my time card
    // =========================================================================
    const personalEl = $('#personalMode');
    let punching = false;

    function renderPersonal() {
        const me = myId() ? storage.getEmployeeById(myId()) : null;

        if (!me) {
            // Open mode only: with sign-in the person is already known
            const staff = sheets.authOn ? [] : storage.getEmployees();
            personalEl.innerHTML = staff.length ? `
                <div class="who">
                    <h1>Who are you?</h1>
                    <p>Pick your name once. This phone will remember it.</p>
                    <div class="who-list">
                        ${staff.map(e => `
                            <button class="who-pick" data-pick="${esc(e.id)}">
                                <span class="avatar" style="--c:${esc(e.avatarColor)}">${esc(U.initials(e.name))}</span>
                                <span class="tile-text"><b>${esc(e.name)}</b><small>${esc([e.role, e.department].filter(Boolean).join(' · '))}</small></span>
                            </button>`).join('')}
                    </div>
                </div>` : emptyTeamHtml();
            return;
        }

        const now = new Date();
        const status = engine.getStatus(me.id);
        const isIn = status.state === 'in';
        const todayKey = U.dateKey(now);
        const monday = U.weekStart(now);
        const mine = storage.getRecords().filter(r => r.employeeId === me.id);
        const flash = state.flash && state.flash.empId === me.id ? state.flash : null;
        let weekMinutes = 0;

        const rows = Array.from({ length: 7 }, (_, i) => {
            const day = U.addDays(monday, i);
            const key = U.dateKey(day);
            const records = mine.filter(r => r.date === key).sort((a, b) => a.arrivalIso.localeCompare(b.arrivalIso));
            const first = records[0];
            const last = records[records.length - 1];
            const minutes = records.reduce((sum, r) => sum + (engine.minutesWorked(r, now) || 0), 0);
            weekMinutes += minutes;

            const isToday = key === todayKey;
            const freshInk = action => (isToday && flash && flash.action === action ? ' is-fresh' : '');
            const ink = (iso, id, action) => iso
                ? `<span class="ink${freshInk(action)}" style="--r:${stampAngle(id + action)}deg">${esc(U.fmtTime(iso))}</span>`
                : '';

            let out = '';
            if (last) {
                if (last.departureIso) out = ink(last.departureIso, last.id, 'out');
                else if (last.status === 'MISSED' || !engine.isOpen(last)) out = '<span class="ink is-alert" style="--r:-2deg">NO OUT</span>';
            }

            return `
                <div class="tc-row${isToday ? ' is-today' : ''}${day > now && !isToday ? ' is-future' : ''}" role="row">
                    <span role="cell">${day.toLocaleDateString(undefined, { weekday: 'short' })} <b>${day.getDate()}</b></span>
                    <span role="cell">${first ? ink(first.arrivalIso, first.id, 'in') : ''}</span>
                    <span role="cell">${out}</span>
                    <span role="cell" class="tc-hours">${records.length ? esc(U.fmtDuration(minutes)) : ''}</span>
                </div>`;
        }).join('');

        const sunday = U.addDays(monday, 6);
        const weekLabel = `${monday.getDate()} ${monday.toLocaleDateString(undefined, { month: 'short' })} – ${sunday.getDate()} ${sunday.toLocaleDateString(undefined, { month: 'short' })}`;

        let line = 'You have not clocked in today.';
        if (isIn) line = `${U.fmtDuration(engine.minutesWorked(status.record, now))} worked so far`;
        else if (status.state === 'done') line = `Clocked out at ${U.fmtTime(status.record.departureIso)}.`;

        // The blob stays in the page between renders so its animation is never cut short
        let blob = $('#punchBtn', personalEl);
        if (!blob || blob.dataset.emp !== me.id) {
            personalEl.innerHTML = `
                <div class="blob-stage">
                    <button class="blob" id="punchBtn" data-emp="${esc(me.id)}">
                        <span class="blob-aura is-far"></span>
                        <span class="blob-aura"></span>
                        <span class="blob-ring"></span>
                        <span class="blob-ring"></span>
                        <span class="blob-body"></span>
                        <span class="blob-face">
                            <span class="blob-label"></span>
                            <span class="blob-sub"></span>
                        </span>
                        <span class="blob-done" aria-hidden="true">
                            <svg class="blob-check" viewBox="0 0 52 52"><path d="M13 27.5l9 9L39.5 17"/></svg>
                            <span class="blob-done-text"></span>
                            <span class="blob-done-time"></span>
                        </span>
                    </button>
                </div>
                <div id="personalRest" class="personal-rest"></div>`;
            blob = $('#punchBtn', personalEl);
        }
        blob.dataset.state = isIn ? 'in' : 'out';
        blob.classList.toggle('is-working', punching);
        $('.blob-label', blob).textContent = isIn ? 'Clock out' : 'Clock in';
        let sub = isIn ? `In since ${U.fmtTime(status.record.arrivalIso)}` : 'Tap to start';
        if (punching) sub = isIn ? 'Clocking out…' : 'Clocking in…';
        $('.blob-sub', blob).textContent = sub;

        $('#personalRest').innerHTML = `
            <p class="punch-line">${esc(line)}</p>

            <article class="timecard" aria-label="This week's time card">
                <header class="tc-head">
                    <div class="tc-title"><span>Time card</span><code>${esc(me.id)}</code></div>
                    <dl>
                        <div><dt>Name</dt><dd>${esc(me.name)}</dd></div>
                        <div><dt>Week</dt><dd>${esc(weekLabel)}</dd></div>
                    </dl>
                </header>
                <div class="tc-table" role="table">
                    <div class="tc-row tc-cols" role="row">
                        <span role="columnheader">Day</span><span role="columnheader">In</span><span role="columnheader">Out</span><span role="columnheader">Hours</span>
                    </div>
                    ${rows}
                </div>
                <footer class="tc-foot"><span>Week total</span><b>${esc(weekMinutes ? U.fmtDuration(weekMinutes) : '0h')}</b></footer>
            </article>

            <div class="personal-links">
                <button class="link-btn" data-me="qr">${icon('qr')}<span>Show my QR code</span></button>
                ${sheets.authOn ? '' : '<button class="link-btn" data-me="switch">Not you? Switch person</button>'}
            </div>`;
    }

    // A signed-in phone asks the sheet to punch: the sheet checks who it is,
    // where the phone is, and stamps the time itself.
    async function punchViaSheet() {
        punching = true;
        renderPersonal();
        try {
            if (navigator.vibrate) navigator.vibrate(15);
        } catch (e) { /* not allowed here */ }
        try {
            const res = await sheets.punch({ geo: await currentLocation() });
            punching = false;
            handlePunch(fromSheet(res), 'phone');
        } catch (err) {
            punching = false;
            // After a location refusal, the next try must use a fresh position
            if (err.code === 'geo') lastFix = null;
            sound.playNotice();
            alertToast(err);
            render();
        }
    }

    personalEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="add-staff"]')) return openStaffDialog();

        const pick = e.target.closest('[data-pick]');
        if (pick) {
            settings = storage.saveSettings({ me: pick.dataset.pick });
            return renderPersonal();
        }

        const blobBtn = e.target.closest('#punchBtn');
        if (blobBtn) {
            // Taps during the confirmation animation would clock straight back out
            if (punching || blobBtn.classList.contains('is-celebrating') || Date.now() - (lastTap.me || 0) < 1200) return;
            lastTap.me = Date.now();
            if (sheets.authOn) return punchViaSheet();
            return handlePunch(engine.punch(myId(), 'PHONE'), 'phone');
        }

        const link = e.target.closest('[data-me]');
        if (!link) return;
        if (link.dataset.me === 'switch') {
            settings = storage.saveSettings({ me: '' });
            renderPersonal();
        } else {
            const me = storage.getEmployeeById(myId());
            if (!me) return;
            $('#qrName').textContent = me.name;
            badges.renderEmployeeQR($('#qrCanvas'), me.badgeCode || me.id, 240);
            $('#qrDialog').showModal();
        }
    });

    // --- Front desk / my time card switch ---
    function renderClockView() {
        const personal = deviceMode() === 'personal';
        $('#kioskMode').hidden = personal;
        personalEl.hidden = !personal;
        $$('.mode-switch button').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.mode === deviceMode()));
        });
        if (personal) renderPersonal();
        else renderGrid();
    }

    $$('.mode-switch button').forEach(button => button.addEventListener('click', () => {
        if (!canManage() || button.dataset.mode === settings.deviceMode) return;
        settings = storage.saveSettings({ deviceMode: button.dataset.mode });
        stopCamera();
        renderClockView();
    }));

    // =========================================================================
    // Timesheet
    // =========================================================================
    const ledger = $('#ledger');
    const RANGE_LABELS = { today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', month: 'Last 30 days' };

    function filteredRecords() {
        const now = new Date();
        const today = U.dateKey(now);
        const yesterday = U.dateKey(U.addDays(now, -1));
        const from = { week: U.dateKey(U.addDays(now, -6)), month: U.dateKey(U.addDays(now, -29)) }[state.range];
        const query = state.tsQuery.toLowerCase();

        return storage.getRecords().filter(r => {
            if (state.range === 'today' && r.date !== today) return false;
            if (state.range === 'yesterday' && r.date !== yesterday) return false;
            if (from && (r.date < from || r.date > today)) return false;
            return !query || `${r.employeeName} ${r.employeeId} ${r.notes || ''}`.toLowerCase().includes(query);
        });
    }

    function recordStatus(record) {
        if (record.departureIso) return { label: 'Done', tone: 'done' };
        if (engine.isOpen(record)) return { label: 'In', tone: 'in' };
        return { label: 'No clock-out', tone: 'alert' };
    }

    function renderTimesheet() {
        const records = filteredRecords();
        const total = records.reduce((sum, r) => sum + (engine.minutesWorked(r) || 0), 0);
        $('#tsSummary').textContent = records.length
            ? `${records.length} ${records.length === 1 ? 'entry' : 'entries'} · ${U.fmtDuration(total)} worked`
            : '';

        if (!records.length) {
            ledger.innerHTML = `
                <div class="empty">
                    <h2>${state.tsQuery ? 'No matching entries' : `No entries for ${RANGE_LABELS[state.range].toLowerCase()}`}</h2>
                    <p>${state.tsQuery ? 'Try a different name, or widen the period.' : 'Punches show up here as they happen. You can also add one by hand.'}</p>
                </div>`;
            return;
        }

        ledger.innerHTML = `
            <div class="ledger-head" aria-hidden="true">
                <span>Staff</span><span>Date</span><span>In</span><span>Out</span><span>Hours</span><span>Status</span>
            </div>
            ${records.map(r => {
                const status = recordStatus(r);
                const meta = [METHOD_LABELS[r.method] || 'Front desk', r.notes].filter(Boolean).join(' · ');
                const minutes = engine.minutesWorked(r);
                return `
                    <button class="ledger-row" data-id="${esc(r.id)}" aria-label="Edit entry for ${esc(r.employeeName)}, ${esc(U.fmtDay(r.date))}">
                        <span class="c-name"><b>${esc(r.employeeName)}</b><small>${esc(meta)}</small></span>
                        <span class="c-date">${esc(U.fmtDay(r.date))}</span>
                        <span class="c-in mono">${esc(U.fmtTime(r.arrivalIso))}</span>
                        <span class="c-out mono">${esc(U.fmtTime(r.departureIso)) || '–'}</span>
                        <span class="c-hours mono">${minutes == null ? '–' : esc(U.fmtDuration(minutes))}</span>
                        <span class="c-status"><span class="chip chip-${status.tone}">${status.label}</span></span>
                    </button>`;
            }).join('')}`;
    }

    $$('#rangeFilter button').forEach(button => button.addEventListener('click', () => {
        state.range = button.dataset.range;
        $$('#rangeFilter button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
        renderTimesheet();
    }));

    $('#tsSearch').addEventListener('input', (e) => {
        state.tsQuery = e.target.value.trim();
        renderTimesheet();
    });

    ledger.addEventListener('click', (e) => {
        const row = e.target.closest('.ledger-row');
        if (row) openEntryDialog(row.dataset.id);
    });

    $('#exportBtn').addEventListener('click', () => {
        const records = filteredRecords();
        if (!records.length) return toast('There are no entries to export for this period.');
        const rows = [['Employee ID', 'Name', 'Date', 'Clock in', 'Clock out', 'Hours', 'Status', 'Method', 'Notes']];
        records.forEach(r => {
            const minutes = r.departureIso ? U.minutesBetween(r.arrivalIso, r.departureIso) : null;
            rows.push([
                r.employeeId, r.employeeName, r.date, U.fmtTime(r.arrivalIso), U.fmtTime(r.departureIso),
                minutes == null ? '' : (minutes / 60).toFixed(2),
                recordStatus(r).label, METHOD_LABELS[r.method] || 'Front desk', r.notes || ''
            ]);
        });
        storage.exportToCSV(rows, `Attendance_${state.range}_${U.dateKey()}.csv`);
    });

    // --- Add / edit entry ---
    const entryDialog = $('#entryDialog');
    const entryFields = {
        employee: $('#entryEmployee'), date: $('#entryDate'), in: $('#entryIn'),
        out: $('#entryOut'), notes: $('#entryNotes')
    };

    function updateEntryHint() {
        const times = engine.resolveTimes(entryFields.date.value, entryFields.in.value, entryFields.out.value);
        let hint = '';
        if (times && times.departure) {
            hint = `${U.fmtDuration(times.minutes)} worked${times.overnight ? ' · ends the next day' : ''}`;
        } else if (times) {
            hint = 'No clock-out: this person will show as still in.';
        }
        $('#entryHint').textContent = hint;
        $('#entryError').textContent = '';
    }

    function openEntryDialog(recordId) {
        if (!canManage()) return;
        const record = recordId ? storage.getRecord(recordId) : null;
        const staff = storage.getEmployees();
        if (!record && !staff.length) return toast('Add a staff member first.');

        state.editingRecordId = record ? record.id : null;
        $('#entryTitle').textContent = record ? 'Edit entry' : 'Add entry';
        $('#entryDeleteBtn').hidden = !record;

        entryFields.employee.innerHTML = record
            ? `<option value="${esc(record.employeeId)}">${esc(record.employeeName)}</option>`
            : `<option value="">Choose…</option>${staff.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}`;
        entryFields.employee.disabled = !!record;
        entryFields.date.max = U.dateKey();
        entryFields.date.value = record ? record.date : U.dateKey();
        entryFields.in.value = record ? U.timeInput(record.arrivalIso) : '';
        entryFields.out.value = record && record.departureIso ? U.timeInput(record.departureIso) : '';
        entryFields.notes.value = record ? (record.notes || '') : '';
        updateEntryHint();
        entryDialog.showModal();
    }

    [entryFields.date, entryFields.in, entryFields.out].forEach(el => el.addEventListener('input', updateEntryHint));
    $('#addEntryBtn').addEventListener('click', () => openEntryDialog());

    $('#entryForm').addEventListener('submit', (e) => {
        e.preventDefault();
        if (!canManage()) return;
        const result = engine.saveEntry({
            id: state.editingRecordId,
            employeeId: entryFields.employee.value,
            date: entryFields.date.value,
            inTime: entryFields.in.value,
            outTime: entryFields.out.value,
            notes: entryFields.notes.value
        });
        if (!result.ok) {
            $('#entryError').textContent = result.message;
            const field = entryFields[result.field];
            if (field && !field.disabled) field.focus();
            return;
        }
        entryDialog.close();
        toast('Entry saved');
    });

    $('#entryDeleteBtn').addEventListener('click', () => {
        const record = storage.getRecord(state.editingRecordId);
        entryDialog.close();
        if (!record || !canManage()) return;
        storage.deleteRecord(record.id);
        toast('Entry deleted', {
            duration: 7000,
            action: { label: 'Undo', run: () => storage.putRecord(record) }
        });
    });

    // =========================================================================
    // Team
    // =========================================================================
    const teamGrid = $('#teamGrid');

    function renderTeam() {
        const staff = storage.getEmployees();
        const session = sheets.getSession();
        $('#teamSummary').textContent = staff.length ? `${staff.length} ${staff.length === 1 ? 'person' : 'people'}` : '';
        $('#printBadgesBtn').hidden = !staff.length;

        if (!staff.length) {
            teamGrid.innerHTML = emptyTeamHtml();
            return;
        }

        teamGrid.innerHTML = staff.map(emp => {
            const chips = [];
            if (sheets.authOn) {
                if (emp.access === 'supervisor') chips.push('<span class="chip chip-accent">Supervisor</span>');
                if (!emp.hasPin) chips.push('<span class="chip chip-alert">No PIN yet</span>');
            }
            const isMe = session && session.id === emp.id;
            return `
                <article class="member" data-emp="${esc(emp.id)}">
                    <div class="member-main">
                        <span class="avatar" style="--c:${esc(emp.avatarColor)}">${esc(U.initials(emp.name))}</span>
                        <div class="tile-text">
                            <b>${esc(emp.name)}${isMe ? ' <span class="you">you</span>' : ''}</b>
                            <small>${esc([emp.role, emp.department].filter(Boolean).join(' · ') || 'No role set')}</small>
                            <span class="member-chips"><code>${esc(emp.badgeCode || emp.id)}</code>${chips.join('')}</span>
                        </div>
                        <canvas class="member-qr" aria-label="QR code for ${esc(emp.name)}"></canvas>
                    </div>
                    <div class="member-actions">
                        <button class="btn" data-act="badge">${icon('download')}<span>Badge</span></button>
                        <button class="btn" data-act="edit">${icon('edit')}<span>Edit</span></button>
                        ${isMe ? '' : `<button class="icon-btn" data-act="remove" aria-label="Remove ${esc(emp.name)}" title="Remove">${icon('trash')}</button>`}
                    </div>
                </article>`;
        }).join('');

        staff.forEach(emp => {
            const card = teamGrid.querySelector(`[data-emp="${CSS.escape(emp.id)}"]`);
            badges.renderEmployeeQR($('canvas', card), emp.badgeCode || emp.id, 76);
        });
    }

    teamGrid.addEventListener('click', async (e) => {
        if (e.target.closest('[data-action="add-staff"]')) return openStaffDialog();
        const button = e.target.closest('[data-act]');
        if (!button || !canManage()) return;
        const emp = storage.getEmployeeById(button.closest('.member').dataset.emp);
        if (!emp) return;

        if (button.dataset.act === 'badge') badges.downloadBadge(emp.id);
        if (button.dataset.act === 'edit') openStaffDialog(emp.id);
        if (button.dataset.act === 'remove') {
            const yes = await confirmAction(`Remove ${emp.name}?`, 'They will no longer be able to sign in or clock in. Their past entries stay in the timesheet.', 'Remove');
            if (!yes) return;
            storage.deleteEmployee(emp.id);
            toast(`${emp.name} removed`);
        }
    });

    // --- Add / edit staff ---
    const staffDialog = $('#staffDialog');
    const staffSupervisor = $('#staffSupervisor');

    function paintPinState(emp) {
        $('#staffPinState').textContent = emp.hasPin
            ? 'Set. Reset it if they forget it; that also signs them out everywhere.'
            : 'Not set yet. They cannot sign in until you set one.';
        $('#staffPinBtn').textContent = emp.hasPin ? 'Reset PIN' : 'Set PIN';
    }

    function openStaffDialog(employeeId) {
        if (!canManage()) return;
        const emp = employeeId ? storage.getEmployeeById(employeeId) : null;
        const session = sheets.getSession();
        state.editingStaffId = emp ? emp.id : null;
        $('#staffTitle').textContent = emp ? 'Edit staff' : 'Add staff';
        $('#staffSaveBtn').textContent = emp ? 'Save changes' : 'Add staff';
        $('#staffName').value = emp ? emp.name : '';
        $('#staffRole').value = emp ? emp.role : '';
        $('#staffDept').value = emp ? emp.department : '';
        $('#staffError').textContent = '';

        // Access and PIN live on the sheet, so they need a connection and an existing person
        $('#staffAccess').hidden = !(emp && sheets.authOn);
        if (emp && sheets.authOn) {
            staffSupervisor.checked = emp.access === 'supervisor';
            staffSupervisor.disabled = !!session && session.id === emp.id;
            paintPinState(emp);
        }
        staffDialog.showModal();
    }

    $('#addStaffBtn').addEventListener('click', () => openStaffDialog());

    $('#staffPinBtn').addEventListener('click', async () => {
        const emp = storage.getEmployeeById(state.editingStaffId);
        if (!emp) return;
        const button = $('#staffPinBtn');
        button.disabled = true;
        try {
            await sheets.pushNow();
            const res = await sheets.resetPin(emp.id);
            staffDialog.close();
            showNewPin(emp.name, res.pin);
        } catch (err) {
            $('#staffError').textContent = err.message;
        }
        button.disabled = false;
    });

    $('#staffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!canManage()) return;
        const name = $('#staffName').value.trim();
        if (!name) {
            $('#staffError').textContent = 'Enter the person\'s name.';
            return $('#staffName').focus();
        }
        const duplicate = storage.getEmployees().find(emp => emp.name.toLowerCase() === name.toLowerCase() && emp.id !== state.editingStaffId);
        if (duplicate) {
            $('#staffError').textContent = `${duplicate.name} is already on the team.`;
            return $('#staffName').focus();
        }

        const before = state.editingStaffId ? storage.getEmployeeById(state.editingStaffId) : null;
        const wantAccess = staffSupervisor.checked ? 'supervisor' : 'staff';
        const saved = storage.saveEmployee({
            id: state.editingStaffId,
            name,
            role: $('#staffRole').value,
            department: $('#staffDept').value
        });
        staffDialog.close();

        if (!sheets.authOn) return toast(before ? 'Changes saved' : `${saved.name} added`);

        try {
            await sheets.pushNow();
            if (before) {
                if (!staffSupervisor.disabled && wantAccess !== (before.access || 'staff')) {
                    await sheets.setAccess(saved.id, wantAccess);
                    return toast(wantAccess === 'supervisor' ? `${saved.name} is now a supervisor` : `${saved.name} is no longer a supervisor`);
                }
                toast('Changes saved');
            } else {
                // A new person needs a PIN before they can sign in
                const res = await sheets.resetPin(saved.id);
                showNewPin(saved.name, res.pin);
            }
        } catch (err) {
            toast(before
                ? `Saved on this device, but the sheet could not be updated: ${err.message}`
                : `${saved.name} was added, but their PIN could not be set: ${err.message} Open Team › Edit to set it.`,
                { tone: 'alert', duration: 9000 });
        }
        render();
    });

    // =========================================================================
    // Printing
    // =========================================================================
    const printArea = $('#printArea');

    function printDocument(kind, html) {
        printArea.innerHTML = html;
        document.body.dataset.print = kind;
        window.addEventListener('afterprint', () => {
            delete document.body.dataset.print;
            printArea.innerHTML = '';
        }, { once: true });
        const images = $$('img', printArea).map(img => img.decode().catch(() => {}));
        Promise.all(images).then(() => window.print());
    }

    $('#printBtn').addEventListener('click', () => {
        const records = filteredRecords();
        if (!records.length) return toast('There are no entries to print for this period.');
        const org = config.orgName || 'Attendance';
        printDocument('timesheet', `
            <header class="print-head">
                <h1>${esc(org)}</h1>
                <p>Attendance register · ${esc(RANGE_LABELS[state.range])} · printed ${esc(new Date().toLocaleString())}</p>
            </header>
            <table class="print-table">
                <thead><tr><th>Staff</th><th>Date</th><th>In</th><th>Out</th><th>Hours</th><th>Status</th><th>Note</th></tr></thead>
                <tbody>
                    ${records.map(r => {
                        const minutes = engine.minutesWorked(r);
                        return `<tr>
                            <td>${esc(r.employeeName)}</td><td>${esc(U.fmtDay(r.date))}</td>
                            <td>${esc(U.fmtTime(r.arrivalIso))}</td><td>${esc(U.fmtTime(r.departureIso))}</td>
                            <td>${minutes == null ? '' : esc(U.fmtDuration(minutes))}</td>
                            <td>${recordStatus(r).label}</td><td>${esc(r.notes || '')}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            <div class="print-sign"><span>Prepared by</span><span>Approved by</span></div>`);
    });

    $('#printBadgesBtn').addEventListener('click', () => {
        const staff = storage.getEmployees();
        printDocument('badges', `
            <div class="print-badges">
                ${staff.map(emp => `<img src="${badges.badgeDataUrl(emp)}" alt="Badge for ${esc(emp.name)}">`).join('')}
            </div>`);
    });

    // =========================================================================
    // Settings
    // =========================================================================
    const settingsDialog = $('#settingsDialog');
    const settingsBody = $('#settingsBody');
    const syncChip = $('#syncChip');

    function connectionText(status) {
        const waiting = `${status.queued} ${status.queued === 1 ? 'change' : 'changes'}`;
        switch (status.phase) {
            case 'off': return { chip: 'Not connected', title: 'Not connected', detail: 'Entries are saved on this device only.' };
            case 'offline': return { chip: 'Offline', title: 'Offline', detail: status.queued ? `${waiting} will upload when the connection is back.` : 'Everything is saved on this device.' };
            case 'syncing': return { chip: 'Syncing', title: 'Syncing…', detail: status.queued ? `Uploading ${waiting}.` : 'Checking the sheet for updates.' };
            case 'error': return { chip: 'Sync problem', title: 'Sync problem', detail: `${status.error} ${status.queued ? `${waiting} are safe on this device and will upload once this is fixed.` : ''}` };
            case 'pending': return { chip: `${status.queued} waiting`, title: `${waiting} waiting to upload`, detail: 'They are saved on this device.' };
            default: return {
                chip: 'Synced',
                title: status.sheetName ? `Connected to “${status.sheetName}”` : 'Connected',
                detail: `${status.lastSyncAt ? `Last synced at ${U.fmtTime(status.lastSyncAt)}. ` : ''}Entries are in the “Attendance” tab of the sheet, staff in the “Staff” tab.`
            };
        }
    }

    function renderConnection(status) {
        const text = connectionText(status);
        syncChip.dataset.phase = status.phase;
        $('#syncChipLabel').textContent = text.chip;

        const box = $('#connBox');
        if (!box) return;
        box.dataset.phase = status.phase;
        box.innerHTML = `
            <i aria-hidden="true"></i>
            <div><b>${esc(text.title)}</b><p>${esc(text.detail)}</p></div>
            ${status.url ? '<button class="btn" data-set="sync">Sync now</button>' : ''}`;
    }

    function accountBlock() {
        const session = sheets.getSession();
        if (!session) return '';
        return `
            <section class="set-block">
                <h3>Signed in</h3>
                <div class="set-line">
                    <span class="set-text"><b>${esc(session.name)}</b><small>${session.role === 'supervisor' ? 'Supervisor' : 'Staff'}</small></span>
                    <span class="set-row">
                        <button class="btn" data-set="change-pin">Change PIN</button>
                        <button class="btn" data-set="sign-out">Sign out</button>
                    </span>
                </div>
            </section>`;
    }

    function rulesBlock() {
        const shared = sheets.shared;
        const hasPlace = shared.lat !== '' && shared.lat !== undefined && shared.lng !== '' && shared.lng !== undefined;
        const radius = Number(shared.radius) || 200;
        return `
            <section class="set-block">
                <h3>Clock-in rules</h3>
                <label class="set-line">
                    <span class="set-text"><b>Only at the office</b><small>Staff phones can clock in and out only when they are within range of the office.</small></span>
                    <input type="checkbox" class="switch" id="setGeo" ${shared.geoOn ? 'checked' : ''}>
                </label>
                <div class="set-line">
                    <span class="set-text"><b>Office location</b><small>${hasPlace ? `Saved (${Number(shared.lat).toFixed(5)}, ${Number(shared.lng).toFixed(5)}).` : 'Not set yet.'} Stand in the office and press the button.</small></span>
                    <button class="btn" data-set="geo-here">${hasPlace ? 'Update' : 'Use where I am now'}</button>
                </div>
                <div class="set-line">
                    <span class="set-text"><b>Range</b><small>How far from that spot still counts as the office.</small></span>
                    <div class="segmented" role="group" aria-label="Range">
                        ${[100, 200, 500].map(r => `<button data-radius="${r}" aria-pressed="${r === radius}">${r} m</button>`).join('')}
                    </div>
                </div>
                <label class="set-line">
                    <span class="set-text"><b>PIN at the front desk</b><small>Tapping a name on a shared screen asks for that person's PIN.</small></span>
                    <input type="checkbox" class="switch" id="setKioskPin" ${shared.kioskPin !== false ? 'checked' : ''}>
                </label>
            </section>`;
    }

    function sheetBlock(status) {
        return `
            <section class="set-block">
                <h3>Google Sheet</h3>
                <div id="connBox" class="conn"></div>
                ${status.isPreset ? `
                    <p class="field-hint">The link is set in <code>js/config.js</code>, so every device that opens this app uses the same sheet.</p>
                ` : `
                    <label class="field">
                        <span>Web app URL</span>
                        <input type="url" id="sheetUrl" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(status.url)}">
                    </label>
                    <p id="sheetUrlError" class="field-error" role="alert"></p>
                    <div class="set-row">
                        <button class="btn btn-primary" data-set="connect">${status.url ? 'Update link' : 'Connect'}</button>
                        ${status.url ? '<button class="btn" data-set="disconnect">Disconnect</button>' : ''}
                    </div>
                    <p class="field-hint">To connect every device at once, put this URL in <code>js/config.js</code> instead.</p>
                `}
                <details class="steps" ${status.url ? '' : 'open'}>
                    <summary>How to set up or update the sheet</summary>
                    <ol>
                        <li>Open your Google Sheet and choose <b>Extensions › Apps Script</b>.</li>
                        <li>Delete the code that is there, paste the script, and save.
                            <button class="btn btn-small" data-set="copy">Copy script</button></li>
                        <li>First time: <b>Deploy › New deployment</b>, type <b>Web app</b>, <b>Execute as: Me</b>, <b>Who has access: Anyone</b>.<br>
                            Updating: <b>Deploy › Manage deployments › Edit › Version: New version</b>. The URL stays the same.</li>
                        <li>The <b>Web app URL</b> ends in <code>/exec</code>.</li>
                    </ol>
                </details>
            </section>`;
    }

    // Chrome and Edge offer an install prompt; iPhones install from the Share menu
    let installPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        installPrompt = e;
    });
    const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const isIphone = /iphone|ipad|ipod/i.test(navigator.userAgent);

    function installLine() {
        if (isInstalled()) return '';
        if (installPrompt) {
            return `<div class="set-line"><span class="set-text"><b>Install the app</b><small>Puts PDN Clock on this device's home screen and opens it full screen.</small></span><button class="btn btn-primary" data-set="install">Install</button></div>`;
        }
        if (isIphone) {
            return `<div class="set-line"><span class="set-text"><b>Install the app</b><small>In Safari, tap the Share button, then “Add to Home Screen”.</small></span></div>`;
        }
        return '';
    }

    function renderSettings() {
        const status = sheets.getStatus();
        const theme = settings.theme || 'auto';
        const manage = canManage();

        settingsBody.innerHTML = `
            ${accountBlock()}
            ${manage && sheets.authOn ? rulesBlock() : ''}
            ${manage ? sheetBlock(status) : ''}
            <section class="set-block">
                <h3>This device</h3>
                ${installLine()}
                <label class="set-line">
                    <span>Sounds</span>
                    <input type="checkbox" class="switch" id="setSound" ${settings.sound !== false ? 'checked' : ''}>
                </label>
                <div class="set-line">
                    <span>Appearance</span>
                    <div class="segmented" id="setTheme" role="group" aria-label="Appearance">
                        ${['auto', 'light', 'dark'].map(t => `<button data-theme-opt="${t}" aria-pressed="${t === theme}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
                    </div>
                </div>
            </section>`;
        renderConnection(status);
    }

    function openSettings() {
        if (isLocked()) return;
        renderSettings();
        settingsDialog.showModal();
    }

    syncChip.addEventListener('click', openSettings);
    $('#settingsBtn').addEventListener('click', openSettings);

    // Save a shared rule on the sheet, then redraw from what the sheet accepted
    async function saveRule(patch) {
        try {
            await sheets.saveShared(patch);
        } catch (err) {
            alertToast(err);
        }
        if (settingsDialog.open) renderSettings();
    }

    settingsBody.addEventListener('click', async (e) => {
        const themeButton = e.target.closest('[data-theme-opt]');
        if (themeButton) {
            const theme = themeButton.dataset.themeOpt;
            settings = storage.saveSettings({ theme });
            if (theme === 'auto') delete document.documentElement.dataset.theme;
            else document.documentElement.dataset.theme = theme;
            $$('#setTheme button').forEach(b => b.setAttribute('aria-pressed', String(b === themeButton)));
            return;
        }

        const radiusButton = e.target.closest('[data-radius]');
        if (radiusButton) return saveRule({ radius: Number(radiusButton.dataset.radius) });

        const button = e.target.closest('[data-set]');
        if (!button) return;
        const action = button.dataset.set;

        if (action === 'sync') sheets.sync();

        if (action === 'install' && installPrompt) {
            installPrompt.prompt();
            await installPrompt.userChoice.catch(() => {});
            installPrompt = null;
            renderSettings();
        }

        if (action === 'copy') {
            const ok = await copyText(window.PDN_APPS_SCRIPT);
            toast(ok ? 'Script copied. Paste it into Apps Script.' : 'Could not copy. Open js/appsScript.js and copy the script from there.', ok ? {} : { tone: 'alert' });
        }

        if (action === 'connect') {
            const errorEl = $('#sheetUrlError');
            errorEl.textContent = '';
            button.disabled = true;
            button.textContent = 'Checking…';
            try {
                await sheets.connect($('#sheetUrl').value);
                settingsDialog.close();
                showGate();
            } catch (err) {
                errorEl.textContent = err.code === 'outdated'
                    ? 'That sheet is running an older script. Replace it using the steps below, then connect again.'
                    : err.message;
                button.disabled = false;
                button.textContent = sheets.url ? 'Update link' : 'Connect';
            }
        }

        if (action === 'disconnect') {
            const yes = await confirmAction('Disconnect the sheet?', 'This device will stop using the sheet and go back to working on its own. Entries already in the sheet stay there.', 'Disconnect');
            if (!yes) return;
            sheets.disconnect();
            settingsDialog.close();
            applyRole();
            render();
        }

        if (action === 'sign-out') {
            settingsDialog.close();
            settings = storage.saveSettings({ kioskLocked: false });
            sheets.signOut();
        }

        if (action === 'change-pin') {
            const session = sheets.getSession();
            settingsDialog.close();
            let current = '';
            const known = await askPin({
                title: 'Change PIN',
                text: 'Enter your current PIN.',
                submit: async (pin) => {
                    await sheets.login(session.id, pin);
                    current = pin;
                }
            });
            if (!known) return;
            const next = await chooseNewPin('New PIN');
            if (!next) return;
            try {
                await sheets.changePin(current, next);
                toast('PIN changed');
            } catch (err) {
                alertToast(err);
            }
        }

        if (action === 'geo-here') {
            button.disabled = true;
            button.textContent = 'Finding you…';
            try {
                const here = await getLocation();
                await sheets.saveShared({ lat: here.lat, lng: here.lng });
                toast(`Office location saved (accurate to about ${here.acc} m)`);
            } catch (err) {
                alertToast(err);
            }
            renderSettings();
        }
    });

    settingsBody.addEventListener('change', (e) => {
        if (e.target.id === 'setSound') {
            settings = storage.saveSettings({ sound: e.target.checked });
            sound.setEnabled(e.target.checked);
            if (e.target.checked) sound.playClockIn();
        }
        if (e.target.id === 'setKioskPin') saveRule({ kioskPin: e.target.checked });
        if (e.target.id === 'setGeo') {
            const shared = sheets.shared;
            if (e.target.checked && (shared.lat === '' || shared.lat === undefined)) {
                e.target.checked = false;
                return toast('Set the office location first: stand in the office and press “Use where I am now”.', { duration: 7000 });
            }
            saveRule({ geoOn: e.target.checked });
        }
    });

    sheets.onStatusChange = (status) => {
        renderConnection(status);
        const finished = sheets.completed !== seenCompleted;
        seenCompleted = sheets.completed;
        if (finished) warmLocation();
        // Keep the "loading the team" message in step with the connection
        if (!storage.getEmployees().length && (finished || status.phase === 'offline')) render();
    };

    // =========================================================================
    // Render loop and start-up
    // =========================================================================
    function render() {
        if (appEl.hidden) return;
        renderTally();
        if (state.view === 'clock') renderClockView();
        else if (state.view === 'timesheet') renderTimesheet();
        else renderTeam();
    }

    storage.onChange(() => {
        settings = storage.getSettings();
        render();
    });

    engine.sweepStale();
    tick();
    if (role() === 'out') {
        showGate();
    } else {
        enterApp();
        warmLocation();
    }
    sheets.start();
});
