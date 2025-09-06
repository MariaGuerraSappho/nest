/* ...existing code... */
import { RingBLE } from './ringBle.js';
import { AudioEngine } from './audioEngine.js';
import { drawECG, resizeCanvas } from './hrVis.js';

const connectBtn = document.getElementById('connect-btn');
const playBtn = document.getElementById('play-btn');
const stopBtn = document.getElementById('stop-btn');
const fileInput = document.getElementById('file-input');
const library = document.getElementById('library');
const logEl = document.getElementById('log');
const nowDoing = document.getElementById('now-doing');
const hrEl = document.getElementById('hr');
const motionEl = document.getElementById('motion');
const silence = document.getElementById('silence');
const silenceVal = document.getElementById('silence-val');
const minSeg = document.getElementById('minseg');
const minSegVal = document.getElementById('minseg-val');
const explore = document.getElementById('explore');
/* add volume elements */
const volume = document.getElementById('volume');
const volumeVal = document.getElementById('volume-val');
const wornBadge = document.getElementById('worn-badge');
const batteryBadge = document.getElementById('battery-badge');
const hrCanvas = document.getElementById('hr-canvas');
let hrCtx = hrCanvas.getContext('2d'), hrHistory = [];
let hrBuf = []; let lastHrTs = 0; let mEWMA = 0; let lastLogText = ''; let dupCount = 0;

const ring = new RingBLE(msg => addLog(msg));
const audio = new AudioEngine(report => setNowDoing(report));

function addLog(t) {
  const ts = new Date().toLocaleTimeString();
  if (t === lastLogText) { dupCount++; logEl.lastChild && (logEl.lastChild.innerHTML = `[${ts}] ${t} (x${dupCount+1})`); return; }
  lastLogText = t; dupCount = 0;
  logEl.innerHTML += `[${ts}] ${t}<br>`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setNowDoing(t) {
  nowDoing.textContent = t;
  addLog(t);
}

fileInput.addEventListener('change', async e => {
  if (!e.target.files?.length) return;
  playBtn.disabled = true;
  stopBtn.disabled = true;
  library.classList.remove('empty');
  library.textContent = 'Loading...';
  try {
    const tracks = await audio.loadFiles([...e.target.files]);
    renderLibrary(tracks);
    playBtn.disabled = false;
    stopBtn.disabled = false;
    setNowDoing('Loaded ' + tracks.length + ' files.');
  } catch (err) {
    addLog('Error loading files: ' + err.message);
  }
});

function renderLibrary(tracks) {
  library.innerHTML = '';
  tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'track';
    row.innerHTML = `<span>${i + 1}. ${t.name}</span><span>${formatDuration(t.duration)}</span>`;
    library.appendChild(row);
  });
}

function formatDuration(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

connectBtn.addEventListener('click', async () => {
  try {
    await ring.connect();
    connectBtn.textContent = 'Connected';
    connectBtn.disabled = true;
    setNowDoing('Ring connected. Enabling sensors...');
    await ring.enableRaw(); ring.startHeartRate();
    addLog('Waiting for HR and motion… move the ring or start HR to see updates.');
  } catch (e) {
    addLog('BLE error: ' + e.message);
  }
});

playBtn.addEventListener('click', async () => {
  await audio.start();
  setNowDoing('Playing. Silence at ' + silence.value + '%.');
});

stopBtn.addEventListener('click', () => {
  audio.stop();
  setNowDoing('Stopped.');
});

silence.addEventListener('input', () => {
  silenceVal.textContent = silence.value + '%';
  audio.setSilence(parseInt(silence.value, 10) / 100);
});

minSeg.addEventListener('input', () => {
  minSegVal.textContent = Number(minSeg.value).toFixed(1) + 's';
  audio.setMinSegment(parseFloat(minSeg.value));
});

minSegVal.textContent = Number(minSeg.value).toFixed(1) + 's';
audio.setMinSegment(parseFloat(minSeg.value));
explore.addEventListener('change', () => {
  audio.setExploreMode(explore.checked);
});
/* volume wiring */
volume.addEventListener('input', () => {
  volumeVal.textContent = volume.value + '%';
  audio.setVolume(parseInt(volume.value, 10) / 100);
});
volumeVal.textContent = volume.value + '%';
audio.setVolume(parseInt(volume.value, 10) / 100);

/* Sensor wiring */
let lastWorn = null, lastMotion = 0;
/* add cached valid values */
let lastGoodHR = null, lastGoodMotion = null;

ring.onHeartRate = (bpm, derived=false) => {
  if (Number.isFinite(bpm) && bpm >= 25 && bpm <= 220) {
    const now = Date.now(); lastHrTs = now;
    hrBuf.push({t: now, v: bpm}); const cutoff = now - 5000;
    while (hrBuf.length && hrBuf[0].t < cutoff) hrBuf.shift();
    const vals = hrBuf.map(p=>p.v).sort((a,b)=>a-b); const mid = Math.floor(vals.length/2);
    const med = vals.length? (vals.length%2? vals[mid] : (vals[mid-1]+vals[mid])/2) : bpm;
    lastGoodHR = Math.round(med);
    hrEl.textContent = `${lastGoodHR}${derived ? ' (PPG)' : ''}`;
    audio.updateHeartRate(lastGoodHR);
    hrHistory.push({ t: now, v: lastGoodHR });
    const cutoffH = now - 60000; while (hrHistory.length && hrHistory[0].t < cutoffH) hrHistory.shift();
    drawHR();
  }
  addLog(`HR: ${lastGoodHR ?? '--'} bpm${(derived&&lastGoodHR)?' (PPG)':''} | Worn: ${lastWorn===null?'--':(lastWorn?'Yes':'No')} | Motion: ${(lastGoodMotion ?? 0).toFixed(2)} g`);
};

ring.onMotion = g => {
  let m = (!Number.isFinite(g) || g < 0.05) ? 0 : Math.min(3, g);
  mEWMA = mEWMA ? (mEWMA*0.8 + m*0.2) : m;
  const filtered = Math.min(3, mEWMA);
  lastMotion = filtered; lastGoodMotion = filtered;
  motionEl.textContent = filtered.toFixed(2);
  audio.updateMotion(filtered);
};

ring.onWorn = worn => {
  lastWorn = worn; wornBadge.textContent = `Worn: ${worn ? 'Yes' : 'No'}`;
};

ring.onBattery = pct => {
  batteryBadge.textContent = `Battery: ${pct}%`;
};

function resizeHR() {
  const ctx = resizeCanvas(hrCanvas);
  hrCtx = ctx || hrCtx;
  drawECG(hrCanvas, hrHistory);
}

function drawHR() {
  drawECG(hrCanvas, hrHistory);
}

window.addEventListener('resize', resizeHR);
requestAnimationFrame(() => resizeHR());

setInterval(() => {
  if (!lastGoodHR) return;
  if (Date.now() - lastHrTs > 3000) { hrEl.textContent = `${lastGoodHR} (searching)`; }
}, 500);