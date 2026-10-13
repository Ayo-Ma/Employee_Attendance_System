/**
 * Badges
 * Draws staff QR codes and the downloadable / printable ID badge.
 */
class BadgeManager {
    constructor() {
        this.storage = window.clockStorage;
    }

    // Draw a QR code into a canvas. `size` is the on-screen size in CSS pixels;
    // the canvas is drawn at 2x so it stays sharp on phones and in print.
    renderEmployeeQR(canvas, code, size = 160) {
        if (!canvas || !window.BadgeQR) return;
        const pixels = size * 2;
        window.BadgeQR.renderToCanvas(canvas, String(code), {
            size: pixels,
            // Scanners need a quiet zone of 4 modules around the 29-module code
            margin: Math.round(pixels * 4 / 37),
            colorDark: '#14171c',
            colorLight: '#ffffff'
        });
        canvas.style.width = `${size}px`;
        canvas.style.height = `${size}px`;
    }

    qrDataUrl(code, size = 300) {
        const canvas = document.createElement('canvas');
        this.renderEmployeeQR(canvas, code, size);
        return canvas.toDataURL('image/png');
    }

    // Portrait ID badge as a PNG data URL
    badgeDataUrl(employee) {
        const W = 600, H = 900;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        const org = (window.PDN_CONFIG && window.PDN_CONFIG.orgName) || 'Attendance';
        const sans = '"IBM Plex Sans", "Segoe UI", Arial, sans-serif';
        const mono = '"IBM Plex Mono", Consolas, monospace';
        const code = employee.badgeCode || employee.id;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);

        // Header band
        ctx.fillStyle = '#3b2fc9';
        ctx.fillRect(0, 0, W, 150);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.font = `600 30px ${sans}`;
        ctx.fillText(org.toUpperCase(), W / 2, 72);
        ctx.font = `500 20px ${mono}`;
        ctx.fillText('STAFF ATTENDANCE BADGE', W / 2, 110);

        // Name, shrunk to fit long names
        ctx.fillStyle = '#14171c';
        let nameSize = 46;
        do {
            ctx.font = `700 ${nameSize}px ${sans}`;
            nameSize -= 2;
        } while (ctx.measureText(employee.name).width > W - 80 && nameSize > 24);
        ctx.fillText(employee.name, W / 2, 235);

        ctx.fillStyle = '#4a525e';
        ctx.font = `500 24px ${sans}`;
        ctx.fillText([employee.role, employee.department].filter(Boolean).join(' · '), W / 2, 278);

        // QR code
        const qr = document.createElement('canvas');
        this.renderEmployeeQR(qr, code, 210);
        ctx.strokeStyle = '#d3d8de';
        ctx.lineWidth = 2;
        ctx.strokeRect(90, 320, 420, 420);
        ctx.drawImage(qr, 90, 320, 420, 420);

        ctx.fillStyle = '#14171c';
        ctx.font = `600 30px ${mono}`;
        ctx.fillText(code, W / 2, 800);
        ctx.fillStyle = '#7a8492';
        ctx.font = `400 20px ${sans}`;
        ctx.fillText('Hold this code up to the front-desk camera', W / 2, 845);

        return canvas.toDataURL('image/png');
    }

    downloadBadge(employeeId) {
        const employee = this.storage.getEmployeeById(employeeId);
        if (!employee) return;
        const link = document.createElement('a');
        link.download = `Badge_${employee.name.replace(/[^\w]+/g, '_')}_${employee.id}.png`;
        link.href = this.badgeDataUrl(employee);
        document.body.appendChild(link);
        link.click();
        link.remove();
    }
}

window.badgeManager = new BadgeManager();
