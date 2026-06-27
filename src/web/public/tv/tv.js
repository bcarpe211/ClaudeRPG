'use strict';
// ClaudeRPG TV renderer: Canvas 2D, SSE-driven. Background (dungeon) is
// pre-rendered once per layout to an offscreen canvas; dynamic actors draw on top.

const TILE = 24;            // source tile size
const SIDEBAR_FRAC = 0.25;  // leaderboard width fraction

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const imgCache = new Map();
function img(url) {
  let im = imgCache.get(url);
  if (!im) { im = new Image(); im.src = url; imgCache.set(url, im); }
  return im;
}

let layout = null;       // last 'layout' payload
let bg = null;           // offscreen canvas of the dungeon
let state = null;        // last 'state' payload
let scale = 6, tilePx = TILE * 6, sidebarW = 0, fieldX = 0;
const anim = new Map();  // playerId -> {until, lastDamage} for swing flashes
const floaters = [];     // {x,y,text,born}

function computeScale() {
  const vw = canvas.width, vh = canvas.height;
  const fieldW = vw * (1 - SIDEBAR_FRAC);
  scale = Math.max(1, Math.floor(Math.min(fieldW / (20 * TILE), vh / (15 * TILE))));
  tilePx = TILE * scale;
  sidebarW = vw - 20 * tilePx;
  fieldX = sidebarW;
}

function resize() {
  canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1);
  ctx.imageSmoothingEnabled = false; // reapply: setting canvas.width resets context state
  computeScale();
  bg = null;
  buildBackground(); // rebuild at new scale; no-ops if layout not yet received
}
window.addEventListener('resize', resize);

function buildBackground() {
  if (!layout) return;
  bg = document.createElement('canvas');
  bg.width = 20 * tilePx; bg.height = 15 * tilePx;
  const b = bg.getContext('2d');
  b.imageSmoothingEnabled = false;
  let pending = 0;
  const draw = () => {
    b.clearRect(0, 0, bg.width, bg.height);
    for (let y = 0; y < layout.height; y++)
      for (let x = 0; x < layout.width; x++)
        b.drawImage(img(layout.cells[y][x].url), x * tilePx, y * tilePx, tilePx, tilePx);
    for (const d of layout.decor)
      b.drawImage(img(d.url), d.x * tilePx, d.y * tilePx, tilePx, tilePx);
  };
  // draw once now and again as images finish loading
  draw();
  for (const row of layout.cells) for (const c of row) {
    const im = img(c.url);
    if (!im.complete) { pending++; im.onload = () => { draw(); }; }
  }
}

const evt = new EventSource('/tv/stream');
evt.addEventListener('layout', (e) => { layout = JSON.parse(e.data); buildBackground(); });
evt.addEventListener('state', (e) => {
  const next = JSON.parse(e.data);
  // detect swings: a player's per-fight damage increased -> flash + floater
  if (state && next.encounter && state.encounter && next.encounter.id === state.encounter.id) {
    const prev = new Map(state.players.map((p) => [p.id, p.damage]));
    for (const p of next.players) {
      const before = prev.get(p.id) ?? 0;
      if (p.x !== null && p.damage > before) {
        anim.set(p.id, { until: performance.now() + 350 });
        floaters.push({ x: p.x, y: p.y, text: '-' + (p.damage - before), born: performance.now() });
      }
    }
  }
  state = next;
});

function drawSprite(im, cx, cy, w, h) {
  ctx.drawImage(im, Math.round(cx - w / 2), Math.round(cy - h), w, h);
}

function render(t) {
  requestAnimationFrame(render);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // sidebar background + wall-tile border feel
  ctx.fillStyle = '#171019';
  ctx.fillRect(0, 0, sidebarW, canvas.height);
  ctx.fillStyle = '#0e0b14';
  ctx.fillRect(fieldX, 0, canvas.width - fieldX, canvas.height);

  if (bg) ctx.drawImage(bg, fieldX, 0);

  if (state) {
    drawMonster();
    drawHeroes(t);
    drawHpBar();
    drawFloaters(t);
    drawLeaderboard();
    if (state.paused) drawOverlay('The dungeon rests… awaiting adventurers');
    if (state.defeat) drawDefeat();
  }
}

function tileToField(x, y) { return { px: fieldX + x * tilePx, py: y * tilePx }; }

function drawMonster() {
  const e = state.encounter; if (!e || !layout) return;
  const m = layout.monster;
  const fp = e.footprint;                       // 1 or 2
  const visScale = fp === 2 ? 2.2 : 1.4;        // bosses loom larger
  const size = TILE * scale * visScale;
  const { px, py } = tileToField(m.x + fp / 2, m.y + fp);
  drawSprite(img(e.creatureUrl), px, py, size, size);
  // pack: a couple of small duplicates beside it
  if (e.kind === 'pack') {
    for (let i = 1; i <= Math.min(3, e.packCount - 1); i++)
      drawSprite(img(e.creatureUrl), px + i * tilePx * 0.6, py, size * 0.7, size * 0.7);
  }
}

function drawHeroes(t) {
  for (const p of state.players) {
    if (p.x === null) continue;
    const a = anim.get(p.id);
    const lunge = a && a.until > performance.now() ? 0.25 : 0;
    const { px, py } = tileToField(p.x + 0.5, p.y + 1 + lunge);
    const w = 26 * scale, h = 28 * scale;
    if (a && a.until > performance.now()) ctx.globalAlpha = 0.85;
    drawSprite(img(p.avatarUrl), px, py, w, h);
    ctx.globalAlpha = 1;
  }
}

function drawHpBar() {
  const e = state.encounter; if (!e) return;
  const w = (canvas.width - fieldX) * 0.6, h = 22 * (scale / 3), x = fieldX + ((canvas.width - fieldX) - w) / 2, y = 10;
  ctx.fillStyle = '#000a'; ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.fillStyle = '#3a0d0d'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#d23b3b'; ctx.fillRect(x, y, w * Math.max(0, e.hp / e.maxHp), h);
  ctx.fillStyle = '#fff'; ctx.font = `${Math.round(h * 0.7)}px system-ui`; ctx.textAlign = 'center';
  ctx.fillText(`${e.hp.toLocaleString()} / ${e.maxHp.toLocaleString()}`, x + w / 2, y + h * 0.75);
}

function drawFloaters(t) {
  ctx.textAlign = 'center';
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; const age = performance.now() - f.born;
    if (age > 900) { floaters.splice(i, 1); continue; }
    const { px, py } = tileToField(f.x + 0.5, f.y);
    ctx.globalAlpha = 1 - age / 900;
    ctx.fillStyle = '#ffd36a'; ctx.font = `${Math.round(10 * scale)}px system-ui`;
    ctx.fillText(f.text, px, py - age * 0.05);
    ctx.globalAlpha = 1;
  }
}

function drawLeaderboard() {
  const pad = Math.round(sidebarW * 0.04);
  let y = pad;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e8c96a'; ctx.font = `bold ${Math.round(sidebarW * 0.07)}px system-ui`;
  ctx.fillText('LEADERBOARD', pad, y + sidebarW * 0.06); y += sidebarW * 0.11;
  const rowH = Math.min((canvas.height - y - pad) / Math.max(1, state.players.length), sidebarW * 0.12);
  for (const p of state.players) {
    ctx.globalAlpha = p.disabled ? 0.4 : 1;
    ctx.drawImage(img(p.avatarUrl), pad, y, rowH * 0.8, rowH * 0.85);
    ctx.fillStyle = '#cdb9e0'; ctx.font = `${Math.round(rowH * 0.34)}px system-ui`;
    ctx.fillText(p.name, pad + rowH, y + rowH * 0.36);
    ctx.fillStyle = '#9a86b0'; ctx.font = `${Math.round(rowH * 0.28)}px system-ui`;
    ctx.fillText(`L${p.level}  ${p.effectiveTokens.toLocaleString()} tok  ${p.gold}g  x${p.modifier.toFixed(2)}`,
      pad + rowH, y + rowH * 0.72);
    ctx.globalAlpha = 1;
    y += rowH;
  }
}

function drawOverlay(text) {
  ctx.fillStyle = '#000a';
  ctx.fillRect(fieldX, 0, canvas.width - fieldX, canvas.height);
  ctx.fillStyle = '#e8c96a'; ctx.textAlign = 'center';
  ctx.font = `${Math.round(20 * scale)}px system-ui`;
  ctx.fillText(text, fieldX + (canvas.width - fieldX) / 2, canvas.height / 2);
}

function drawDefeat() {
  const d = state.defeat;
  const w = (canvas.width - fieldX) * 0.7, h = canvas.height * 0.7;
  const x = fieldX + ((canvas.width - fieldX) - w) / 2, y = (canvas.height - h) / 2;
  ctx.fillStyle = '#1a1022ee'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#6b5436'; ctx.lineWidth = 4; ctx.strokeRect(x, y, w, h);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8c96a'; ctx.font = `bold ${Math.round(h * 0.07)}px system-ui`;
  ctx.fillText('MONSTER DEFEATED!', x + w / 2, y + h * 0.12);
  ctx.drawImage(img(d.creatureUrl), x + w / 2 - h * 0.08, y + h * 0.14, h * 0.16, h * 0.16);
  ctx.font = `${Math.round(h * 0.045)}px system-ui`; ctx.fillStyle = '#cdb9e0';
  ctx.fillText(`Total damage ${d.totalDamage.toLocaleString()}`, x + w / 2, y + h * 0.4);
  ctx.textAlign = 'left';
  let ry = y + h * 0.48;
  const ranked = [...d.participants].sort((a, b) => b.damage - a.damage).slice(0, 10);
  for (const p of ranked) {
    const mvp = p.playerId === d.mvpPlayerId ? '★ ' : '   ';
    ctx.fillStyle = p.playerId === d.mvpPlayerId ? '#ffd36a' : '#cdb9e0';
    ctx.font = `${Math.round(h * 0.04)}px system-ui`;
    const pct = d.totalDamage ? Math.round((p.damage / d.totalDamage) * 100) : 0;
    ctx.fillText(`${mvp}${p.name}  ${p.damage.toLocaleString()} (${pct}%)  +${p.gold}g` +
      (p.leveledTo ? `  ⬆L${p.leveledTo}` : ''), x + w * 0.1, ry);
    ry += h * 0.055;
  }
}

resize();
requestAnimationFrame(render);
