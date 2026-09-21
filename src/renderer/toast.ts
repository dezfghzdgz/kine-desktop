import type { KineBridge } from '../preload/preload';
import { applyBrandColor } from '../shared/plan';

/**
 * Okénko v rohu: text + barevný proužek + krátké pípnutí. Zvuk je
 * syntetizovaný (dva tóny), žádný soubor - a hráč ho slyší i ve hře
 * v režimu celé obrazovky, kde okénko vidět není.
 */
declare const window: Window & { kine: KineBridge };

const toast = document.getElementById('toast') as HTMLDivElement;
const msg = document.getElementById('msg') as HTMLSpanElement;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let audio: AudioContext | null = null;

function blip(kind: string) {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    const notes = kind === 'ok' ? [660, 990] : kind === 'warn' ? [440, 440] : [330, 220];
    notes.forEach((freq, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.09 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.12);
      osc.connect(gain).connect(audio!.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.14);
    });
  } catch {
    // Bez zvuku to přežijeme.
  }
}

// Barva Kine hráče i na okénku; při změně nastavení se přebarví.
void window.kine.getSettings().then((s) => applyBrandColor(document.documentElement, s.brandColor || null));
window.kine.onSettings((s) => applyBrandColor(document.documentElement, s.brandColor || null));

window.kine.onToast(({ message, kind }) => {
  msg.textContent = message;
  toast.className = `toast ${kind}`;
  requestAnimationFrame(() => toast.classList.add('show'));
  blip(kind);
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toast.classList.remove('show'), 2300);
});
