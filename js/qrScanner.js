/**
 * QR Scanner
 * Reads badge QR codes from the camera. Uses the browser's built-in
 * BarcodeDetector where it exists (Android, macOS) and the bundled jsQR
 * decoder everywhere else (Windows, iOS, Firefox).
 */
class QRScanner {
    constructor() {
        this.videoEl = null;
        this.stream = null;
        this.isScanning = false;
        this.detector = null;
        this.canvas = document.createElement('canvas');
        this.onScan = null;
        this.facingMode = 'user';       // front camera suits a desk kiosk
        this.SCAN_EVERY_MS = 140;
        this.REARM_MS = 2500;           // a badge must leave the frame this long before it counts again
        this.lastCode = null;
        this.lastSeenAt = 0;
        this.timer = null;
    }

    init(videoElement, onScan) {
        this.videoEl = videoElement;
        this.onScan = onScan;
    }

    async loadDetector() {
        if (this.detector) return;
        if ('BarcodeDetector' in window) {
            try {
                const formats = await BarcodeDetector.getSupportedFormats();
                if (formats.includes('qr_code')) {
                    const native = new BarcodeDetector({ formats: ['qr_code'] });
                    this.detector = async (video) => {
                        const found = await native.detect(video);
                        return found.length ? found[0].rawValue : null;
                    };
                    return;
                }
            } catch (err) { /* fall through to jsQR */ }
        }

        if (!window.jsQR) {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'js/vendor/jsQR.js';
                script.onload = resolve;
                script.onerror = () => reject(new Error('The QR reader could not be loaded.'));
                document.head.appendChild(script);
            });
        }

        const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.detector = async (video) => {
            if (!video.videoWidth) return null;
            // Decoding a smaller frame is much faster and still reads badges fine
            const scale = Math.min(1, 640 / video.videoWidth);
            const w = this.canvas.width = Math.round(video.videoWidth * scale);
            const h = this.canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, w, h);
            const hit = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            return hit ? hit.data : null;
        };
    }

    describeError(err) {
        if (!window.isSecureContext) return 'The camera only works over HTTPS or on localhost. Tap your name instead.';
        switch (err && err.name) {
            case 'NotAllowedError': return 'Camera access is blocked. Allow it in the browser address bar, then try again.';
            case 'NotFoundError':
            case 'OverconstrainedError': return 'No camera was found on this device.';
            case 'NotReadableError': return 'Another app is using the camera. Close it and try again.';
            default: return (err && err.message) || 'The camera could not start.';
        }
    }

    async start() {
        this.stop();
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('This browser cannot open the camera.');
            }
            await this.loadDetector();
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: this.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            this.videoEl.srcObject = this.stream;
            await this.videoEl.play();

            const track = this.stream.getVideoTracks()[0];
            const actual = (track && track.getSettings && track.getSettings().facingMode) || this.facingMode;
            this.isScanning = true;
            this.loop();
            return { ok: true, mirrored: actual !== 'environment' };
        } catch (err) {
            this.stop();
            return { ok: false, error: this.describeError(err) };
        }
    }

    stop() {
        this.isScanning = false;
        clearTimeout(this.timer);
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        if (this.videoEl) this.videoEl.srcObject = null;
    }

    flip() {
        this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
        return this.start();
    }

    async loop() {
        if (!this.isScanning) return;
        try {
            if (this.videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                const code = await this.detector(this.videoEl);
                if (code) this.handle(code.trim());
            }
        } catch (err) { /* a bad frame is not worth stopping for */ }
        if (this.isScanning) this.timer = setTimeout(() => this.loop(), this.SCAN_EVERY_MS);
    }

    // A badge held in front of the lens counts once, however long it stays there
    handle(code) {
        if (!code) return;
        const now = Date.now();
        const stillThere = code === this.lastCode && now - this.lastSeenAt < this.REARM_MS;
        this.lastCode = code;
        this.lastSeenAt = now;
        if (!stillThere && this.onScan) this.onScan(code);
    }
}

window.qrScanner = new QRScanner();
