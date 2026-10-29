// Fake 3-strike knockout for testing the dashboard without a live event.
// Open /?t=demo (optionally &speed=5). Produces the same shape as /api/state.

window.Demo = (() => {
  const PLAYERS = [
    'Andie', 'AJ', 'Jacob F', 'Wolfie', 'RC Cola', 'Vin R', 'Ben F', 'Cam R',
    'Dom R', 'Lynn Hill', 'Dwayne', 'Audrey Spiteri', 'Jol', 'Denise', 'Kai', 'Maximiliano Fitzgerald',
  ];
  const MACHINES = [
    ['Twilight Zone', 'https://img.opdb.org/f1ca6157-1703-4414-8af3-b08023bfdfc5-large.jpg'],
    ['Medieval Madness', 'https://img.opdb.org/0fd1477a-cf84-49d6-8495-d58d26c34529-large.jpg'],
    ['Attack from Mars', 'https://img.opdb.org/d8add1d1-f114-4efb-87f6-0800d85a5c2f-large.jpg'],
    ['Theatre of Magic', 'https://img.opdb.org/bd193819-5e80-4e4b-88fe-48ed160efff1-large.jpg'],
    ['Monster Bash', 'https://img.opdb.org/c3e4b8e5-b285-49c5-8d35-32bf1195ccc4-large.jpg'],
    ['Deadpool (Pro)', 'https://img.opdb.org/4cb6b567-180c-4caf-83ab-159255de6061-large.jpg'],
    ['Foo Fighters (Pro)', 'https://img.opdb.org/bc8f4662-5be2-4d79-b020-21c9b5cacd1a-large.jpg'],
    ['Star Wars (Pro)', 'https://img.opdb.org/3162b368-9cca-439d-8ac3-23ffd57a823a-large.jpg'],
    ['Black Knight 2000', 'https://img.opdb.org/24955239-a8b7-41ae-b8f6-30d8167dc655-large.jpg'],
    ['Funhouse', 'https://img.opdb.org/6ff7016e-5d1c-4615-b9c8-2aa6d7979b0d-large.jpg'],
    ['Galaga', null],               // video games: no backglass, tests the fallback art
    ['Street Fighter II', null],
  ];
  const MAX_STRIKES = 3;
  const PLANNED_MS = 12_000;        // "Next up" screen before the event starts
  const RESTART_MS = 45_000;        // podium time before the demo starts over

  let speed = 3;
  let sim;

  const shuffle = a => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  function reset() {
    sim = {
      startAt: Date.now() + PLANNED_MS,
      status: 'planned',
      players: PLAYERS.map((name, i) => ({ playerId: i + 1, name, strikes: 0, points: 0, gamesPlayed: 0, outRound: null })),
      machines: MACHINES.map(([name, image], i) => ({ arenaId: 100 + i, name, image, year: null, manufacturer: null })),
      round: 0,
      active: [],
      completed: [],
      nextGameId: 1000,
      nextRoundAt: 0,
      doneAt: 0,
      version: 0,
    };
  }

  function startRound() {
    sim.round += 1;
    const alive = shuffle(sim.players.filter(p => p.strikes < MAX_STRIKES));
    if (alive.length % 2) {
      const bye = alive.pop();
      bye.points += 1;
      bye.gamesPlayed += 1;
    }
    const machines = shuffle([...sim.machines]);
    for (let i = 0; i < alive.length; i += 2) {
      const lengthMs = (25_000 + Math.random() * 50_000) / speed;
      sim.active.push({
        gameId: sim.nextGameId++,
        round: `Round ${sim.round}`,
        status: 'started',
        startedAt: new Date().toISOString(),
        endsAt: Date.now() + lengthMs,
        machine: machines[(i / 2) % machines.length],
        players: [alive[i], alive[i + 1]].map(p => ({ playerId: p.playerId, name: p.name, points: null, place: null })),
      });
    }
    sim.version++;
  }

  function finish(game) {
    const [a, b] = game.players;
    const winner = Math.random() < 0.5 ? a : b;
    const loser = winner === a ? b : a;
    const pw = sim.players[winner.playerId - 1];
    const pl = sim.players[loser.playerId - 1];
    pw.points += 1;
    pw.gamesPlayed += 1;
    pl.gamesPlayed += 1;
    pl.strikes += 1;
    if (pl.strikes >= MAX_STRIKES) pl.outRound = sim.round;
    winner.points = 1; winner.place = 1;
    loser.points = 0; loser.place = 2;
    sim.completed.unshift({ ...game, status: 'completed', players: [winner, loser] });
    sim.active = sim.active.filter(g => g !== game);
    sim.version++;
  }

  function step() {
    const now = Date.now();
    if (sim.status === 'planned' && now >= sim.startAt) {
      sim.status = 'started';
      startRound();
    }
    if (sim.status === 'started') {
      for (const g of [...sim.active]) if (now >= g.endsAt) finish(g);
      if (!sim.active.length) {
        const alive = sim.players.filter(p => p.strikes < MAX_STRIKES);
        if (alive.length <= 1) {
          sim.status = 'completed';
          sim.doneAt = now;
          sim.version++;
        } else if (!sim.nextRoundAt) {
          sim.nextRoundAt = now + 4000 / Math.min(speed, 2);
        } else if (now >= sim.nextRoundAt) {
          sim.nextRoundAt = 0;
          startRound();
        }
      }
    }
    if (sim.status === 'completed' && now - sim.doneAt > RESTART_MS) reset();
  }

  // Same ranking as lib/matchplay.js: alive by fewest strikes, then by round knocked out.
  function standings() {
    const busy = new Set(sim.active.flatMap(g => g.players.map(p => p.playerId)));
    const rows = sim.players.map(p => ({
      playerId: p.playerId,
      name: p.name,
      points: p.points,
      gamesPlayed: p.gamesPlayed,
      strikes: p.strikes,
      playing: busy.has(p.playerId),
      eliminated: p.strikes >= MAX_STRIKES,
      outRound: p.outRound,
    }));
    const key = s => (s.eliminated ? `out:${s.outRound}` : `in:${s.strikes}`);
    rows.sort((a, b) => (a.eliminated - b.eliminated)
      || (a.eliminated ? b.outRound - a.outRound : a.strikes - b.strikes)
      || b.points - a.points);
    rows.forEach((s, i) => { s.position = i > 0 && key(rows[i - 1]) === key(s) ? rows[i - 1].position : i + 1; });
    return rows;
  }

  function state() {
    step();
    const st = standings();
    const start = new Date(sim.startAt);
    const pad = n => String(n).padStart(2, '0');
    return {
      version: sim.version,
      updatedAt: new Date().toISOString(),
      tournament: {
        id: 'demo',
        name: 'Deep 6 Arcade | Demo Night',
        type: 'knockout',
        status: sim.status,
        startLocal: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}:${pad(start.getMinutes())}:00`,
        location: 'Deep 6 Arcade',
        motd: { text: 'DEMO MODE: fake data for testing', color: null },
        maxStrikes: MAX_STRIKES,
        isKnockout: true,
        playerCount: sim.players.length,
        aliveCount: st.filter(s => !s.eliminated).length,
      },
      round: sim.round ? { name: `Round ${sim.round}`, status: sim.active.length ? 'started' : 'completed' } : null,
      standings: st,
      active: sim.active,
      completed: sim.completed.slice(0, 12),
      waiting: st.filter(s => !s.eliminated && !s.playing).map(s => s.name),
      registered: sim.status === 'planned' ? PLAYERS : [],
    };
  }

  return {
    start(s) {
      speed = Math.max(0.25, Number(s) || 3);
      reset();
    },
    state,
  };
})();
