// Shared Matchplay logic for the Vercel functions in /api.
// Fetches a tournament, joins ids to names and machine art, and returns one
// compact state object for the TV page.

const API = 'https://api.matchplay.events/api';
const OPDB_URL = 'https://mp-data.sfo3.cdn.digitaloceanspaces.com/opdb-slim.json';

export async function mp(pathname) {
  const token = process.env.MATCHPLAY_TOKEN;
  if (!token) throw new Error('MATCHPLAY_TOKEN is not set');
  const res = await fetch(API + pathname, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Matchplay ${res.status} on ${pathname}`);
  return res.json();
}

// OPDB backglass art. Kept in module memory so warm function instances reuse it.
let opdb = null;
let opdbAt = 0;
async function getOpdb() {
  if (opdb && Date.now() - opdbAt < 12 * 3600_000) return opdb;
  try {
    const { entries } = await (await fetch(OPDB_URL)).json();
    const map = new Map();
    for (const e of entries) {
      map.set(e.opdbId, {
        year: e.year,
        manufacturer: e.manufacturerName || null,
        image: e.primaryBackglassImage?.urls?.large || null,
      });
    }
    opdb = map;
    opdbAt = Date.now();
  } catch {
    opdb ||= new Map();
  }
  return opdb;
}

async function resolve(kind, tournamentId, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 25) {
    const { data } = await mp(`/tournaments/${tournamentId}/${kind}/resolve-unknown?${kind}=${ids.slice(i, i + 25).join(',')}`);
    out.push(...data);
  }
  return out;
}

export async function getState(id) {
  const [{ data: t }, standingsRaw, { data: games }, { data: rounds }, art] = await Promise.all([
    mp(`/tournaments/${id}?includePlayers=true&includeArenas=true&includeLocation=true`),
    mp(`/tournaments/${id}/standings`),
    mp(`/tournaments/${id}/games`),
    mp(`/tournaments/${id}/rounds`),
    getOpdb(),
  ]);

  const players = new Map((t.players || []).map(p => [p.playerId, p]));
  const arenas = new Map((t.arenas || []).map(a => [a.arenaId, a]));

  // Players or machines added mid-event may not be in the tournament payload.
  const unknownPlayers = new Set();
  for (const g of games) for (const p of g.playerIds || []) if (!players.has(p)) unknownPlayers.add(p);
  for (const s of standingsRaw) if (!players.has(s.playerId)) unknownPlayers.add(s.playerId);
  const unknownArenas = [...new Set(games.map(g => g.arenaId).filter(a => a && !arenas.has(a)))];
  const [morePlayers, moreArenas] = await Promise.all([
    unknownPlayers.size ? resolve('players', id, [...unknownPlayers]) : [],
    unknownArenas.length ? resolve('arenas', id, unknownArenas) : [],
  ]);
  for (const p of morePlayers) players.set(p.playerId, p);
  for (const a of moreArenas) arenas.set(a.arenaId, a);

  const name = pid => players.get(pid)?.name || `Player ${pid}`;
  const machine = arenaId => {
    const a = arenas.get(arenaId);
    if (!a) return null;
    const o = a.opdbId ? art.get(a.opdbId) : null;
    return { arenaId, name: a.name, year: o?.year ?? null, manufacturer: o?.manufacturer ?? null, image: o?.image ?? null };
  };

  const isKnockout = /knockout/.test(t.type);
  const maxStrikes = t.knockoutStrikeCount || null;
  const roundName = new Map(rounds.map(r => [r.roundId, r.name]));

  let standings = standingsRaw.map(s => ({
    playerId: s.playerId,
    name: name(s.playerId),
    position: s.position,
    points: Number(s.points),
    gamesPlayed: s.gamesPlayed,
    strikes: s.strikeCount ?? 0,
    playing: (s.activeGames || []).length > 0,
    eliminated: isKnockout && maxStrikes
      ? s.strikeCount >= maxStrikes
      : players.get(s.playerId)?.tournamentPlayer?.status === 'inactive',
  }));

  const real = games.filter(g => !g.bye);
  if (isKnockout && maxStrikes) standings = rankKnockout(standings, real, rounds);

  const view = g => ({
    gameId: g.gameId,
    round: roundName.get(g.roundId) || null,
    status: g.status,
    startedAt: g.startedAt,
    machine: machine(g.arenaId),
    players: (g.playerIds || []).map((pid, i) => ({
      playerId: pid,
      name: name(pid),
      points: g.resultPoints?.[i] != null ? Number(g.resultPoints[i]) : null,
      place: g.resultPositions?.length ? g.resultPositions.indexOf(pid) + 1 || null : null,
    })),
  });

  const active = real.filter(g => g.status === 'started').map(view);
  const completed = real
    .filter(g => g.status === 'completed')
    .sort((a, b) => b.gameId - a.gameId)
    .slice(0, 12)
    .map(view);

  const busy = new Set(active.flatMap(g => g.players.map(p => p.playerId)));
  const currentRound = [...rounds].sort((a, b) => b.index - a.index)[0] || null;

  return {
    updatedAt: new Date().toISOString(),
    tournament: {
      id: t.tournamentId,
      name: t.name,
      type: t.type,
      status: t.status,
      startLocal: t.startLocal,
      location: t.location?.name || null,
      motd: t.motdText ? { text: t.motdText, color: t.motdColor } : null,
      maxStrikes,
      isKnockout,
      playerCount: players.size,
      aliveCount: standings.filter(s => !s.eliminated).length,
    },
    round: currentRound ? { name: currentRound.name, status: currentRound.status } : null,
    standings,
    active,
    completed,
    waiting: standings.filter(s => !s.eliminated && !busy.has(s.playerId)).map(s => s.name),
    registered: t.status === 'planned' ? [...players.values()].map(p => p.name) : [],
  };
}

// Knockouts are won by the last player standing, but Matchplay's standings sort
// by points. Re-rank: alive players by fewest strikes, then knocked-out players
// by the round they went out in (later is better). Same key = shared position.
function rankKnockout(standings, games, rounds) {
  const roundIndex = new Map(rounds.map(r => [r.roundId, r.index]));
  const outRound = new Map();
  for (const g of games) {
    const idx = roundIndex.get(g.roundId) ?? -1;
    for (const pid of g.playerIds || []) outRound.set(pid, Math.max(outRound.get(pid) ?? -1, idx));
  }
  const key = s => (s.eliminated ? `out:${outRound.get(s.playerId) ?? -1}` : `in:${s.strikes}`);
  const sorted = [...standings].sort((a, b) =>
    (a.eliminated - b.eliminated)
    || (a.eliminated
      ? (outRound.get(b.playerId) ?? -1) - (outRound.get(a.playerId) ?? -1)
      : a.strikes - b.strikes)
    || b.points - a.points);
  sorted.forEach((s, i) => {
    s.position = i > 0 && key(sorted[i - 1]) === key(s) ? sorted[i - 1].position : i + 1;
  });
  return sorted;
}

export async function getTournaments() {
  const { data: me } = await mp('/users/profile');
  const { data } = await mp(`/tournaments?owner=${me.userId}&limit=25`);
  const list = data.map(t => ({ id: t.tournamentId, name: t.name, status: t.status, type: t.type, startLocal: t.startLocal }));
  // "auto": the running event, else the next planned one, else the latest finished one.
  const started = list.filter(t => t.status === 'started').sort((a, b) => b.startLocal.localeCompare(a.startLocal));
  const planned = list.filter(t => t.status === 'planned').sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  const done = list.filter(t => t.status === 'completed').sort((a, b) => b.startLocal.localeCompare(a.startLocal));
  // A finished event stays on screen for the rest of its night (12h) before rolling to the next planned one.
  const recentDone = done[0] && Date.now() - Date.parse(done[0].startLocal.replace(' ', 'T')) < 12 * 3600_000 ? done[0] : null;
  const auto = started[0] || recentDone || planned[0] || done[0] || null;
  return { auto: auto?.id ?? null, tournaments: list };
}
