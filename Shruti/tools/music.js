// The music under Shruti's videos (Tony, 2026-10-22: "soft music in the
// background, elegant, fitting"). Synthesised here, so it is Shruti's own and
// free of anyone's rights: a tanpura drone (the strings Pa Sa Sa Sa, plucked
// in a slow cycle, with the jawari's bright, slowly fading overtones), a soft
// pad of the drone's chord, and, in "dawn", a sparse bansuri-like line in raga
// Bhupali (Sa Re Ga Pa Dha). Through a Freeverb hall; the end is folded onto
// the start so each file loops without a seam.
//
//   NODE_PATH=<a folder with lamejs 1.2.1> node Shruti/tools/music.js
//
// Writes Shruti/media/music/<name>.mp3 (32 kHz stereo, 96 kbps) and index.json.
// video.js plays one under every video (the chapter's number picks which), at a
// low level, and mixes it into an export.
'use strict';
const fs = require('fs');
const path = require('path');
const lamejs = require('lamejs');

const RATE = 32000;
const OUT = path.join(__dirname, '..', 'media', 'music');
const SA = 138.59;   // C#3: the drone's Sa

/* a small seeded random, so every build gives the same music */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** One tanpura pluck at f Hz into buf from sample at, `len` seconds long. */
function pluck(buf, at, f, len, gain, rnd) {
  const n = Math.floor(len * RATE), H = 28;
  const amp = [], tau = [], swell = [], det = [];
  for (let k = 1; k <= H; k++) {
    amp.push(gain * Math.pow(k, -0.85) * (k === 1 ? 0.75 : 1));
    tau.push(3.4 / (1 + 0.09 * k));
    // The jawari: an overtone blooms a little after the pluck, then fades.
    swell.push(0.25 + 0.9 * rnd());
    det.push(1 + (rnd() - 0.5) * 0.0006);
  }
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / RATE;
    let v = 0;
    for (let k = 1; k <= H; k++) {
      const env = Math.exp(-t / tau[k - 1]) * (1 - Math.exp(-t / 0.004)) * (1 + 0.8 * Math.sin(Math.min(Math.PI, t * swell[k - 1] * 2.2)) * (k > 4 ? 1 : 0));
      if (env < 1e-5 && t > 0.1) continue;
      v += amp[k - 1] * env * Math.sin(2 * Math.PI * f * k * det[k - 1] * t);
    }
    buf[at + i] += v;
  }
}
/** A slow, soft pad note: two detuned voices with their octave, a long swell. */
function pad(buf, at, f, len, gain) {
  const n = Math.floor(len * RATE);
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / RATE, x = t / len;
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, x)), 2);
    const s = Math.sin(2 * Math.PI * f * t) + 0.6 * Math.sin(2 * Math.PI * f * 1.003 * t + 1) + 0.25 * Math.sin(2 * Math.PI * f * 2 * t) + 0.12 * Math.sin(2 * Math.PI * f * 3.002 * t);
    buf[at + i] += gain * env * s;
  }
}
/** A bansuri-like note: breathy attack, gentle vibrato that grows, soft release. */
function flute(buf, at, f, len, gain, rnd) {
  const n = Math.floor(len * RATE);
  let ph = 0, noise = 0;
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / RATE;
    const att = 1 - Math.exp(-t / 0.18), rel = Math.min(1, (len - t) / 0.6);
    const vib = 1 + 0.006 * Math.min(1, t / 1.2) * Math.sin(2 * Math.PI * 5.2 * t);
    ph += 2 * Math.PI * f * vib / RATE;
    noise = 0.97 * noise + 0.03 * (rnd() * 2 - 1);
    const tone = Math.sin(ph) + 0.18 * Math.sin(2 * ph) + 0.06 * Math.sin(3 * ph);
    buf[at + i] += gain * att * Math.max(0, rel) * (tone + 2.2 * noise * (0.4 + 0.6 * Math.exp(-t / 0.3)));
  }
}

/* Freeverb (Jezar's), one channel: 8 combs into 4 allpasses. */
function freeverb(input, { room = 0.86, damp = 0.35, spread = 0 } = {}) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round((d + spread) * RATE / 44100));
  const alls = [556, 441, 341, 225].map((d) => Math.round((d + spread) * RATE / 44100));
  const out = new Float32Array(input.length);
  const cb = combs.map((d) => ({ b: new Float32Array(d), i: 0, f: 0 }));
  const ab = alls.map((d) => ({ b: new Float32Array(d), i: 0 }));
  for (let n = 0; n < input.length; n++) {
    const x = input[n] * 0.015;
    let y = 0;
    for (const c of cb) {
      const o = c.b[c.i];
      c.f = o * (1 - damp) + c.f * damp;
      c.b[c.i] = x + c.f * room;
      c.i = (c.i + 1) % c.b.length;
      y += o;
    }
    for (const a of ab) {
      const o = a.b[a.i];
      a.b[a.i] = y + o * 0.5;
      a.i = (a.i + 1) % a.b.length;
      y = o - y;
    }
    out[n] = y;
  }
  return out;
}
/** A one-pole low-pass, to keep the drone's top soft. */
function lowpass(buf, hz) {
  const a = Math.exp(-2 * Math.PI * hz / RATE);
  let z = 0;
  for (let i = 0; i < buf.length; i++) { z = (1 - a) * buf[i] + a * z; buf[i] = z; }
}

/** One bed: `len` seconds that loop. */
function bed(name, { len, cycle, melody, seed }) {
  const TAIL = 8, N = Math.floor((len + TAIL) * RATE);
  const dry = new Float32Array(N), mel = new Float32Array(N);
  const rnd = rng(seed);
  // The tanpura: Pa (low), Sa', Sa', Sa (low), round and round.
  const strings = [SA * 3 / 4, SA * 2, SA * 2, SA];
  const gains = [0.9, 0.7, 0.7, 1.0];
  const step = cycle / 4;
  for (let t = 0, k = 0; t < len; t += step, k++) pluck(dry, Math.floor((t + (rnd() - 0.5) * 0.04) * RATE), strings[k % 4], step * 3.2, 0.055 * gains[k % 4], rnd);
  lowpass(dry, 2600);
  // The pad: Sa, Pa, Sa' in long, overlapping swells.
  for (let t = 0; t < len; t += 8) [SA, SA * 1.5, SA * 2].forEach((f, j) => pad(dry, Math.floor((t + j * 2.6) * RATE), f, 12, 0.012));
  if (melody) {
    // Raga Bhupali, a sparse line high above the drone: a note, a rest, a phrase.
    const scale = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2];
    let t = 6, deg = 2;
    while (t < len - 6) {
      const notes = 2 + Math.floor(rnd() * 3);
      for (let i = 0; i < notes && t < len - 6; i++) {
        deg = Math.max(0, Math.min(scale.length - 1, deg + Math.round((rnd() - 0.5) * 3)));
        const d = 1.6 + rnd() * 2.4;
        flute(mel, Math.floor(t * RATE), SA * 2 * scale[deg], d + 0.4, 0.05, rnd);
        t += d;
      }
      t += 4 + rnd() * 7;
    }
  }
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < N; i++) { L[i] = dry[i] + mel[i] * 0.9; R[i] = dry[i] * 0.95 + mel[i]; }
  const wl = freeverb(L, { spread: 0 }), wr = freeverb(R, { spread: 23 });
  const n = Math.floor(len * RATE), out = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < N; i++) {
    const j = i % n;
    out[0][j] += L[i] * 0.55 + wl[i] * 0.6;
    out[1][j] += R[i] * 0.55 + wr[i] * 0.6;
  }
  // Even level: the loudest moment at about -10 dBFS (the page plays it softly).
  let peak = 0;
  for (const ch of out) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  const g = 0.32 / (peak || 1);
  const pcm = out.map((ch) => Int16Array.from(ch, (v) => Math.max(-32767, Math.min(32767, Math.round(v * g * 32767)))));
  const enc = new lamejs.Mp3Encoder(2, RATE, 96), parts = [];
  for (let i = 0; i < n; i += 1152) {
    const b = enc.encodeBuffer(pcm[0].subarray(i, i + 1152), pcm[1].subarray(i, i + 1152));
    if (b.length) parts.push(Buffer.from(b));
  }
  parts.push(Buffer.from(enc.flush()));
  const file = name + '.mp3';
  fs.writeFileSync(path.join(OUT, file), Buffer.concat(parts));
  return { file, duration: len, mood: melody ? 'tanpura and bansuri' : 'tanpura and pad' };
}

fs.mkdirSync(OUT, { recursive: true });
const index = {
  dawn: bed('dawn', { len: 144, cycle: 4.8, melody: true, seed: 7 }),
  stillness: bed('stillness', { len: 144, cycle: 5.2, melody: false, seed: 11 }),
};
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1) + '\n');
console.log(JSON.stringify(index));
