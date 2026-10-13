/**
 * Sound effects, synthesised with the Web Audio API (no audio files).
 * A rising chime for clock-in, a falling one for clock-out, a low note for problems.
 */
class SoundFX {
    constructor() {
        this.ctx = null;
        this.enabled = true;
    }

    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) this.ctx = new AudioContext();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    setEnabled(val) {
        this.enabled = !!val;
    }

    chime(notes, type, spacing, peak) {
        if (!this.enabled) return;
        this.init();
        if (!this.ctx) return;

        const startAt = this.ctx.currentTime;
        notes.forEach((freq, index) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const noteStart = startAt + index * spacing;

            osc.type = type;
            osc.frequency.setValueAtTime(freq, noteStart);
            gain.gain.setValueAtTime(0.0001, noteStart);
            gain.gain.exponentialRampToValueAtTime(peak, noteStart + 0.018);
            gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.4);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(noteStart);
            osc.stop(noteStart + 0.45);
        });
    }

    playClockIn() {
        this.chime([523.25, 659.25, 783.99], 'sine', 0.08, 0.3);       // C5 E5 G5
    }

    playClockOut() {
        this.chime([783.99, 659.25, 523.25], 'triangle', 0.09, 0.26);  // G5 E5 C5
    }

    // Unknown badge or a problem
    playNotice() {
        this.chime([440, 349.23], 'sine', 0.1, 0.2);                   // A4 F4
    }
}

window.soundFX = new SoundFX();
