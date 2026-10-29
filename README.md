# Deep 6 Live

A big-screen tournament dashboard for Deep 6 Arcade, powered by [Matchplay](https://matchplay.events).
Built for a bar TV used as a computer monitor: fixed 16:9 layout that scales to any screen, large type, high contrast.

## What it shows
- **Standings**: strike pips for knockouts (or points for other formats), who's playing right now and on which machine, knocked-out players crossed off. Pages automatically if it doesn't fit.
- **Now Playing**: one card per live match with the machine's backglass art, a match timer, and **ELIMINATION GAME / SUDDEN DEATH / CHAMPIONSHIP** badges.
- **Big moments**: full-screen WINNER, ELIMINATED and CHAMPION takeovers as results come in.
- **Before / after**: a "Next up" screen with the start time and roster, and a podium when it's over.
- **Ticker**: recent results plus the tournament's announcement banner from Matchplay.

## URLs
| URL | Shows |
|---|---|
| `/` | Picker listing your Matchplay tournaments |
| `/?t=auto` | **Recommended for the TV.** Follows tonight's event automatically: the running one, otherwise the next planned one (a finished event stays up for the rest of that night). |
| `/?t=280574` | A specific tournament |
| `/?t=demo` | **Fake data for testing.** A simulated 16-player, 3-strike knockout runs in your browser: starting-soon screen, rounds, strikes, eliminations, champion podium, then it starts over. Add `&speed=1` for a real-time pace (default `3`, higher is faster). |

On the TV: press **F** or double-click for fullscreen. The cursor hides itself.

## How it works
```
TV browser ──/api/state──▶ Vercel function (holds token) ──▶ api.matchplay.events
     │                       └ edge-cached 15s, so all screens share one fetch
     └──websocket──▶ ws.app.matchplay.events (live "something changed" pings)
```
- The Matchplay API can't be called directly from a browser (CORS) and needs the token kept secret, so `api/state.js` proxies it.
- The edge cache means Matchplay sees at most one standings request per 15s, as their docs require.
- The browser listens to Matchplay's real-time socket and refetches when a score is entered, with a 15s poll as a fallback.
- Knockout ranking follows Matchplay's rule: the last player standing wins. Survivors are ranked by fewest strikes, and knocked-out players by the round they went out.

## Deploy to Vercel
1. Push this folder to a GitHub repo (`.env` is gitignored, so it won't be committed).
2. Import the repo in Vercel. Framework preset: **Other**. No build command needed.
3. In Project → Settings → Environment Variables, add `MATCHPLAY_TOKEN` with your token.
4. Deploy, then open `https://<your-app>.vercel.app/?t=auto` on the TV.

## Run locally
```bash
node dev.js
```
Then open http://localhost:3000. This reads `MATCHPLAY_TOKEN` from `.env` and needs Node 20+.

## Files
- `api/state.js`, `api/tournaments.js`: Vercel functions
- `lib/matchplay.js`: Matchplay fetching, joining names and machine art, knockout ranking
- `public/`: the TV page (`index.html`, `style.css`, `app.js`, `logo.png`)
- `dev.js`: local stand-in for Vercel
- `MATCHPLAY_API_NOTES.md`: API research notes
