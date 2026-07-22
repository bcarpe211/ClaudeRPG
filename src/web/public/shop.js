'use strict';
(function () {
  const cfg = window.__SHOP__; if (!cfg) return;
  const wheel = document.getElementById('wheel');
  const preview = document.getElementById('preview');
  const hueInput = document.getElementById('hue');
  const wctx = wheel.getContext('2d'), pctx = preview.getContext('2d');
  pctx.imageSmoothingEnabled = false;
  const R = wheel.width / 2;

  // draw the hue wheel
  for (let a = 0; a < 360; a++) {
    wctx.beginPath(); wctx.moveTo(R, R);
    wctx.arc(R, R, R - 4, (a - 0.5) * Math.PI / 180, (a + 0.5) * Math.PI / 180);
    wctx.closePath(); wctx.fillStyle = `hsl(${a},85%,55%)`; wctx.fill();
  }

  function hueSwap(r, g, b, deg) {
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
    const v = max, s = max === 0 ? 0 : (max - min) / max;
    const h = (((deg % 360) + 360) % 360) / 360;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const m = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i % 6];
    return [Math.round(m[0]*255), Math.round(m[1]*255), Math.round(m[2]*255)];
  }
  const cloth = new Set(cfg.clothing.map((h) => h.replace('#', '').toLowerCase()));

  const base = new Image(); base.crossOrigin = 'anonymous'; base.src = cfg.baseSprite;
  let src = null;
  base.onload = () => {
    const off = document.createElement('canvas'); off.width = 24; off.height = 24;
    const o = off.getContext('2d'); o.imageSmoothingEnabled = false; o.drawImage(base, 0, 0, 24, 24);
    src = o.getImageData(0, 0, 24, 24);
    render(cfg.hue);
  };
  function render(deg) {
    if (!src) return;
    const img = pctx.createImageData(24, 24); const d = img.data, s = src.data;
    for (let i = 0; i < s.length; i += 4) {
      d[i] = s[i]; d[i+1] = s[i+1]; d[i+2] = s[i+2]; d[i+3] = s[i+3];
      if (s[i+3] === 0) continue;
      const hex = ((s[i]<<16)|(s[i+1]<<8)|s[i+2]).toString(16).padStart(6,'0');
      if (cloth.has(hex)) { const c = hueSwap(s[i], s[i+1], s[i+2], deg); d[i]=c[0]; d[i+1]=c[1]; d[i+2]=c[2]; }
    }
    const tmp = document.createElement('canvas'); tmp.width = 24; tmp.height = 24;
    tmp.getContext('2d').putImageData(img, 0, 0);
    pctx.clearRect(0, 0, 120, 120); pctx.drawImage(tmp, 0, 0, 120, 120);
  }
  wheel.addEventListener('click', (e) => {
    const rect = wheel.getBoundingClientRect();
    const dx = e.clientX - rect.left - R, dy = e.clientY - rect.top - R;
    const deg = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360)) % 360;
    hueInput.value = deg; render(deg);
  });
})();
