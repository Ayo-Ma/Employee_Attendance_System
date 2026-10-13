/**
 * Small shared helpers: escaping, local-date maths, time formatting.
 * All dates are handled in the device's local timezone.
 */
window.U = {
    esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    },

    initials(name) {
        return String(name || '?').trim().split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
    },

    uid(prefix) {
        return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    },

    // Local calendar day as YYYY-MM-DD
    dateKey(date = new Date()) {
        const d = new Date(date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    // YYYY-MM-DD -> local midnight Date
    parseKey(key) {
        const [y, m, d] = String(key).split('-').map(Number);
        return new Date(y, (m || 1) - 1, d || 1);
    },

    addDays(date, days) {
        const d = new Date(date);
        d.setDate(d.getDate() + days);
        return d;
    },

    // Monday of the week containing `date`
    weekStart(date = new Date()) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return this.addDays(d, -((d.getDay() + 6) % 7));
    },

    // "8:41 AM"
    fmtTime(value) {
        if (!value) return '';
        const d = new Date(value);
        if (isNaN(d)) return '';
        const h = d.getHours();
        return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    },

    // "08:41" for <input type="time">
    timeInput(value) {
        const d = new Date(value);
        if (isNaN(d)) return '';
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },

    // "Tue 13 Oct"
    fmtDay(key) {
        return this.parseKey(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    },

    minutesBetween(startIso, endIso) {
        const ms = new Date(endIso) - new Date(startIso);
        return isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 60000));
    },

    // "8h 20m"
    fmtDuration(minutes) {
        if (minutes == null) return '';
        if (minutes < 1) return '0m';
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (!h) return `${m}m`;
        return m ? `${h}h ${m}m` : `${h}h`;
    },

    // Stable small number from a string, used to vary stamp angles
    hash(text) {
        let h = 0;
        for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return Math.abs(h);
    }
};
