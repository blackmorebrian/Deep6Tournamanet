import { getState } from '../lib/matchplay.js';

// GET /api/state?t=<tournamentId>
// Cached at Vercel's edge so every TV shares one Matchplay fetch per 15s
// (Matchplay asks for standings no more than once every 15 seconds).
export default async function handler(req, res) {
  const id = new URL(req.url, 'http://x').searchParams.get('t');
  res.setHeader('Content-Type', 'application/json');
  if (!/^\d+$/.test(id || '')) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Pass ?t=<tournament id>' }));
  }
  try {
    const state = await getState(id);
    const done = state.tournament.status === 'completed';
    res.setHeader('Cache-Control', done
      ? 'public, s-maxage=3600, stale-while-revalidate=86400'
      : 'public, s-maxage=15, stale-while-revalidate=15');
    res.end(JSON.stringify(state));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: e.message }));
  }
}
