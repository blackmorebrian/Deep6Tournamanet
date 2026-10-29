import { getTournaments } from '../lib/matchplay.js';

// GET /api/tournaments → { auto, tournaments: [...] } for the token owner's events.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const body = await getTournaments();
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.end(JSON.stringify(body));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: e.message }));
  }
}
