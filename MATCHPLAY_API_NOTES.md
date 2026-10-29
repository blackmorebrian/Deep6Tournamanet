# Matchplay API — research notes

Source: https://docs.matchplay.events/api (verified against live API on 2026-10-29)

## Basics
- Base URL: `https://api.matchplay.events/api/...` (read-only API)
- Auth: `Authorization: Bearer <token>` — token from https://app.matchplay.events/account/tokens
- Rate limit: ~120 req/min with token; **only 6 req/min without** (seen in `x-ratelimit-limit` header). Search is 15/min.
- **CORS only allows `https://app.matchplay.events`** → a browser page cannot call the API directly. Need a small server/proxy that holds the token, caches, and serves the TV page. (Matchplay's docs also require a storage/cache layer and "fetch once for all users".)
- Standings: poll no more than every 15s while in progress; fetch once when completed.

## Endpoints the dashboard needs
| Purpose | Endpoint | Auth needed? |
|---|---|---|
| Tournament + players + machines | `GET /tournaments/{id}?includePlayers=true&includeArenas=true` | no (but send it) |
| Leaderboard | `GET /tournaments/{id}/standings` | no |
| Rounds | `GET /tournaments/{id}/rounds` | no |
| Matchups (multi-player games) | `GET /games?tournaments={id}&status=started` (also `round=`, `player=`, `arena=`) | **yes (401 without)** |
| **Matchups with players + results** (undocumented, what we use) | `GET /tournaments/{id}/games` (`status=started` works); returns `playerIds, resultPositions` (winner first), `resultPoints` (aligned to playerIds), unpaginated | yes |
| Best-game / pingolf scores | `GET /tournaments/{id}/single-player-games?sortBy=score&limit=500` | — |
| Card-based best game | `GET /tournaments/{id}/cards` | — |
| Resolve new player/arena ids | `GET /tournaments/{id}/players/resolve-unknown?players=1,2` (max 25) | — |
| Find tournaments | `GET /tournaments?status=started&owner={userId}` / `GET /search?query=...&type=tournaments` | — |

APIs return only `playerId` / `arenaId` in games and standings — join against the players/arenas from the tournament fetch.

## Response shapes (observed)
- Tournament: `tournamentId, name, status (planned|started|completed), type, pointsMap, scoring, timezone, motdText/motdColor (announcement banner), location{name,address}, players[], arenas[]`
- Types seen: `matchplay, group_matchplay, max_matchplay, best_game, frenzy, group_bracket` (also pingolf, elimination, knockout, etc.)
- Player: `playerId, name, ifpaId, tournamentPlayer{status, seed, labels, labelColor}`
- Arena (machine): `arenaId, name, opdbId, tournamentArena{status active|inactive}`
- Standing row: `playerId, position, points ("1.00" string), gamesPlayed, strikeCount, frenzyWins/Losses, activeGames[gameIds], activeGameColor, onCutoffBubble, cutoffBubbleColor`
- Round: `roundId, name ("Round 2"), index, status, createdAt, completedAt`

## Real-time (websocket, Pusher protocol) — works without auth
- Connect: `wss://ws.app.matchplay.events/app/tnrxzkahdeullnwje83e?protocol=7&client=js&version=8.5.0&flash=false`
- On `pusher:connection_established`, send `{"event":"pusher:subscribe","data":{"auth":"","channel":"tournaments.{ID}"}}`
- Events: `TournamentUpdated, RoundCreatedOrUpdated, RoundsDeleted, GameCreatedOrUpdated, GamesDeleted, SinglePlayerGameCreatedOrUpdated, SinglePlayerGamesDeleted, PlayersAdded/Changed, ArenasAdded/Changed, QueueChanged`
- Marked "experimental". Server must reply to pings (activity_timeout 30s). Plan: use socket as a trigger to refetch, with a 15–30s polling fallback.

## Machine art (great for TVs)
- `https://mp-data.sfo3.cdn.digitaloceanspaces.com/opdb-slim.json` (~2.2MB, daily) — `{entries:[{opdbId, name, year, manufacturerName, primaryBackglassImage}]}`; match on arena `opdbId`.
- Ratings CSV: `https://mp-ratings.sfo3.cdn.digitaloceanspaces.com/latest-ratings.csv`
