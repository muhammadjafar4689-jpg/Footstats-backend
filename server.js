const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-scoring-secret"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ========================================
// FOOTBALL LEAGUES
// ========================================

const FOOTBALL_LEAGUES = [
  { key: "soccer_epl", name: "Premier League" },
  { key: "soccer_england_efl_champ", name: "Championship" },
  { key: "soccer_spain_la_liga", name: "La Liga" },
  { key: "soccer_germany_bundesliga", name: "Bundesliga" },
  { key: "soccer_italy_serie_a", name: "Serie A" },
  { key: "soccer_france_ligue_one", name: "Ligue 1" },
  { key: "soccer_portugal_primeira_liga", name: "Primeira Liga" },
  { key: "soccer_netherlands_eredivisie", name: "Eredivisie" },
  { key: "soccer_brazil_campeonato", name: "Brazil Serie A" },
  { key: "soccer_uefa_champs_league", name: "Champions League" },
  { key: "soccer_uefa_europa_league", name: "Europa League" },
  {
    key: "soccer_uefa_european_championship",
    name: "European Championship"
  },
  { key: "soccer_fifa_world_cup", name: "World Cup" }
];

// ========================================
// ENVIRONMENT VARIABLES
// ========================================

function getApiKey() {
  return process.env.ODDS_API_KEY || "";
}

function getSupabaseUrl() {
  return (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
}

function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function getScoringSecret() {
  return process.env.SCORING_SECRET || "";
}

function hasSupabaseConfig() {
  return Boolean(getSupabaseUrl() && getSupabaseKey());
}

// ========================================
// GENERAL HELPERS
// ========================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sendApiError(res, status, message, details) {
  const response = {
    success: false,
    error: message
  };

  if (details) {
    response.details = details;
  }

  return res.status(status).json(response);
}

// ========================================
// THE ODDS API REQUEST
// ========================================

async function oddsRequest(path, params = {}) {
  const apiKey = getApiKey();

  if (!apiKey) {
    const error = new Error("ODDS_API_KEY is not configured.");
    error.status = 500;
    throw error;
  }

  const url = new URL(
    `https://api.the-odds-api.com/v4${path}`
  );

  url.searchParams.set("apiKey", apiKey);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(
      data && data.message
        ? data.message
        : `The Odds API returned HTTP ${response.status}.`
    );

    error.status = response.status;
    throw error;
  }

  return {
    data,
    requestsRemaining: response.headers.get(
      "x-requests-remaining"
    ),
    requestsUsed: response.headers.get(
      "x-requests-used"
    )
  };
}

// ========================================
// SUPABASE REST REQUEST
// ========================================

async function supabaseRequest(table, query = "", options = {}) {
  if (!hasSupabaseConfig()) {
    const error = new Error(
      "Supabase environment variables are not configured."
    );

    error.status = 500;
    throw error;
  }

  const baseUrl = getSupabaseUrl();
  const serviceKey = getSupabaseKey();

  const url = new URL(
    `${baseUrl}/rest/v1/${table}`
  );

  if (query) {
    const queryString = query.startsWith("?")
      ? query.slice(1)
      : query;

    const searchParams = new URLSearchParams(queryString);

    for (const [key, value] of searchParams.entries()) {
      url.searchParams.append(key, value);
    }
  }

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json"
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (options.prefer) {
    headers.Prefer = options.prefer;
  }

  const response = await fetch(url.toString(), {
    method: options.method || "GET",
    headers,
    body:
      options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(
      data && data.message
        ? data.message
        : `Supabase returned HTTP ${response.status}.`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

// ========================================
// LEAGUE NAME TO ODDS API SPORT KEY
// ========================================

function getSportKey(league, explicitSportKey) {
  if (
    explicitSportKey &&
    FOOTBALL_LEAGUES.some(item => item.key === explicitSportKey)
  ) {
    return explicitSportKey;
  }

  const name = normalizeText(league);

  const aliases = [
    {
      key: "soccer_epl",
      names: [
        "premier league",
        "english premier league",
        "epl"
      ]
    },
    {
      key: "soccer_england_efl_champ",
      names: [
        "championship",
        "english championship",
        "efl championship"
      ]
    },
    {
      key: "soccer_spain_la_liga",
      names: [
        "la liga",
        "laliga",
        "spanish la liga"
      ]
    },
    {
      key: "soccer_germany_bundesliga",
      names: [
        "bundesliga",
        "german bundesliga"
      ]
    },
    {
      key: "soccer_italy_serie_a",
      names: [
        "serie a",
        "italian serie a",
        "italy serie a"
      ]
    },
    {
      key: "soccer_france_ligue_one",
      names: [
        "ligue 1",
        "ligue one",
        "french ligue 1"
      ]
    },
    {
      key: "soccer_portugal_primeira_liga",
      names: [
        "primeira liga",
        "portugal first league",
        "portuguese primeira liga",
        "liga portugal"
      ]
    },
    {
      key: "soccer_netherlands_eredivisie",
      names: [
        "eredivisie",
        "netherlands first league",
        "dutch eredivisie"
      ]
    },
    {
      key: "soccer_brazil_campeonato",
      names: [
        "brazil serie a",
        "brazilian serie a",
        "brasileirao",
        "campeonato brasileiro serie a",
        "campeonato brasileiro serie a",
        "brasileirao serie a"
      ]
    },
    {
      key: "soccer_uefa_champs_league",
      names: [
        "champions league",
        "uefa champions league",
        "ucl"
      ]
    },
    {
      key: "soccer_uefa_europa_league",
      names: [
        "europa league",
        "uefa europa league"
      ]
    },
    {
      key: "soccer_uefa_european_championship",
      names: [
        "european championship",
        "euro",
        "uefa euro"
      ]
    },
    {
      key: "soccer_fifa_world_cup",
      names: [
        "world cup",
        "fifa world cup"
      ]
    }
  ];

  for (const group of aliases) {
    if (group.names.some(alias => normalizeText(alias) === name)) {
      return group.key;
    }
  }

  // Unknown league: don't guess.
  return null;
}

// ========================================
// TEAM NAME NORMALIZATION
// ========================================

const TEAM_ALIASES = {
  "atletico mineiro": [
    "ca mineiro",
    "atletico mineiro",
    "atletico mg",
    "atletico mineiro mg"
  ],

  "red bull bragantino": [
    "rb bragantino",
    "bragantino",
    "bragantino sp",
    "red bull bragantino"
  ],

  "athletico paranaense": [
    "athletico pr",
    "atletico paranaense",
    "athletico paranaense"
  ],

  "gremio": [
    "gremio",
    "gremio fbpa"
  ],

  "internacional": [
    "internacional",
    "sc internacional",
    "internacional rs"
  ],

  "palmeiras": [
    "palmeiras",
    "se palmeiras"
  ],

  "flamengo": [
    "flamengo",
    "cr flamengo"
  ],

  "corinthians": [
    "corinthians",
    "sc corinthians"
  ],

  "sao paulo": [
    "sao paulo",
    "sao paulo fc"
  ],

  "vasco da gama": [
    "vasco da gama",
    "cr vasco da gama",
    "vasco"
  ],

  "cruzeiro": [
    "cruzeiro",
    "cruzeiro ec"
  ],

  "botafogo": [
    "botafogo",
    "botafogo fr"
  ],

  "santos": [
    "santos",
    "santos fc"
  ],

  "bahia": [
    "bahia",
    "ec bahia"
  ],

  "fortaleza": [
    "fortaleza",
    "fortaleza ec"
  ],

  "fluminense": [
    "fluminense",
    "fluminense fc"
  ]
};

const TEAM_ALIAS_LOOKUP = {};

for (const [canonical, names] of Object.entries(TEAM_ALIASES)) {
  TEAM_ALIAS_LOOKUP[normalizeText(canonical)] = canonical;

  for (const name of names) {
    TEAM_ALIAS_LOOKUP[normalizeText(name)] = canonical;
  }
}

function canonicalTeamName(name) {
  const normalized = normalizeText(name);

  if (TEAM_ALIAS_LOOKUP[normalized]) {
    return TEAM_ALIAS_LOOKUP[normalized];
  }

  // Remove common club prefixes and suffixes.
  return normalized
    .replace(
      /^(fc|cf|sc|ac|as|cd|rc|rcd|real|club|sporting|ca|cr|ec|se)\s+/,
      ""
    )
    .replace(
      /\s+(fc|cf|sc|ac|as|cd|sa|afc|club|football club|ec|mg|sp|rs|pr)$/,
      ""
    )
    .trim();
}

function teamsMatch(pickName, eventName) {
  const a = canonicalTeamName(pickName);
  const b = canonicalTeamName(eventName);

  if (!a || !b) {
    return false;
  }

  if (a === b) {
    return true;
  }

  // Allow a strong whole-name containment match only.
  // This helps with provider naming differences without
  // matching teams merely because they share one word.
  if (a.length >= 8 && b.length >= 8) {
    if (a.startsWith(b + " ") || b.startsWith(a + " ")) {
      return true;
    }
  }

  return false;
}

// ========================================
// FIXTURE AND ODDS HELPERS
// ========================================

function getBestOdds(event) {
  const markets = event.bookmakers || [];

  const result = {
    home: null,
    draw: null,
    away: null
  };

  for (const bookmaker of markets) {
    for (const market of bookmaker.markets || []) {
      if (market.key !== "h2h") continue;

      for (const outcome of market.outcomes || []) {
        if (outcome.name === event.home_team) {
          result.home = outcome.price;
        } else if (outcome.name === event.away_team) {
          result.away = outcome.price;
        } else if (
          normalizeText(outcome.name) === "draw"
        ) {
          result.draw = outcome.price;
        }
      }

      if (result.home !== null && result.away !== null) {
        return result;
      }
    }
  }

  return result;
}

function mapFixture(event, leagueName) {
  return {
    id: event.id,
    fixture_id: event.id,
    sport_key: event.sport_key || null,
    league: leagueName || event.sport_title || "",
    home: event.home_team,
    away: event.away_team,
    home_team: event.home_team,
    away_team: event.away_team,
    kickoff: event.commence_time,
    commence_time: event.commence_time,
    completed: Boolean(event.completed),
    scores: event.scores || null,
    odds: getBestOdds(event)
  };
}

function getFinalOutcome(event) {
  if (!event || event.completed !== true) {
    return null;
  }

  if (!Array.isArray(event.scores)) {
    return null;
  }

  let homeScore = null;
  let awayScore = null;

  for (const score of event.scores) {
    if (!score || score.score === undefined) continue;

    if (score.name === event.home_team) {
      homeScore = Number(score.score);
    }

    if (score.name === event.away_team) {
      awayScore = Number(score.score);
    }
  }

  if (
    !Number.isFinite(homeScore) ||
    !Number.isFinite(awayScore)
  ) {
    return null;
  }

  if (homeScore > awayScore) return "home";
  if (homeScore < awayScore) return "away";

  return "draw";
}

function normalizeChoice(choice) {
  const value = normalizeText(choice);

  if (
    ["h", "1", "home", "home win", "home team"].includes(value)
  ) {
    return "home";
  }

  if (
    ["d", "x", "draw", "tie"].includes(value)
  ) {
    return "draw";
  }

  if (
    ["a", "2", "away", "away win", "away team"].includes(value)
  ) {
    return "away";
  }

  return null;
}

// ========================================
// MATCH A PICK TO AN ODDS API EVENT
// ========================================

function getPickKickoff(pick) {
  const value =
    pick.kickoff ||
    pick.commence_time ||
    pick.date ||
    pick.match_date;

  if (!value) return null;

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : null;
}

function getEventKickoff(event) {
  const timestamp = Date.parse(event.commence_time || "");

  return Number.isFinite(timestamp) ? timestamp : null;
}

function findMatchingEvent(pick, events) {
  const home = pick.home || pick.home_team;
  const away = pick.away || pick.away_team;

  if (!home || !away) {
    return null;
  }

  const pickTime = getPickKickoff(pick);

  const candidates = [];

  for (const event of events) {
    if (!event.completed) continue;

    const sameHome = teamsMatch(home, event.home_team);
    const sameAway = teamsMatch(away, event.away_team);

    // Do not reverse home and away.
    if (!sameHome || !sameAway) continue;

    const eventTime = getEventKickoff(event);

    // Without a kickoff time, don't risk grading the wrong match.
    if (pickTime === null || eventTime === null) {
      continue;
    }

    const difference = Math.abs(pickTime - eventTime);

    // Allow up to six hours of provider kickoff-time difference.
    if (difference > 6 * 60 * 60 * 1000) {
      continue;
    }

    candidates.push({
      event,
      difference
    });
  }

  candidates.sort((a, b) => a.difference - b.difference);

  if (candidates.length === 0) {
    return null;
  }

  // If two candidates are almost equally close, avoid
  // grading until the match can be identified more reliably.
  if (
    candidates.length > 1 &&
    Math.abs(
      candidates[0].difference - candidates[1].difference
    ) < 60 * 60 * 1000
  ) {
    return null;
  }

  return candidates[0].event;
}

// ========================================
// BASIC ROUTES
// ========================================

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
      "/api/odds?sport=soccer_epl",
      "/api/fixtures?sport=soccer_epl",
      "/api/scores?sport=soccer_epl",
      "/api/score-predictions",
      "/api/leaderboard"
    ]
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "online"
  });
});

app.get("/api/diagnostic", (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    apiKeyConfigured: Boolean(getApiKey()),
    supabaseConfigured: hasSupabaseConfig(),
    scoringSecretConfigured: Boolean(getScoringSecret())
  });
});

app.get("/api/competitions", (req, res) => {
  res.json({
    success: true,
    count: FOOTBALL_LEAGUES.length,
    response: FOOTBALL_LEAGUES
  });
});

// ========================================
// AVAILABLE SPORTS FROM THE ODDS API
// ========================================

app.get("/api/odds/sports", async (req, res) => {
  try {
    const result = await oddsRequest("/sports/");

    res.json({
      success: true,
      response: result.data,
      requestsRemaining: result.requestsRemaining
    });
  } catch (error) {
    sendApiError(
      res,
      error.status || 500,
      "Could not load available sports.",
      error.message
    );
  }
});

// ========================================
// ODDS ROUTE
// ========================================

app.get("/api/odds", async (req, res) => {
  try {
    const sport = req.query.sport || "soccer_epl";

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/odds/`,
      {
        regions: req.query.regions || "uk",
        markets: req.query.markets || "h2h",
        oddsFormat: "decimal"
      }
    );

    res.json({
      success: true,
      sport,
      count: Array.isArray(result.data)
        ? result.data.length
        : 0,
      requestsRemaining: result.requestsRemaining,
      response: result.data
    });
  } catch (error) {
    sendApiError(
      res,
      error.status || 500,
      "Could not load odds.",
      error.message
    );
  }
});

// ========================================
// FIXTURES ROUTE
// ========================================

app.get("/api/fixtures", async (req, res) => {
  try {
    const sport = req.query.sport || "soccer_epl";

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/odds/`,
      {
        regions: req.query.regions || "uk",
        markets: req.query.markets || "h2h",
        oddsFormat: "decimal"
      }
    );

    const fixtures = (Array.isArray(result.data)
      ? result.data
      : []
    ).map(event => mapFixture(event, event.sport_title));

    let filtered = fixtures;

    if (req.query.date) {
      const targetDate = String(req.query.date).slice(0, 10);

      filtered = filtered.filter(item =>
        String(item.kickoff || "").startsWith(targetDate)
      );
    }

    if (req.query.from) {
      filtered = filtered.filter(item =>
        String(item.kickoff || "").slice(0, 10) >= req.query.from
      );
    }

    if (req.query.to) {
      filtered = filtered.filter(item =>
        String(item.kickoff || "").slice(0, 10) <= req.query.to
      );
    }

    res.json({
      success: true,
      sport,
      count: filtered.length,
      requestsRemaining: result.requestsRemaining,
      response: filtered
    });
  } catch (error) {
    sendApiError(
      res,
      error.status || 500,
      "Could not load fixtures.",
      error.message
    );
  }
});

// ========================================
// COMPLETED SCORES ROUTE
// ========================================

app.get("/api/scores", async (req, res) => {
  try {
    const sport = req.query.sport || "soccer_epl";

    let daysFrom = Number(req.query.daysFrom || 3);

    if (!Number.isFinite(daysFrom)) {
      daysFrom = 3;
    }

    daysFrom = Math.max(1, Math.min(3, daysFrom));

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/scores/`,
      {
        daysFrom
      }
    );

    res.json({
      success: true,
      sport,
      count: Array.isArray(result.data)
        ? result.data.length
        : 0,
      requestsRemaining: result.requestsRemaining,
      response: result.data
    });
  } catch (error) {
    sendApiError(
      res,
      error.status || 500,
      "Could not load completed scores.",
      error.message
    );
  }
});

// ========================================
// AUTOMATIC PREDICTION SCORING
// ========================================

app.post("/api/score-predictions", async (req, res) => {
  try {
    const secret = getScoringSecret();

    if (!secret) {
      return sendApiError(
        res,
        500,
        "SCORING_SECRET is not configured in Render."
      );
    }

    if (req.get("x-scoring-secret") !== secret) {
      return sendApiError(
        res,
        401,
        "Invalid scoring authorization."
      );
    }

    if (!hasSupabaseConfig()) {
      return sendApiError(
        res,
        500,
        "Supabase is not configured."
      );
    }

    // Only fetch slips that have not already been graded.
    const entries = await supabaseRequest(
      "prediction_entries",
      "select=id,user_id,picks,point,status&status=eq.pending&limit=500"
    );

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.json({
        success: true,
        message: "No pending prediction slips.",
        checked: 0,
        graded: 0
      });
    }

    // Identify which sports are needed for pending slips.
    const requiredSports = new Set();

    for (const entry of entries) {
      const picks = Array.isArray(entry.picks)
        ? entry.picks
        : [];

      for (const pick of picks) {
        const sportKey = getSportKey(
          pick.league,
          pick.sport_key || pick.sport
        );

        if (sportKey) {
          requiredSports.add(sportKey);
        }
      }
    }

    // If no league could be identified, do not fetch all
    // competitions blindly or grade using uncertain data.
    if (requiredSports.size === 0) {
      return res.json({
        success: true,
        message:
          "No recognized leagues found in pending slips. Check the league names stored in picks.",
        checked: entries.length,
        graded: 0,
        pending: entries.length
      });
    }

    // Fetch scores once per required sport.
    const eventsBySport = new Map();
    const sportErrors = [];

    for (const sportKey of requiredSports) {
      try {
        const result = await oddsRequest(
          `/sports/${encodeURIComponent(sportKey)}/scores/`,
          {
            daysFrom: 3
          }
        );

        eventsBySport.set(
          sportKey,
          Array.isArray(result.data) ? result.data : []
        );
      } catch (error) {
        sportErrors.push({
          sport: sportKey,
          error: error.message
        });
      }

      // Small delay between requests.
      await sleep(150);
    }

    let graded = 0;
    let pending = 0;
    let skipped = 0;
    let pointsAwarded = 0;

    const results = [];

    for (const entry of entries) {
      const picks = Array.isArray(entry.picks)
        ? entry.picks
        : [];

      if (picks.length === 0) {
        skipped++;

        results.push({
          entryId: entry.id,
          status: "skipped",
          reason: "No picks found."
        });

        continue;
      }

      let correct = 0;
      let unresolved = 0;
      let invalid = 0;

      for (const pick of picks) {
        const sportKey = getSportKey(
          pick.league,
          pick.sport_key || pick.sport
        );

        const choice = normalizeChoice(
          pick.choice || pick.prediction || pick.selection
        );

        if (!sportKey || !choice) {
          invalid++;
          unresolved++;
          continue;
        }

        const events = eventsBySport.get(sportKey);

        if (!events) {
          unresolved++;
          continue;
        }

        const event = findMatchingEvent(pick, events);

        if (!event) {
          unresolved++;
          continue;
        }

        const outcome = getFinalOutcome(event);

        if (!outcome) {
          unresolved++;
          continue;
        }

        if (choice === outcome) {
          correct++;
        }
      }

      // Never grade a slip while one or more selections
      // have no reliably matched final result.
      if (unresolved > 0) {
        pending++;

        results.push({
          entryId: entry.id,
          status: "pending",
          correctSoFar: correct,
          totalPicks: picks.length,
          unresolved,
          invalidSelections: invalid,
          reason:
            "Some matches have no reliably matched final result yet."
        });

        continue;
      }

      // Three points for each correct selection.
      const points = correct * 3;

      // Update only if this entry is still pending.
      // This helps prevent repeated scoring.
      const updated = await supabaseRequest(
        "prediction_entries",
        `id=eq.${encodeURIComponent(entry.id)}&status=eq.pending`,
        {
          method: "PATCH",
          prefer: "return=representation",
          body: {
            point: points,
            status: "graded"
          }
        }
      );

      if (Array.isArray(updated) && updated.length > 0) {
        graded++;
        pointsAwarded += points;

        results.push({
          entryId: entry.id,
          status: "graded",
          correct,
          totalPicks: picks.length,
          points
        });
      } else {
        results.push({
          entryId: entry.id,
          status: "not_updated",
          reason:
            "The slip was not updated because it may no longer be pending."
        });
      }
    }

    res.json({
      success: true,
      message: "Prediction scoring check completed.",
      checked: entries.length,
      graded,
      pending,
      skipped,
      pointsAwarded,
      sportsChecked: Array.from(requiredSports),
      sportErrors,
      results
    });
  } catch (error) {
    console.error("Scoring error:", error);

    sendApiError(
      res,
      error.status || 500,
      "Could not score predictions.",
      error.details || error.message
    );
  }
});

// ========================================
// LEADERBOARD
// ========================================

app.get("/api/leaderboard", async (req, res) => {
  try {
    const entries = await supabaseRequest(
      "prediction_entries",
      "select=user_id,point,status&status=eq.graded&limit=5000"
    );

    const profiles = await supabaseRequest(
      "profiles",
      "select=user_id,username&limit=5000"
    );

    const totals = new Map();

    for (const entry of entries || []) {
      if (!entry.user_id) continue;

      const current = totals.get(entry.user_id) || {
        user_id: entry.user_id,
        points: 0,
        gradedSlips: 0
      };

      current.points += Number(entry.point || 0);
      current.gradedSlips += 1;

      totals.set(entry.user_id, current);
    }

    const usernames = new Map();

    for (const profile of profiles || []) {
      usernames.set(
        profile.user_id,
        profile.username || "Player"
      );
    }

    const leaderboard = Array.from(totals.values())
      .map(item => ({
        username: usernames.get(item.user_id) || "Player",
        points: item.points,
        gradedSlips: item.gradedSlips
      }))
      .sort((a, b) => b.points - a.points)
      .map((item, index) => ({
        rank: index + 1,
        ...item
      }));

    res.json({
      success: true,
      count: leaderboard.length,
      response: leaderboard
    });
  } catch (error) {
    console.error("Leaderboard error:", error);

    sendApiError(
      res,
      error.status || 500,
      "Could not load leaderboard.",
      error.details || error.message
    );
  }
});

// ========================================
// UNKNOWN ROUTES
// ========================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found.",
    path: req.path
  });
});

// ========================================
// START SERVER
// ========================================

app.listen(PORT, () => {
  console.log(`FootStats Backend running on port ${PORT}`);
}); 
