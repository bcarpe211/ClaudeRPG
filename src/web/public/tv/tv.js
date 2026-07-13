'use strict';
// ClaudeRPG TV renderer: Canvas 2D, SSE-driven. The dungeon is a floating panel
// pre-rendered to an offscreen canvas, sitting on a tiled texture backdrop with a
// drop shadow; dynamic actors draw on top. The dungeon name sits in the strip
// below the panel; the monster HP bar sits in the strip above it.

const TILE = 24;            // source tile size
const SIDEBAR_FRAC = 0.30;  // leaderboard width fraction
const SHADOW = { col: 30, row: 37 }; // wall-shadow tile (mirrors WALL_SHADOW in tilesheet.ts)
const MSHADOW = { S: { col: 37, row: 37 }, M: { col: 38, row: 37 }, L: { col: 39, row: 37 } }; // mirrors MONSTER_SHADOWS in tilesheet.ts
const TEX = { col: 6, row: 12 };     // dark backdrop texture tile
const ANIM_MS = 600;  // creature/hero A/B flip period (~0.6s)
const ANIM_ROW = 18;  // creatures_24x24 A/B partner offset (mirrors anim.js ROW)

// Compact number: 999, 1.2K, 12.4K, 124K, 3.2M, 1.1B, 4.5T. Sign-preserving.
// (mirrors formatCompact in src/domain/format.ts; tv.js has no imports)
function fmt(n) {
  const s = n < 0 ? '-' : ''; let x = Math.abs(n);
  if (x < 1000) return s + String(Math.round(x));
  const u = ['K', 'M', 'B', 'T']; let i = -1;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return s + x.toFixed(x < 100 ? 1 : 0) + u[i];
}

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const imgCache = new Map();
function img(url) {
  let im = imgCache.get(url);
  if (!im) { im = new Image(); im.src = url; imgCache.set(url, im); }
  return im;
}

// The +18 animation-partner URL for a frame-A creature sprite URL.
function partnerUrl(url) {
  return url.replace(/_(\d+)\.png$/, (_m, n) =>
    '_' + String(Number(n) + ANIM_ROW).padStart(2, '0') + '.png');
}

// Animated sprite image for `url`, keyed so sprites don't all flip in unison.
// Shows frame A, or its +18 partner on alternate ticks; if the partner image
// hasn't loaded yet, stays on frame A (no blank/flicker).
function animImg(url, key, t) {
  const phase = (key * 137 + 53) % ANIM_MS;      // spreads flips across the period
  const showB = Math.floor((t + phase) / ANIM_MS) % 2 === 1;
  if (!showB) return img(url);
  const b = img(partnerUrl(url));
  return (b.complete && b.naturalWidth) ? b : img(url);
}

let layout = null;       // last 'layout' payload
let bg = null;           // offscreen canvas of the dungeon panel
let texbg = null;        // offscreen canvas of the tiled backdrop
let state = null;        // last 'state' payload
let scale = 3, tilePx = TILE * 3;
let sidebarW = 0, fieldX = 0;
let panelX = 0, panelY = 0, panelW = 0, panelH = 0; // dungeon panel rect
const anim = new Map();  // playerId -> {until} for swing flashes
const floaters = [];     // {x,y,text,born}

function computeScale() {
  const vw = canvas.width, vh = canvas.height;
  sidebarW = Math.round(vw * SIDEBAR_FRAC);
  fieldX = sidebarW;
  const fieldW = vw - sidebarW;
  // reserve a top strip (monster name + HP bar) + thin framing margins, so the
  // dungeon floats on the backdrop while taking the largest clean integer scale.
  const hpZone = vh * 0.09, bottomMargin = vh * 0.02, sideMargin = fieldW * 0.03;
  const availW = fieldW - 2 * sideMargin;
  const availH = vh - hpZone - bottomMargin;
  // largest INTEGER scale that fits -> crisp pixels at any resolution
  scale = Math.max(1, Math.floor(Math.min(availW / (20 * TILE), availH / (15 * TILE))));
  tilePx = TILE * scale;
  panelW = 20 * tilePx; panelH = 15 * tilePx;
  panelX = fieldX + Math.round((fieldW - panelW) / 2);
  panelY = Math.round(hpZone + (availH - panelH) / 2);
}

function resize() {
  canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1);
  ctx.imageSmoothingEnabled = false; // reapply: setting canvas.width resets context state
  computeScale();
  buildBackground(); // rebuild backdrop + panel at the new scale
}
window.addEventListener('resize', resize);

function buildBackground() {
  const sheet = img('/sheet/world.png');
  // backdrop texture (full canvas, tiled at the dungeon tile scale)
  texbg = document.createElement('canvas');
  texbg.width = canvas.width; texbg.height = canvas.height;
  const tb = texbg.getContext('2d'); tb.imageSmoothingEnabled = false;
  // dungeon panel (only if a layout has arrived)
  bg = layout ? document.createElement('canvas') : null;
  if (bg) { bg.width = panelW; bg.height = panelH; }
  const draw = () => {
    for (let y = 0; y < texbg.height; y += tilePx)
      for (let x = 0; x < texbg.width; x += tilePx)
        tb.drawImage(sheet, TEX.col * TILE, TEX.row * TILE, TILE, TILE, x, y, tilePx, tilePx);
    if (!bg) return;
    const b = bg.getContext('2d'); b.imageSmoothingEnabled = false;
    b.clearRect(0, 0, bg.width, bg.height);
    const put = (col, row, x, y) =>
      b.drawImage(sheet, col * TILE, row * TILE, TILE, TILE, x * tilePx, y * tilePx, tilePx, tilePx);
    for (let y = 0; y < layout.height; y++)
      for (let x = 0; x < layout.width; x++) {
        const c = layout.cells[y][x];
        if (c.under) put(c.under.col, c.under.row, x, y); // floor behind a transparent door
        put(c.col, c.row, x, y);
      }
    // wall-shadow layer (above floor, below decor): a wall/door casts it downward
    for (let y = 0; y < layout.height; y++)
      for (let x = 0; x < layout.width; x++)
        if (layout.cells[y][x].shadow) put(SHADOW.col, SHADOW.row, x, y);
    // static decor; cobwebs carry flipX/flipY so each corner web fans into the room
    for (const d of layout.decor) {
      if (d.animB) continue;
      if (!d.flipX && !d.flipY) { put(d.col, d.row, d.x, d.y); continue; }
      b.save();
      b.translate((d.x + (d.flipX ? 1 : 0)) * tilePx, (d.y + (d.flipY ? 1 : 0)) * tilePx);
      b.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
      b.drawImage(sheet, d.col * TILE, d.row * TILE, TILE, TILE, 0, 0, tilePx, tilePx);
      b.restore();
    }
  };
  // draw now, and again once the sheet finishes loading (one shared image)
  draw();
  if (!sheet.complete) sheet.onload = draw;
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
        floaters.push({ x: p.x, y: p.y, text: '-' + fmt(p.damage - before), born: performance.now() });
      }
    }
  }
  state = next;
});

function drawSprite(im, cx, cy, w, h) {
  ctx.drawImage(im, Math.round(cx - w / 2), Math.round(cy - h), w, h);
}

// Ground-shadow ellipse under an actor. Crop just the flat ellipse band from the shadow tile
// and CENTRE it on the actor's foot line `feetY` (width `w`): its lower half peeks out below
// the feet, its upper half tucks behind the sprite. `feetY` sits a little above the tile
// bottom so the ellipse stays on the actor's own tile.
function groundShadow(sizeKey, cx, feetY, w) {
  const sheet = img('/sheet/world.png');
  const sh = MSHADOW[sizeKey] || MSHADOW.M;
  const shH = Math.max(4, Math.round(w * 0.32));
  ctx.drawImage(sheet, sh.col * TILE, sh.row * TILE + 16, TILE, 8,
    Math.round(cx - w / 2), Math.round(feetY - shH / 2), w, shH);
}
// Sprite feet sit at the very bottom of the 24px source (row ~23), so the foot line is a bit
// above the tile bottom — leaving room for the shadow's lower half to show on-tile.
function footLine(py) { return py - Math.round(TILE * scale * 0.1); }

// text with a manual drop shadow, offset proportional to the font size so bigger
// text gets a bigger shadow (keeps default alphabetic baseline)
function shadowText(txt, x, y, font, fill, align) {
  ctx.font = font; ctx.textAlign = align || 'left';
  const m = font.match(/(\d+)px/);
  const o = Math.max(2, Math.round((m ? +m[1] : 16) * 0.1));
  ctx.fillStyle = 'rgba(0,0,0,0.9)'; ctx.fillText(txt, x + o, y + o);
  ctx.fillStyle = fill; ctx.fillText(txt, x, y);
}

function render(t) {
  requestAnimationFrame(render);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (texbg) ctx.drawImage(texbg, 0, 0);
  else { ctx.fillStyle = '#14121a'; ctx.fillRect(0, 0, canvas.width, canvas.height); }

  // dungeon panel with a soft drop shadow onto the backdrop
  if (bg) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = Math.round(tilePx * 0.45);
    ctx.shadowOffsetX = Math.round(tilePx * 0.10);
    ctx.shadowOffsetY = Math.round(tilePx * 0.20);
    ctx.drawImage(bg, panelX, panelY);
    ctx.restore();
  }

  drawAnimDecor(t);

  if (state) {
    drawMonster(t);
    drawHeroes(t);
    drawHpBar();
    drawFloaters(t);
    drawLeaderboard();
    if (state.paused) drawOverlay('The dungeon rests… awaiting adventurers');
    if (state.defeat) drawDefeat();
  }
}

function drawAnimDecor(t) {
  if (!layout) return;
  const sheet = img('/sheet/world.png');
  for (let i = 0; i < layout.decor.length; i++) {
    const d = layout.decor[i];
    if (!d.animB) continue;
    const phase = (i * 137 + 53) % ANIM_MS;         // stagger so torches flicker independently
    const showB = Math.floor((t + phase) / ANIM_MS) % 2 === 1;
    const col = showB ? d.animB.col : d.col;
    const row = showB ? d.animB.row : d.row;
    ctx.drawImage(sheet, col * TILE, row * TILE, TILE, TILE,
      panelX + d.x * tilePx, panelY + d.y * tilePx, tilePx, tilePx);
  }
}

function tileToField(x, y) { return { px: panelX + x * tilePx, py: panelY + y * tilePx }; }

function drawMonster(t) {
  const e = state.encounter; if (!e || !layout) return;
  const m = layout.monster;
  const fp = e.footprint;                       // 1 or 2
  const visScale = fp === 2 ? 2.2 : 1.4;        // bosses loom larger
  const size = tilePx * visScale;
  const { px, py } = tileToField(m.x + fp / 2, m.y + fp); // py = bottom edge of the footprint
  const groundY = footLine(py);                 // foot line, a bit above the footprint's bottom
  const shadowW = fp * tilePx * 0.85;           // ~footprint-wide, not sprite-wide
  // grounded: feet on the shadow; flying: shadow stays on the ground, sprite lifts high above
  const cy = e.flying ? groundY - Math.round(tilePx * 0.5) : groundY;
  groundShadow(e.size, px, groundY, shadowW);
  drawSprite(animImg(e.creatureUrl, 100, t), px, cy, size, size);
  // pack: a couple of small duplicates beside it, each with its own small shadow
  if (e.kind === 'pack') {
    for (let i = 1; i <= Math.min(3, e.packCount - 1); i++) {
      const dx = px + i * tilePx * 0.6, dw = size * 0.7;
      groundShadow(e.size, dx, groundY, tilePx * 0.7);
      drawSprite(animImg(e.creatureUrl, 100 + i, t), dx, cy, dw, dw);
    }
  }
}

function drawHeroes(t) {
  for (const p of state.players) {
    if (p.x === null) continue;
    const a = anim.get(p.id);
    const lunge = a && a.until > performance.now() ? 0.25 : 0;
    const { px, py } = tileToField(p.x + 0.5, p.y + 1); // py = bottom edge of the hero's tile
    const w = 26 * scale, h = 28 * scale;
    const groundY = footLine(py);                        // foot line, a bit above the tile bottom
    groundShadow('M', px, groundY, Math.round(tilePx * 0.66)); // medium shadow centred on the feet
    if (a && a.until > performance.now()) ctx.globalAlpha = 0.85;
    drawSprite(animImg(p.avatarUrl, p.id, t), px, groundY + lunge * tilePx, w, h);
    ctx.globalAlpha = 1;
  }
}

function drawHpBar() {
  const e = state.encounter; if (!e) return;
  const w = panelW * 0.6, h = Math.max(16, Math.round(tilePx * 0.34));
  const x = panelX + (panelW - w) / 2;
  // sit above the panel with a clear gap; the monster name is drawn in the strip
  // above the bar (bigger than the bar), below.
  const y = panelY - h - Math.round(tilePx * 0.5);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = Math.round(h * 0.6); ctx.shadowOffsetY = Math.round(h * 0.3);
  ctx.fillStyle = '#180a0a'; ctx.fillRect(x - 4, y - 3, w + 8, h + 6);
  ctx.restore();
  ctx.fillStyle = '#3a0d0d'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#d23b3b'; ctx.fillRect(x, y, w * Math.max(0, e.hp / e.maxHp), h);
  // monster name in the reserved strip above the bar, a step larger than the HP text
  const nameSize = Math.max(14, Math.round(h * 1.15));
  shadowText(e.name, panelX + panelW / 2, y - Math.round(h * 0.55),
    `bold ${nameSize}px system-ui`, '#f2e4e4', 'center');
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
  const pad = Math.round(sidebarW * 0.05);
  let y = pad;
  shadowText('LEADERBOARD', pad, y + sidebarW * 0.065, `bold ${Math.round(sidebarW * 0.075)}px system-ui`, '#e8c96a', 'left');
  y += sidebarW * 0.13;
  // fill the sidebar: taller rows (bigger avatars + text), capped so a short roster
  // still reads large. Rotation for big rosters is backlog #8.
  const rowH = Math.min((canvas.height - y - pad) / Math.max(1, state.players.length), sidebarW * 0.17);
  const avW = Math.round(rowH * 0.8);
  const textX = pad + avW + Math.round(rowH * 0.14); // name/stats hug the avatar (justified left)
  for (const p of state.players) {
    ctx.globalAlpha = p.disabled ? 0.4 : 1;
    ctx.drawImage(img(p.avatarUrl), pad, y, avW, avW);
    shadowText(p.name, textX, y + rowH * 0.36, `${Math.round(rowH * 0.34)}px system-ui`, '#cdb9e0', 'left');
    shadowText(`L${p.level}  ${fmt(p.effectiveTokens)} tok  ${fmt(p.gold)}g  x${p.modifier.toFixed(2)}`,
      textX, y + rowH * 0.72, `${Math.round(rowH * 0.28)}px system-ui`, '#9a86b0', 'left');
    ctx.globalAlpha = 1;
    y += rowH;
  }
}

function drawOverlay(text) {
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000b'; // dim the WHOLE screen (sidebar + field) while resting
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#e8c96a'; ctx.textAlign = 'center';
  ctx.font = `${Math.round(20 * scale)}px system-ui`;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function drawDefeat() {
  ctx.textBaseline = 'alphabetic';
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
  ctx.fillText(`Total damage ${fmt(d.totalDamage)}`, x + w / 2, y + h * 0.4);
  ctx.textAlign = 'left';
  let ry = y + h * 0.48;
  const ranked = [...d.participants].sort((a, b) => b.damage - a.damage).slice(0, 10);
  for (const p of ranked) {
    const mvp = p.playerId === d.mvpPlayerId ? '★ ' : '   ';
    ctx.fillStyle = p.playerId === d.mvpPlayerId ? '#ffd36a' : '#cdb9e0';
    ctx.font = `${Math.round(h * 0.04)}px system-ui`;
    const pct = d.totalDamage ? Math.round((p.damage / d.totalDamage) * 100) : 0;
    ctx.fillText(`${mvp}${p.name}  ${fmt(p.damage)} (${pct}%)  ${fmt(p.tokensDuringFight)}tok  +${fmt(p.gold)}g` +
      (p.leveledTo ? `  ⬆L${p.leveledTo}` : ''), x + w * 0.1, ry);
    ry += h * 0.055;
  }
}

resize();
requestAnimationFrame(render);
