export function resizeCanvas(canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(300, Math.floor(rect.width * dpr));
  canvas.height = Math.max(100, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function drawECG(canvas, history) {
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#0a0d0a';
  ctx.fillRect(0, 0, w, h);

  // Grid (medical green on dark)
  const minor = 8, major = 5 * minor;
  ctx.lineWidth = 1;

  ctx.strokeStyle = '#0f2d0f';
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  for (let x = 0; x <= w; x += minor) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = 0; y <= h; y += minor) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();

  ctx.strokeStyle = '#1f5f1f';
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  for (let x = 0; x <= w; x += major) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = 0; y <= h; y += major) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (!history.length) return;

  // Time window: 30s for more visible change
  const now = Date.now();
  const spanMs = 30000;
  const windowPoints = history.filter(p => now - p.t <= spanMs);
  if (!windowPoints.length) return;

  // Dynamic vertical scale with padding
  let minBpm = Math.min(...windowPoints.map(p => p.v));
  let maxBpm = Math.max(...windowPoints.map(p => p.v));
  if (!isFinite(minBpm) || !isFinite(maxBpm) || minBpm === maxBpm) { minBpm = 50; maxBpm = 110; }
  const pad = Math.max(5, (maxBpm - minBpm) * 0.25);
  minBpm = Math.max(30, Math.floor(minBpm - pad));
  maxBpm = Math.min(200, Math.ceil(maxBpm + pad));

  const yFor = v => {
    const vv = Math.max(minBpm, Math.min(maxBpm, v));
    return h - ((vv - minBpm) / (maxBpm - minBpm)) * h;
  };
  const xFor = t => w * (1 - (now - t) / spanMs);

  // Sweep line
  const sweepX = xFor(now);
  ctx.strokeStyle = '#2a8f2a';
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(sweepX + 0.5, 0); ctx.lineTo(sweepX + 0.5, h);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Trace
  ctx.strokeStyle = '#34e06f';
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  windowPoints.forEach((p, i) => {
    const x = xFor(p.t);
    const y = yFor(p.v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Latest point
  const last = windowPoints[windowPoints.length - 1];
  const lx = xFor(last.t), ly = yFor(last.v);
  ctx.fillStyle = '#34e06f';
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
}