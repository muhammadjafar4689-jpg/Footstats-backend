// FOOTSTATS PREDICTION CHALLENGE BACKEND
// Complete server.js
// Node.js + Express + The Odds API + Supabase

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCORING_SECRET = process.env.SCORING_SECRET;

const ODDS_BASE = "https://api.the-odds-api.com/v4";
const MAX_PICKS = 15;
const POINTS_PER_PICK = 3;
const MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

const COMPETITIONS = [
  { code: "PL", name: "Premier League", country: "England", sport: "soccer_epl" },
  { code: "ELC", name: "Championship", country: "England", sport: "soccer_efl_champ" },
  { code: "PD", name: "La Liga", country: "Spain", sport: "soccer_spain_la_liga" },
  { code: "SA", name: "Serie A", country: "Italy", sport: "soccer_italy_serie_a" },
  { code: "BL1", name: "Bundesliga", country: "Germany", sport: "soccer_germany_bundesliga" },
  { code: "FL1", name: "Ligue 1", country: "France", sport: "soccer_france_ligue_one" },
  { code: "CL", name: "UEFA Champions League", country: "Europe", sport: "soccer_uefa_champs_league" },
  { code: "EL", name: "UEFA Europa League", country: "Europe", sport: "soccer_uefa_europa_league" },
  { code: "PPL", name: "Primeira Liga", country: "Portugal", sport: "soccer_portugal_primeira_liga" },
  { code: "DED", name: "Eredivisie", country: "Netherlands", sport: "soccer_netherlands_eredivisie" },
  { code: "BSA", name: "Campeonato Brasileiro Série A", country: "Brazil", sport: "soccer_brazil_campeonato" },
  { code: "WC", name: "FIFA World Cup", country: "World", sport: "soccer_fifa_world_cup" },
  { code: "EC", name: "European Championship", country: "Europe", sport: "soccer_uefa_european_championship" }
];

const TEAM_ALIASES = {
  "atletico mineiro": ["ca mineiro", "atletico mg", "atl mineiro", "galo"],
  "ca mineiro": ["atletico mineiro", "atletico mg", "atl mineiro"],
  "rb bragantino": ["red bull bragantino", "bragantino", "bragantino sp"],
  "red bull bragantino": ["rb bragantino", "bragantino", "bragantino sp"],
  "chapecoense": ["chapecoense af", "associacao chapecoense"],
  "rem o": ["clube do remo", "remo"],
  "clube do remo": ["remo"],
  "inter milan": ["fc internazionale milano", "internazionale", "inter", "internazionale milano"],
  "internazionale": ["inter milan", "fc internazionale milano", "inter"],
  "ac milan": ["milan", "associazione calcio milan"],
  "bologna": ["bologna fc 1909", "fc bologna"],
  "juventus": ["juventus fc"],
  "napoli": ["ssc napoli", "societa sportiva calcio napoli"],
  "sporting cp": ["sporting clube de portugal", "sporting lisbon", "sporting"],
  "sporting clube de portugal": ["sporting cp", "sporting lisbon", "sporting"],
  "casa pia": ["casa pia ac"],
  "lille": ["lille osc"],
  "lens": ["rc lens", "racing club de lens"],
  "sao paulo": ["sao paulo fc", "são paulo", "são paulo fc"],
  "bahia": ["ec bahia"],
  "palmeiras": ["se palmeiras"],
  "santos": ["santos fc"],
  "fluminense": ["fluminense fc"],
  "internacional": ["sc internacional", "internacional rs"],
  "botafogo": ["botafogo fr", "botafogo rj"],
  "cruzeiro": ["cruzeiro ec"],
  "parma": ["parma calcio 1913"],
  "udinese": ["udinese calcio"],
  "fiorentina": ["acf fiorentina"],
  "atalanta": ["atalanta bc"],
  "genoa": ["genoa cfc"],
  "venezia": ["venezia fc"],
  "monza": ["ac monza"],
  "frosinone": ["frosinone calcio"],
  "lecce": ["us lecce"]
};

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(fc|cf|sc|ac|af|as|ss|ssc|cfc|bc|ec|fr|calcio|football club|club de futebol)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalTeamName(value) {
  const name = normalizeText(value);

  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    const all = [canonical, ...aliases].map(normalizeText);

    if (all.includes(name)) {
      return normalizeText(canonical);
    }
  }

  return name;
}

function teamsMatch(a, b) {
  const first = canonicalTeamName(a);
  const second = canonicalTeamName(b);

  if (!first || !second) return false;
  if (first === second) return true;

  const compactFirst = first.replace(/\s/g, "");
  const compactSecond = second.replace(/\s/g, "");

  if (compactFirst === compactSecond) return true;

  // Avoid matching very short team names by substring alone.
  const firstWords = first.split(" ").filter(Boolean);
  const secondWords = second.split(" ").filter(Boolean);

  if (
    firstWords.length > 1 &&
    secondWords.length > 1 &&
    (first.includes(second) || second.includes(first))
  ) {
    return true;
  }

  return false;
}

function getSportKey(league, suppliedSport) {
  if (suppliedSport && String(suppliedSport).startsWith("soccer_")) {
    return suppliedSport;
  }

  const normalized = normalizeText(league);

  const aliases = {
    "premier league": "soccer_epl",
    "english premier league": "soccer_epl",
    "championship": "soccer_efl_champ",
    "english championship": "soccer_efl_champ",
    "la liga": "soccer_spain_la_liga",
    "spanish la liga": "soccer_spain_la_liga",
    "serie a": "soccer_italy_serie_a",
    "italian serie a": "soccer_italy_serie_a",
    "bundesliga": "soccer_germany_bundesliga",
    "ligue 1": "soccer_france_ligue_one",
    "french ligue 1": "soccer_france_ligue_one",
    "champions league": "soccer_uefa_champs_league",
    "uefa champions league": "soccer_uefa_champs_league",
    "europa league": "soccer_uefa_europa_league",
    "primeira liga": "soccer_portugal_primeira_liga",
    "portuguese primeira liga": "soccer_portugal_primeira_liga",
    "portugal first league": "soccer_portugal_primeira_liga",
    "eredivisie": "soccer_netherlands_eredivisie",
    "netherlands first league": "soccer_netherlands_eredivisie",
    "dutch eredivisie": "soccer_netherlands_eredivisie",
    "campeonato brasileiro serie a": "soccer_brazil_campeonato",
    "brazilian serie a": "soccer_brazil_campeonato",
    "brazil first league": "soccer_brazil_campeonato",
    "fifa world cup": "soccer_fifa_world_cup",
    "world cup": "soccer_fifa_world_cup",
    "european championship": "soccer_uefa_european_championship",
    "euro": "soccer_uefa_european_championship"
  };

  if (aliases[normalized]) return aliases[normalized];

  const competition = COMPETITIONS.find(c =>
    c.code.toLowerCase() === String(league || "").toLowerCase()
  );

  return competition ? competition.sport : null;
}

async function oddsRequest(path, params = {}) {
  if (!ODDS_API_KEY) {
    throw new Error("ODDS_API_KEY is not configured in Render.");
  }

  const query = new URLSearchParams({
    ...params,
    apiKey: ODDS_API_KEY
  });

  const response = await fetch(`${ODDS_BASE}${path}?${query}`);

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message = body?.message || body?.error || `Odds API HTTP ${response.status}`;
    throw new Error(message);
  }

  return {
    data: body,
    requestsRemaining: response.headers.get("x-requests-remaining"),
    requestsUsed: response.headers.get("x-requests-used")
  };
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase environment variables are not configured.");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  let result = null;

  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = text;
  }

  if (!response.ok) {
    const message =
      result?.message ||
      result?.hint ||
      result?.details ||
      `Supabase HTTP ${response.status}`;

    throw new Error(message);
  }

  return result;
}

function getTeamNames(pick) {
  const fixture = pick.fixture || {};
  const match = pick.match || {};

  return {
    home:
      pick.home ||
      pick.home_team ||
      pick.homeTeam ||
      pick.homeTeamName ||
      match.home ||
      match.home_team ||
      fixture.home_team ||
      fixture.homeTeam ||
      "",
    away:
      pick.away ||
      pick.away_team ||
      pick.awayTeam ||
      pick.awayTeamName ||
      match.away ||
      match.away_team ||
      fixture.away_team ||
      fixture.awayTeam ||
      ""
  };
}

function getPickKickoff(pick) {
  const match = pick.match || {};
  const fixture = pick.fixture || {};

  const value =
    pick.kickoff ||
    pick.kickoff_time ||
    pick.commence_time ||
    pick.start_time ||
    pick.date ||
    pick.match_date ||
    pick.matchDate ||
    match.kickoff ||
    match.commence_time ||
    match.date ||
    fixture.kickoff ||
    fixture.commence_time ||
    fixture.date ||
    null;

  if (!value) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getSavedEventId(pick) {
  const match = pick.match || {};
  const fixture = pick.fixture || {};

  return (
    pick.odds_event_id ||
    pick.event_id ||
    pick.eventId ||
    pick.fixture_id ||
    pick.fixtureId ||
    match.odds_event_id ||
    match.event_id ||
    fixture.odds_event_id ||
    fixture.event_id ||
    null
  );
}

function getFinalOutcome(event) {
  if (!event || event.completed !== true) return null;

  const scores = event.scores;

  if (!Array.isArray(scores) || scores.length < 2) {
    return null;
  }

  const homeScore = scores.find(score =>
    teamsMatch(score.name, event.home_team)
  );

  const awayScore = scores.find(score =>
    teamsMatch(score.name, event.away_team)
  );

  if (!homeScore || !awayScore) return null;

  const home = Number(homeScore.score);
  const away = Number(awayScore.score);

  if (!Number.isFinite(home) || !Number.isFinite(away)) {
    return null;
  }

  if (home > away) return "home";
  if (away > home) return "away";

  return "draw";
}

function normalizeChoice(value) {
  const choice = normalizeText(value);

  if (["home", "1", "home win", "team a"].includes(choice)) return "home";
  if (["draw", "x", "tie", "equal"].includes(choice)) return "draw";
  if (["away", "2", "away win", "team b"].includes(choice)) return "away";

  return null;
}

function findMatchingEvent(pick, events) {
  const { home, away } = getTeamNames(pick);

  if (!home || !away || !Array.isArray(events)) {
    return null;
  }

  const pickTime = getPickKickoff(pick);
  const savedId = getSavedEventId(pick);

  // First choice: exact event ID, but only if the event is completed
  // and its final score is usable.
  if (savedId) {
    const byId = events.find(event =>
      String(event.id) === String(savedId)
    );

    if (
      byId &&
      byId.completed === true &&
      getFinalOutcome(byId) !== null &&
      teamsMatch(home, byId.home_team) &&
      teamsMatch(away, byId.away_team)
    ) {
      return byId;
    }
  }

  // Never grade a fixture that has not been marked completed.
  const candidates = events.filter(event =>
    event.completed === true &&
    teamsMatch(home, event.home_team) &&
    teamsMatch(away, event.away_team) &&
    getFinalOutcome(event) !== null
  );

  if (!candidates.length) return null;

  // If the saved pick has a kickoff time, use it to avoid matching
  // the same teams' fixture from a different date.
  if (pickTime !== null) {
    const timed = candidates
      .map(event => {
        const eventTime = Date.parse(event.commence_time || "");

        return {
          event,
          difference: Number.isFinite(eventTime)
            ? Math.abs(pickTime - eventTime)
            : Infinity
        };
      })
      .filter(item => item.difference <= MATCH_WINDOW_MS)
      .sort((a, b) => a.difference - b.difference);

    if (!timed.length) return null;

    // If two possible fixtures are too close in time, do not guess.
    if (
      timed.length > 1 &&
      timed[1].difference - timed[0].difference < 60 * 60 * 1000
    ) {
      return null;
    }

    return timed[0].event;
  }

  // Without a saved kickoff, accept only one unambiguous completed match.
  return candidates.length === 1 ? candidates[0] : null;
}

function getPickChoice(pick) {
  return normalizeChoice(
    pick.choice ||
    pick.prediction ||
    pick.selection ||
    pick.pick ||
    pick.outcome
  );
}

function getPickLeague(pick) {
  return (
    pick.league ||
    pick.competition ||
    pick.league_name ||
    pick.competition_name ||
    pick.leagueCode ||
    pick.competitionCode ||
    ""
  );
}

function getPickSport(pick) {
  return (
    pick.sport_key ||
    pick.sportKey ||
    pick.sport ||
    pick.odds_sport ||
    ""
  );
}

function safeDate(value) {
  if (!value) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
}

// ------------------------------------------------------
// GENERAL ROUTES
// ------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    name: "FootStats Backend",
    status: "online",
    provider: "The Odds API",
    endpoints: [
      "/api/health",
      "/api/diagnostic",
      "/api/competitions",
      "/api/odds/sports",
      "/api/odds?sport=soccer_italy_serie_a",
      "/api/fixtures",
      "/api/scores?sport=soccer_italy_serie_a&daysFrom=3",
      "/api/leaderboard",
      "POST /api/score-predictions"
    ]
  });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "online" });
});

app.get("/api/diagnostic", (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    apiKeyConfigured: Boolean(ODDS_API_KEY),
    supabaseConfigured: Boolean(
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ),
    scoringSecretConfigured: Boolean(SCORING_SECRET)
  });
});

app.get("/api/competitions", (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    competitionsReturned: COMPETITIONS.length,
    competitions: COMPETITIONS
  });
});

// ------------------------------------------------------
// ODDS API ROUTES
// ------------------------------------------------------

app.get("/api/odds/sports", async (req, res) => {
  try {
    const result = await oddsRequest("/sports", { all: "true" });

    res.json({
      success: true,
      count: Array.isArray(result.data) ? result.data.length : 0,
      requestsRemaining: result.requestsRemaining,
      sports: result.data
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/odds", async (req, res) => {
  try {
    const sport = req.query.sport || "soccer_epl";

    const result = await oddsRequest(`/sports/${encodeURIComponent(sport)}/odds`, {
      regions: req.query.regions || "uk",
      markets: req.query.markets || "h2h",
      oddsFormat: req.query.oddsFormat || "decimal",
      dateFormat: "iso"
    });

    res.json({
      success: true,
      sport,
      count: Array.isArray(result.data) ? result.data.length : 0,
      requestsRemaining: result.requestsRemaining,
      matches: result.data
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------
// FIXTURES AND SCORES
// ------------------------------------------------------

app.get("/api/scores", async (req, res) => {
  try {
    const sport = req.query.sport || "soccer_epl";
    const requestedDays = Number.parseInt(req.query.daysFrom || "3", 10);
    const daysFrom = Math.max(1, Math.min(3, Number.isFinite(requestedDays) ? requestedDays : 3));

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/scores`,
      {
        daysFrom: String(daysFrom),
        dateFormat: "iso"
      }
    );

    res.json({
      success: true,
      sport,
      daysFrom,
      count: Array.isArray(result.data) ? result.data.length : 0,
      requestsRemaining: result.requestsRemaining,
      scores: result.data
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/fixtures", async (req, res) => {
  try {
    const requestedLeague = req.query.league;
    const requestedSport = req.query.sport;

    let competitions = COMPETITIONS;

    if (requestedLeague) {
      const normalizedLeague = normalizeText(requestedLeague);

      competitions = COMPETITIONS.filter(competition =>
        normalizeText(competition.code) === normalizedLeague ||
        normalizeText(competition.name) === normalizedLeague ||
        normalizeText(competition.sport) === normalizedLeague
      );

      if (!competitions.length) {
        const sport = getSportKey(requestedLeague, requestedSport);

        if (sport) {
          competitions = [{
            code: requestedLeague,
            name: requestedLeague,
            country: "",
            sport
          }];
        }
      }
    } else if (requestedSport) {
      const sport = getSportKey("", requestedSport);

      competitions = sport
        ? [{ code: requestedSport, name: requestedSport, country: "", sport }]
        : [];
    }

    if (!competitions.length) {
      return res.status(400).json({
        success: false,
        error: "Unknown competition or sport.",
        competitions: COMPETITIONS
      });
    }

    const from = req.query.from ? Date.parse(req.query.from) : null;
    const to = req.query.to ? Date.parse(req.query.to + (String(req.query.to).length === 10 ? "T23:59:59Z" : "")) : null;
    const requestedDate = req.query.date ? String(req.query.date).slice(0, 10) : null;

    const results = await Promise.all(
      competitions.map(async competition => {
        try {
          const result = await oddsRequest(
            `/sports/${encodeURIComponent(competition.sport)}/scores`,
            { daysFrom: "3", dateFormat: "iso" }
          );

          const matches = (Array.isArray(result.data) ? result.data : [])
            .filter(event => {
              const kickoff = Date.parse(event.commence_time || "");

              if (!Number.isFinite(kickoff)) return true;
              if (requestedDate && new Date(kickoff).toISOString().slice(0, 10) !== requestedDate) return false;
              if (from !== null && Number.isFinite(from) && kickoff < from) return false;
              if (to !== null && Number.isFinite(to) && kickoff > to) return false;

              return true;
            })
            .map(event => ({
              ...event,
              competition: {
                code: competition.code,
                name: competition.name,
                country: competition.country
              }
            }));

          return {
            competition,
            matches,
            error: null,
            requestsRemaining: result.requestsRemaining
          };
        } catch (error) {
          return {
            competition,
            matches: [],
            error: error.message,
            requestsRemaining: null
          };
        }
      })
    );

    const responseMatches = results.flatMap(result => result.matches);

    responseMatches.sort((a, b) =>
      Date.parse(a.commence_time || 0) - Date.parse(b.commence_time || 0)
    );

    res.json({
      success: true,
      provider: "The Odds API",
      from: req.query.from || null,
      to: req.query.to || null,
      date: requestedDate,
      competition: requestedLeague || null,
      results: responseMatches.length,
      response: responseMatches,
      competitions: results.map(result => ({
        code: result.competition.code,
        name: result.competition.name,
        results: result.matches.length,
        error: result.error,
        requestsRemaining: result.requestsRemaining
      }))
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------
// PREDICTION SCORING
// ------------------------------------------------------

app.post("/api/score-predictions", async (req, res) => {
  try {
    if (!SCORING_SECRET) {
      return res.status(500).json({
        success: false,
        error: "SCORING_SECRET is not configured in Render."
      });
    }

    const suppliedSecret = req.get("x-scoring-secret");

    if (!suppliedSecret || suppliedSecret !== SCORING_SECRET) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized scoring request."
      });
    }

    const entries = await supabaseRequest(
      "prediction_entries?select=id,user_id,picks,point,status&status=eq.pending&limit=500"
    );

    if (!Array.isArray(entries)) {
      throw new Error("Supabase did not return a valid prediction-entry list.");
    }

    let checked = 0;
    let graded = 0;
    let pending = 0;
    let skipped = 0;
    let pointsAwarded = 0;

    const sportsChecked = new Set();
    const sportErrors = [];

    // Cache each sport's scores so the same API endpoint is not
    // called repeatedly for every prediction entry.
    const scoreCache = new Map();

    async function loadScores(sport) {
      if (scoreCache.has(sport)) return scoreCache.get(sport);

      const promise = oddsRequest(
        `/sports/${encodeURIComponent(sport)}/scores`,
        { daysFrom: "3", dateFormat: "iso" }
      )
        .then(result => {
          sportsChecked.add(sport);

          return {
            events: Array.isArray(result.data) ? result.data : [],
            error: null
          };
        })
        .catch(error => {
          sportErrors.push({
            sport,
            error: error.message
          });

          return {
            events: [],
            error: error.message
          };
        });

      scoreCache.set(sport, promise);
      return promise;
    }

    for (const entry of entries) {
      checked++;

      const picks = Array.isArray(entry.picks) ? entry.picks : [];

      if (!picks.length || picks.length > MAX_PICKS) {
        skipped++;
        continue;
      }

      let correct = 0;
      let unresolved = 0;
      let invalidSelections = 0;

      for (const pick of picks) {
        const choice = getPickChoice(pick);

        if (!choice) {
          invalidSelections++;
          unresolved++;
          continue;
        }

        const league = getPickLeague(pick);
        const sport = getSportKey(league, getPickSport(pick));

        if (!sport) {
          unresolved++;
          continue;
        }

        const { home, away } = getTeamNames(pick);

        if (!home || !away) {
          unresolved++;
          continue;
        }

        const scoreResult = await loadScores(sport);

        if (scoreResult.error) {
          unresolved++;
          continue;
        }

        const event = findMatchingEvent(pick, scoreResult.events);

        if (!event) {
          unresolved++;
          continue;
        }

        const actualOutcome = getFinalOutcome(event);

        if (!actualOutcome) {
          unresolved++;
          continue;
        }

        if (choice === actualOutcome) {
          correct++;
        }
      }

      // IMPORTANT:
      // Do not grade a slip if even one selection has no reliable
      // final result. This prevents premature or incorrect scoring.
      if (unresolved > 0 || invalidSelections > 0) {
        pending++;

        continue;
      }

      const points = correct * POINTS_PER_PICK;

      await supabaseRequest(
        `prediction_entries?id=eq.${encodeURIComponent(entry.id)}&status=eq.pending`,
        {
          method: "PATCH",
          body: {
            point: points,
            status: "graded"
          },
          prefer: "return=minimal"
        }
      );

      graded++;
      pointsAwarded += points;
    }

    // Keep this response compact for cron-job.org.
    res.json({
      success: true,
      message: "Prediction scoring check completed.",
      checked,
      graded,
      pending,
      skipped,
      pointsAwarded,
      sportsChecked: Array.from(sportsChecked),
      sportErrors
    });
  } catch (error) {
    console.error("Prediction scoring error:", error.message);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------
// LEADERBOARD
// ------------------------------------------------------

app.get("/api/leaderboard", async (req, res) => {
  try {
    const entries = await supabaseRequest(
      "prediction_entries?select=id,user_id,point,status&status=eq.graded&limit=5000"
    );

    const totals = new Map();

    for (const entry of Array.isArray(entries) ? entries : []) {
      const userId = entry.user_id;

      if (!userId) continue;

      if (!totals.has(userId)) {
        totals.set(userId, {
          user_id: userId,
          points: 0,
          entries: 0
        });
      }

      const item = totals.get(userId);
      item.points += Number(entry.point) || 0;
      item.entries++;
    }

    const leaderboard = Array.from(totals.values())
      .sort((a, b) => b.points - a.points)
      .map((item, index) => ({
        rank: index + 1,
        ...item
      }));

    // Username lookup is optional so a profiles-table issue
    // does not stop the points leaderboard from loading.
    try {
      const profiles = await supabaseRequest(
        "profiles?select=id,username"
      );

      const usernames = new Map(
        (Array.isArray(profiles) ? profiles : []).map(profile => [
          String(profile.id),
          profile.username || "Player"
        ])
      );

      leaderboard.forEach(player => {
        player.username = usernames.get(String(player.user_id)) || "Player";
      });
    } catch (profileError) {
      leaderboard.forEach(player => {
        player.username = "Player";
      });
    }

    res.json({
      success: true,
      count: leaderboard.length,
      leaderboard
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------
// ERROR HANDLING
// ------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found.",
    path: req.path
  });
});

app.listen(PORT, () => {
  console.log(`FootStats Backend running on port ${PORT}`);
  console.log(`The Odds API configured: ${Boolean(ODDS_API_KEY)}`);
  console.log(`Supabase configured: ${Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)}`);
  console.log(`Scoring secret configured: ${Boolean(SCORING_SECRET)}`);
});
