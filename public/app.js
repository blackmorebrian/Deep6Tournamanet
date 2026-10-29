// Deep 6 Live: TV dashboard for Matchplay tournaments.
// URL: /?t=<tournamentId>  or  /?t=auto (follows tonight's event)  or  / (picker)

const WS_URL = 'wss://ws.app.matchplay.events/app/tnrxzkahdeullnwje83e?protocol=7&client=js&version=8.5.0&flash=false';
const POLL_MS = 15_000;
const PAGE_MS = 9_000;
const OVERLAY_MS = 6_500;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const mode = params.get('t');

let tid = mode && mode !== 'auto' ? mode : null;
let state = null;
let prev = null;
let firstSeen = new Map();   // gameId -> time we first saw it active
let boardPage = 0;
let cardPage = 0;

// ---------- stage scaling ----------
function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  $('stage').style.transform = `translate(-50%, -50%) scale(${s})`;
}
addEventListener('resize', fit);
fit();

// Click or press F for fullscreen; cursor appears only while the mouse moves.
document.addEventListener('keydown', e => { if (e.key === 'f') toggleFullscreen(); });
document.addEventListener('dblclick', toggleFullscreen);
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}
let cursorTimer;
document.addEventListener('mousemove', () => {
  document.body.style.cursor = 'default';
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => (document.body.style.cursor = ''), 2500);
});

// ---------- clock ----------
function tick() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = elapsed(el.dataset.since);
}
setInterval(tick, 1000);
tick();

function elapsed(iso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- data ----------
async function load() {
  if (!tid) return;
  try {
    let data;
    if (tid === 'demo') {
      data = Demo.state();
      if (state && data.version === state.version) return;
    } else {
      const res = await fetch(`/api/state?t=${tid}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      if (String(data.tournament.id) !== String(tid)) return;
    }
    prev = state;
    state = data;
    $('live').classList.remove('off');
    $('live').classList.toggle('hidden', state.tournament.status !== 'started');
    detectMoments(prev, state);
    render();
  } catch (e) {
    console.warn('load failed', e);
    $('live').classList.add('off');
  }
}

let pollTimer;
function startPolling() {
  clearInterval(pollTimer);
  load();
  pollTimer = setInterval(load, POLL_MS);
}

// Matchplay pushes events the moment a score is entered. The API is edge-cached
// for 15s, so refetch shortly after the event and again once the cache rolls over.
let ws;
let burst = [];
function connectSocket() {
  if (!tid) return;
  ws?.close();
  const sock = new WebSocket(WS_URL);
  ws = sock;
  sock.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.event === 'pusher:connection_established') {
      sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `tournaments.${tid}` } }));
    } else if (msg.event === 'pusher:ping') {
      sock.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
    } else if (msg.channel === `tournaments.${tid}`) {
      burst.forEach(clearTimeout);
      burst = [setTimeout(load, 2000), setTimeout(load, 16_500)];
    }
  };
  const keepalive = setInterval(() => {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
  }, 25_000);
  sock.onclose = () => {
    clearInterval(keepalive);
    if (ws === sock) setTimeout(connectSocket, 5000);
  };
}

function switchTo(id) {
  if (String(id) === String(tid)) return;
  tid = String(id);
  state = prev = null;
  firstSeen = new Map();
  connectSocket();
  startPolling();
}

async function followAuto() {
  try {
    const { auto } = await (await fetch('/api/tournaments')).json();
    if (auto) switchTo(auto);
  } catch (e) {
    console.warn('auto lookup failed', e);
  }
}

// ---------- big moments (game results, eliminations) ----------
const overlayQueue = [];
let overlayBusy = false;

function detectMoments(before, after) {
  const now = Date.now();
  for (const g of after.active) if (!firstSeen.has(g.gameId)) firstSeen.set(g.gameId, before ? now : 0);
  if (!before) return;

  const seen = new Set(before.completed.map(g => g.gameId));
  const fresh = after.completed.filter(g => !seen.has(g.gameId)).reverse();
  for (const g of fresh.slice(-3)) overlayQueue.push({ kind: 'result', game: g, at: now });

  const wasOut = new Set(before.standings.filter(s => s.eliminated).map(s => s.playerId));
  for (const s of after.standings) {
    if (s.eliminated && !wasOut.has(s.playerId) && after.tournament.status === 'started') {
      overlayQueue.push({ kind: 'ko', player: s, remaining: after.tournament.aliveCount, at: now });
    }
  }
  if (before.tournament.status !== 'completed' && after.tournament.status === 'completed' && after.standings[0]) {
    overlayQueue.push({ kind: 'champ', player: after.standings[0], at: now });
  }
  // On a busy night results can arrive faster than overlays play. Keep the two
  // newest results; eliminations and the champion always get their moment.
  let results = overlayQueue.filter(i => i.kind === 'result').length;
  for (let i = 0; i < overlayQueue.length && results > 2; ) {
    if (overlayQueue[i].kind === 'result') { overlayQueue.splice(i, 1); results--; } else i++;
  }
  playOverlays();
}

function playOverlays() {
  if (overlayBusy || !overlayQueue.length) return;
  // Skip moments that went stale while others were on screen (the champion always shows).
  while (overlayQueue.length && overlayQueue[0].kind !== 'champ' && Date.now() - overlayQueue[0].at > 30_000) overlayQueue.shift();
  if (!overlayQueue.length) return;
  overlayBusy = true;
  const item = overlayQueue.shift();
  const el = $('overlay');
  el.innerHTML = overlayHtml(item);
  el.classList.remove('hidden');
  setTimeout(() => {
    el.classList.add('hidden');
    overlayBusy = false;
    setTimeout(playOverlays, 400);
  }, item.kind === 'champ' ? OVERLAY_MS * 2 : overlayQueue.length ? OVERLAY_MS * 0.6 : OVERLAY_MS);
}

function overlayHtml(item) {
  if (item.kind === 'result') {
    const g = item.game;
    const order = [...g.players].sort((a, b) => (a.place || 9) - (b.place || 9));
    const winner = order[0];
    const others = order.slice(1);
    const ko = state?.tournament.isKnockout;
    const rest = others.length
      ? (ko ? `<b>STRIKE</b> &rarr; ${others.map(p => esc(p.name)).join(', ')}` : others.map((p, i) => `${i + 2}. ${esc(p.name)}`).join(' &nbsp; '))
      : '';
    return `<div class="burst">
      ${g.machine?.image ? `<div class="art" style="background-image:url('${esc(g.machine.image)}')"></div>` : ''}
      <div class="machine">${esc(g.machine?.name || '')}</div>
      <div class="headline win">WINNER</div>
      <div class="who">${esc(winner?.name)}</div>
      <div class="rest">${rest}</div>
    </div>`;
  }
  if (item.kind === 'ko') {
    return `<div class="burst">
      <div class="headline ko">ELIMINATED</div>
      <div class="who">${esc(item.player.name)}</div>
      <div class="rest">Out in position #${item.player.position} &middot; ${item.remaining} players remain</div>
    </div>`;
  }
  return `<div class="burst">
    <div class="machine">${esc(state.tournament.name)}</div>
    <div class="headline win">CHAMPION</div>
    <div class="who">${esc(item.player.name)}</div>
  </div>`;
}

// ---------- rendering ----------
function render() {
  const t = state.tournament;
  $('tname').textContent = t.name;
  $('round').textContent = t.status === 'started' ? (state.round?.name || '') : t.status === 'completed' ? 'FINAL' : '';
  $('alive').innerHTML = t.isKnockout && t.status === 'started'
    ? `<b>${t.aliveCount}</b> / ${t.playerCount} ALIVE`
    : t.playerCount ? `<b>${t.playerCount}</b> PLAYERS` : '';

  const screen = $('screen');
  if (t.status === 'planned') {
    $('main').classList.add('hidden');
    screen.classList.remove('hidden');
    screen.innerHTML = plannedHtml();
  } else if (t.status === 'completed') {
    $('main').classList.add('hidden');
    screen.classList.remove('hidden');
    screen.innerHTML = podiumHtml();
  } else {
    screen.classList.add('hidden');
    $('main').classList.remove('hidden');
    renderBoard();
    renderCards();
  }
  renderTicker();
}

function plannedHtml() {
  const t = state.tournament;
  const when = t.startLocal ? new Date(t.startLocal.replace(' ', 'T')) : null;
  const sameDay = when && when.toDateString() === new Date().toDateString();
  const whenText = when
    ? `${sameDay ? 'Tonight' : when.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} &middot; ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : '';
  const roster = state.registered.map((n, i) => `<span style="animation-delay:${i * 40}ms">${esc(n)}</span>`).join('');
  return `<div class="hero">
    <div class="kicker">${t.isKnockout ? `${t.maxStrikes}-Strike Knockout` : 'Tournament'}</div>
    <div class="title">${sameDay ? 'Starting Soon' : 'Next Up'}</div>
    <div class="when">${whenText}</div>
    <div class="roster">${roster || '<span>Sign-ups open</span>'}</div>
  </div>`;
}

function podiumHtml() {
  const [a, b, c] = state.standings;
  const step = (p, n) => p ? `<div class="step s${n}"><div class="nm">${esc(p.name)}</div><div class="blk">${n}</div></div>` : '';
  return `<div class="hero">
    <div class="kicker">Champion</div>
    <div class="title">${esc(a?.name || '')}</div>
  </div>
  <div class="podium">${step(b, 2)}${step(a, 1)}${step(c, 3)}</div>`;
}

// Leaderboard: alive players get big rows; knocked-out players drop below.
// If it doesn't fit, it pages automatically.
function renderBoard() {
  const t = state.tournament;
  const rowsEl = $('rows');
  const machineFor = new Map();
  for (const g of state.active) for (const p of g.players) machineFor.set(p.playerId, g.machine?.name);

  const list = [...state.standings].sort((x, y) => (x.eliminated - y.eliminated) || (x.position - y.position));
  const avail = rowsEl.clientHeight || 700;
  const gap = 8;
  const minH = 54;
  const maxH = 104;
  const perPage = Math.max(1, Math.floor((avail + gap) / (minH + gap)));
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  if (boardPage >= pages) boardPage = 0;
  const per = Math.ceil(list.length / pages);
  const slice = list.slice(boardPage * per, boardPage * per + per);
  const h = Math.min(maxH, Math.floor((avail - gap * (per - 1)) / per));

  const oldTop = new Map([...rowsEl.children].map(el => [el.dataset.id, el.getBoundingClientRect().top]));
  const oldPos = new Map((prev?.standings || []).map(s => [s.playerId, s.position]));

  rowsEl.innerHTML = slice.map(s => {
    const cls = ['row'];
    if (!s.eliminated && s.position <= 3) cls.push(`p${s.position}`);
    if (s.playing) cls.push('playing');
    if (s.eliminated) cls.push('out');
    if (oldPos.has(s.playerId) && oldPos.get(s.playerId) > s.position) cls.push('bump');
    const sub = s.playing && machineFor.get(s.playerId) ? `&#9654; ${esc(machineFor.get(s.playerId))}` : '';
    const stat = t.isKnockout && t.maxStrikes
      ? `<div class="pips">${Array.from({ length: t.maxStrikes }, (_, i) => `<div class="pip${i < s.strikes ? ' on' : ''}"></div>`).join('')}</div>
         <div class="pts">${s.points}<small>W</small></div>`
      : `<div class="pts">${s.points}<small>PTS</small></div>`;
    return `<div class="${cls.join(' ')}" data-id="${s.playerId}" style="--h:${h}px">
      <div class="pos">${s.eliminated ? '&times;' : s.position}</div>
      <div class="who"><div class="name">${esc(s.name)}</div>${sub && h >= 64 ? `<div class="sub">${sub}</div>` : ''}</div>
      <div class="stat">${stat}</div>
    </div>`;
  }).join('');

  // Slide rows from their old spot to the new one when positions change.
  for (const el of rowsEl.children) {
    const before = oldTop.get(el.dataset.id);
    if (before == null) continue;
    const dy = before - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 2) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy / currentScale()}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = '';
      el.style.transform = '';
    }));
  }

  $('pager').innerHTML = pages > 1 ? Array.from({ length: pages }, (_, i) => `<i class="${i === boardPage ? 'on' : ''}"></i>`).join('') : '';
  boardPages = pages;
}
let boardPages = 1;

function currentScale() {
  return Math.min(innerWidth / 1920, innerHeight / 1080);
}

// Up to 4 matches get big art cards; 5+ switch to compact two-column rows.
const COMPACT_FROM = 5;
const PER_PAGE = 10;
function layoutFor(n) {
  if (n <= 1) return [1, 1];
  if (n === 2) return [2, 1];
  if (n === 3) return [3, 1];
  if (n === 4) return [2, 2];
  return [2, Math.ceil(n / 2)];
}

function renderCards() {
  const t = state.tournament;
  const cardsEl = $('cards');
  const games = state.active;
  const strikesOf = new Map(state.standings.map(s => [s.playerId, s.strikes]));
  const alive = t.aliveCount;

  if (!games.length) {
    $('matchesTitle').textContent = 'Latest Results';
    cardsEl.style.gridTemplateColumns = '1fr';
    cardsEl.style.gridTemplateRows = '';
    const recent = state.completed.slice(0, 8);
    cardsEl.innerHTML = recent.length
      ? `<div style="display:flex;flex-direction:column;gap:14px">${recent.map(resultHtml).join('')}</div>`
      : `<div class="empty"><div class="big">Get Ready</div><div class="small">Matches will appear here as they start</div></div>`;
    $('waiting').innerHTML = '';
    return;
  }

  $('matchesTitle').textContent = `Now Playing · ${games.length} ${games.length === 1 ? 'Match' : 'Matches'}`;
  const pages = Math.ceil(games.length / PER_PAGE);
  if (cardPage >= pages) cardPage = 0;
  const per = Math.ceil(games.length / pages);
  const shown = games.slice(cardPage * per, cardPage * per + per);
  const compact = games.length >= COMPACT_FROM;
  const [cols, rows] = layoutFor(shown.length);
  cardsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  cardsEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  const W = (cardsEl.clientWidth - 20 * (cols - 1)) / cols;
  const H = (cardsEl.clientHeight - 20 * (rows - 1)) / rows;

  const existing = new Map([...cardsEl.querySelectorAll('.card')].map(el => [el.dataset.id, el]));
  cardsEl.innerHTML = '';

  for (const g of shown) {
    const n = g.players.length;
    const pfs = compact
      ? Math.round(Math.min(H * 0.64 / n, 54))
      : Math.round(Math.min(W * 0.12, (H * 0.6) / (n === 2 ? 2.6 : n + 0.4), 92));
    const mfs = compact ? Math.round(Math.min(H * 0.28, 40)) : Math.round(Math.min(W * 0.1, H * 0.13, 76));
    const strikes = g.players.map(p => strikesOf.get(p.playerId) ?? 0);
    const onBrink = t.isKnockout && t.maxStrikes && strikes.some(s => s >= t.maxStrikes - 1);
    const final = t.isKnockout && alive === 2 && games.length === 1;
    const badge = final ? '<div class="badge danger">CHAMPIONSHIP</div>'
      : onBrink ? `<div class="badge danger">${strikes.every(s => s >= t.maxStrikes - 1) ? 'SUDDEN DEATH' : 'ELIMINATION GAME'}</div>`
      : (firstSeen.get(g.gameId) && Date.now() - firstSeen.get(g.gameId) < 30_000 ? '<div class="badge new">NEW MATCH</div>' : '');

    const playerRow = (p, i) => {
      const pips = t.isKnockout && t.maxStrikes
        ? `<div class="pips">${Array.from({ length: t.maxStrikes }, (_, k) => `<div class="pip${k < strikes[i] ? ' on' : ''}"></div>`).join('')}</div>`
        : '';
      return `<div class="pl"><div class="n">${esc(p.name)}</div>${pips}</div>`;
    };
    const playersHtml = n === 2 && !compact
      ? `${playerRow(g.players[0], 0)}<div class="vs">VS</div>${playerRow(g.players[1], 1)}`
      : g.players.map(playerRow).join('');

    const art = g.machine?.image
      ? `<div class="art" style="background-image:url('${esc(g.machine.image)}')"></div>`
      : `<div class="art gen" style="background:${genBg(g.machine?.name)}"><span>${esc(initials(g.machine?.name))}</span></div>`;

    const card = document.createElement('div');
    card.className = `card${compact ? ' compact' : ''}${onBrink || final ? ' danger' : ''}`;
    card.dataset.id = g.gameId;
    if (existing.has(String(g.gameId))) card.style.animation = 'none';
    card.style.setProperty('--pfs', `${pfs}px`);
    card.style.setProperty('--mfs', `${mfs}px`);
    card.innerHTML = `${art}<div class="shade"></div>
      <div class="badges">${badge}${g.startedAt ? `<div class="badge timer" data-since="${g.startedAt}">${elapsed(g.startedAt)}</div>` : ''}</div>
      <div class="content">
        <div class="machine">${esc(g.machine?.name || 'TBD')}</div>
        <div class="players">${playersHtml}</div>
      </div>`;
    cardsEl.appendChild(card);
  }
  cardPages = pages;

  $('waiting').innerHTML = state.waiting.length
    ? `<b>UP NEXT</b>${state.waiting.map(esc).join(' &middot; ')}`
    : '';
}
let cardPages = 1;

function resultHtml(g) {
  const order = [...g.players].sort((a, b) => (a.place || 9) - (b.place || 9));
  return `<div class="result">
    <div class="m">${esc(g.machine?.name || '')}</div>
    <div class="w">${esc(order[0]?.name)}</div>
    <div class="l">def. ${order.slice(1).map(p => esc(p.name)).join(', ')}</div>
  </div>`;
}

// Video games and unknown machines get a generated gradient instead of backglass art.
function genBg(name = '') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 80% 28%), hsl(${(h + 60) % 360} 85% 14%))`;
}
function initials(name = '') {
  return name.replace(/^the\s+/i, '').split(/\s+/).slice(0, 3).map(w => w[0]).join('').toUpperCase();
}

// ---------- ticker ----------
let tickerText = '';
let tickerX = 0;
let tickerW = 0;
function renderTicker() {
  const items = [];
  if (state.tournament.motd) items.push(`<span class="motd">${esc(state.tournament.motd.text)}</span>`);
  for (const g of state.completed) {
    const order = [...g.players].sort((a, b) => (a.place || 9) - (b.place || 9));
    items.push(`<span><b>${esc(order[0]?.name)}</b> def. ${order.slice(1).map(p => esc(p.name)).join(', ')} &middot; <em>${esc(g.machine?.name || '')}</em></span>`);
  }
  if (state.tournament.status === 'planned' && !items.length) items.push('<span>Grab a drink, warm up a machine &mdash; we start soon.</span>');
  const html = items.join('');
  document.querySelector('#ticker .label').textContent = state.completed.length ? 'Results' : 'Info';
  $('ticker').classList.toggle('hidden', !html);
  if (html === tickerText) return;
  tickerText = html;
  const inner = $('tickerInner');
  inner.innerHTML = html + html;   // doubled for a seamless loop
  tickerW = inner.scrollWidth / 2;
}
function scrollTicker(ts) {
  if (tickerW) {
    tickerX = (tickerX + 1.6) % tickerW;
    $('tickerInner').style.transform = `translateX(${-tickerX}px)`;
  }
  requestAnimationFrame(scrollTicker);
}
requestAnimationFrame(scrollTicker);

// ---------- paging ----------
setInterval(() => {
  if (!state || state.tournament.status !== 'started') return;
  let changed = false;
  if (boardPages > 1) { boardPage = (boardPage + 1) % boardPages; changed = true; }
  if (cardPages > 1) { cardPage = (cardPage + 1) % cardPages; changed = true; }
  if (changed) { renderBoard(); renderCards(); }
}, PAGE_MS);

// ---------- picker ----------
async function showPicker() {
  document.body.classList.add('picking');
  const el = $('picker');
  el.classList.remove('hidden');
  el.innerHTML = `<h1><img src="/logo.png" alt="Deep 6 Arcade">Pick a tournament</h1><p>Loading…</p>`;
  try {
    const { tournaments, auto } = await (await fetch('/api/tournaments')).json();
    const autoT = tournaments.find(t => t.id === auto);
    el.innerHTML = `<h1><img src="/logo.png" alt="Deep 6 Arcade">Pick a tournament</h1>
      <p>Choose what this screen shows. Press F or double-click for fullscreen.</p>
      <a href="/?t=demo"><span>&#9654; Demo &mdash; simulated knockout with fake data</span><small>for testing</small></a>
      <a class="auto" href="/?t=auto"><span>&#9733; Auto &mdash; always show tonight's event</span><small>${autoT ? esc(autoT.name) : ''}</small></a>
      ${tournaments.map(t => `<a href="/?t=${t.id}"><span>${esc(t.name)}</span>
        <small><span class="st ${t.status}">${t.status.toUpperCase()}</span> &nbsp; ${esc(t.startLocal?.slice(0, 10))}</small></a>`).join('')}`;
  } catch (e) {
    el.innerHTML += `<p>Could not load tournaments: ${esc(e.message)}</p>`;
  }
}

// ---------- boot ----------
if (!mode) {
  showPicker();
} else if (mode === 'demo') {
  Demo.start(params.get('speed'));
  setInterval(load, 1000);
  load();
} else if (mode === 'auto') {
  followAuto();
  setInterval(followAuto, 60_000);
} else {
  connectSocket();
  startPolling();
}
