const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

app.use(express.json({ limit: "1mb" }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-scoring-secret"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Existing competitions
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
  { key: "soccer_uefa_european_championship", name: "European Championship" },
  { key: "soccer_fifa_world_cup", name: "World Cup" }
];

// Environment configuration
function getApiKey() {
  return process.env.ODDS_API_KEY;
}

function getSupabaseUrl() {
  return (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
}

function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function checkConfiguration() {
  if (!getApiKey()) {
    throw new Error("ODDS_API_KEY is not configured.");
  }
}

function checkSupabaseConfiguration() {
  if (!getSupabaseUrl() || !getSupabaseKey()) {
    throw new Error(
      "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in Render."
    );
  }
}

// The Odds API request
async function oddsRequest(path, params = {}) {
  checkConfiguration();

  const url = new URL(ODDS_API_BASE + path);

  url.searchParams.set("apiKey", getApiKey());

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url);

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    const error = new Error(
      data.message || data.error || `Odds API HTTP ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  return {
    data,
    requestsRemaining: response.headers.get("x-requests-remaining"),
    requestsUsed: response.headers.get("x-requests-used"),
    requestsLast: response.headers.get("x-requests-last")
  };
}

// Supabase REST helper
async function supabaseRequest(
  table,
  query = "",
  options = {}
) {
  checkSupabaseConfiguration();

  const url =
    `${getSupabaseUrl()}/rest/v1/${table}` +
    (query ? `?${query}` : "");

  const headers = {
    apikey: getSupabaseKey(),
    Authorization: `Bearer ${getSupabaseKey()}`,
    "Content-Type": "application/json",
    ...options.headers
  };

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const error = new Error(
      typeof data === "object"
        ? data.message || data.details || JSON.stringify(data)
        : String(data)
    );

    error.status = response.status;
    throw error;
  }

  return data;
}

// Convert errors to JSON
function sendApiError(res, error) {
  console.error("FootStats API error:", error.message);

  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Unexpected server error."
  });
}

// Find best Home/Draw/Away odds
function getBestOdds(event) {
  const best = {
    home: null,
    draw: null,
    away: null
  };

  const bestBookmakers = {
    home: null,
    draw: null,
    away: null
  };

  for (const bookmaker of event.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (market.key !== "h2h") continue;

      for (const outcome of market.outcomes || []) {
        let key = null;

        if (outcome.name === event.home_team) {
          key = "home";
        } else if (outcome.name === event.away_team) {
          key = "away";
        } else if (
          outcome.name.toLowerCase() === "draw"
        ) {
          key = "draw";
        }

        if (
          key &&
          Number.isFinite(Number(outcome.price)) &&
          (
            best[key] === null ||
            Number(outcome.price) > best[key]
          )
        ) {
          best[key] = Number(outcome.price);
          bestBookmakers[key] = bookmaker.title;
        }
      }
    }
  }

  return { odds: best, bestBookmakers };
}

// Convert an Odds API event to a fixture
function mapFixture(event) {
  const result = getBestOdds(event);

  return {
    fixture: {
      id: event.id,
      date: event.commence_time,
      status: "TIMED"
    },

    league: {
      id: event.sport_key,
      name: event.sport_title,
      country: null
    },

    teams: {
      home: {
        id: null,
        name: event.home_team,
        logo: null
      },

      away: {
        id: null,
        name: event.away_team,
        logo: null
      }
    },

    goals: {
      home: null,
      away: null
    },

    odds: result.odds,
    bestBookmakers: result.bestBookmakers,
    bookmakers: event.bookmakers || [],
    source: "The Odds API"
  };
}

// Match a submitted pick to the final match outcome
function normalizeChoice(value) {
  const choice = String(value || "").trim().toLowerCase();

  if (["home", "1", "h", "home win"].includes(choice)) {
    return "home";
  }

  if (["draw", "x", "d", "tie"].includes(choice)) {
    return "draw";
  }

  if (["away", "2", "a", "away win"].includes(choice)) {
    return "away";
  }

  return null;
}

function getFinalOutcome(event) {
  if (!event || event.completed !== true) {
    return null;
  }

  if (!Array.isArray(event.scores) || event.scores.length < 2) {
    return null;
  }

  const home = event.scores.find(
    score => score.name === event.home_team
  );

  const away = event.scores.find(
    score => score.name === event.away_team
  );

  if (!home || !away) {
    return null;
  }

  const homeGoals = Number(home.score);
  const awayGoals = Number(away.score);

  if (
    !Number.isFinite(homeGoals) ||
    !Number.isFinite(awayGoals)
  ) {
    return null;
  }

  if (homeGoals > awayGoals) {
    return "home";
  }

  if (homeGoals < awayGoals) {
    return "away";
  }

  return "draw";
}

// ------------------------------------
// BASIC ROUTES
// ------------------------------------

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
    supabaseConfigured: Boolean(
      getSupabaseUrl() && getSupabaseKey()
    ),
    scoringSecretConfigured: Boolean(
      process.env.SCORING_SECRET
    )
  });
});

app.get("/api/competitions", (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    competitionsReturned: FOOTBALL_LEAGUES.length,
    response: FOOTBALL_LEAGUES
  });
});

// ------------------------------------
// DISCOVER AVAILABLE FOOTBALL LEAGUES
// ------------------------------------

app.get("/api/odds/sports", async (req, res) => {
  try {
    const result = await oddsRequest("/sports/");

    const sports = (result.data || [])
      .filter(sport =>
        sport.key &&
        sport.key.startsWith("soccer_")
      )
      .map(sport => ({
        key: sport.key,
        name: sport.title,
        group: sport.group,
        active: sport.active
      }));

    res.json({
      success: true,
      count: sports.length,
      requestsRemaining: result.requestsRemaining,
      response: sports
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

// ------------------------------------
// ODDS ROUTE
// ------------------------------------

app.get("/api/odds", async (req, res) => {
  try {
    const sport = req.query.sport || "soccer_epl";

    if (!/^soccer_[a-z0-9_]+$/.test(sport)) {
      return res.status(400).json({
        success: false,
        message: "Invalid football sport key."
      });
    }

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/odds/`,
      {
        regions: "uk,eu",
        markets: "h2h",
        oddsFormat: "decimal",
        dateFormat: "iso"
      }
    );

    res.json({
      success: true,
      sport,
      count: result.data.length,
      requestsRemaining: result.requestsRemaining,
      response: result.data.map(mapFixture)
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

// ------------------------------------
// FIXTURES ROUTE
// ------------------------------------

app.get("/api/fixtures", async (req, res) => {
  try {
    const sport =
      req.query.sport ||
      req.query.league ||
      "soccer_epl";

    if (!/^soccer_[a-z0-9_]+$/.test(sport)) {
      return res.status(400).json({
        success: false,
        message: "Invalid football sport key."
      });
    }

    const params = {
      regions: "uk,eu",
      markets: "h2h",
      oddsFormat: "decimal",
      dateFormat: "iso"
    };

    if (req.query.date) {
      const start = new Date(`${req.query.date}T00:00:00Z`);
      const end = new Date(start.getTime() + 86400000);

      if (!Number.isFinite(start.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid date."
        });
      }

      params.commenceTimeFrom = start.toISOString();
      params.commenceTimeTo = end.toISOString();
    } else {
      if (req.query.from) {
        const from = new Date(req.query.from);

        if (!Number.isFinite(from.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid from date."
          });
        }

        params.commenceTimeFrom = from.toISOString();
      }

      if (req.query.to) {
        const to = new Date(req.query.to);

        if (!Number.isFinite(to.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid to date."
          });
        }

        params.commenceTimeTo = to.toISOString();
      }
    }

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/odds/`,
      params
    );

    let events = result.data || [];

    if (req.query.date) {
      events = events.filter(event =>
        event.commence_time &&
        event.commence_time.startsWith(req.query.date)
      );
    }

    res.json({
      success: true,
      sport,
      from: req.query.from || req.query.date || null,
      to: req.query.to || req.query.date || null,
      results: events.length,
      requestsRemaining: result.requestsRemaining,
      response: events.map(mapFixture)
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

// ------------------------------------
// SCORES ROUTE
// ------------------------------------

app.get("/api/scores", async (req, res) => {
  try {
    const sport = req.query.sport || "soccer_epl";

    if (!/^soccer_[a-z0-9_]+$/.test(sport)) {
      return res.status(400).json({
        success: false,
        message: "Invalid football sport key."
      });
    }

    const daysFrom = Math.min(
      3,
      Math.max(1, Number(req.query.daysFrom) || 3)
    );

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/scores/`,
      {
        daysFrom,
        dateFormat: "iso"
      }
    );

    res.json({
      success: true,
      sport,
      count: result.data.length,
      requestsRemaining: result.requestsRemaining,
      response: result.data
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

// ------------------------------------
// SECURE AUTOMATIC SCORING
// ------------------------------------

app.post("/api/score-predictions", async (req, res) => {
  try {
    const secret = process.env.SCORING_SECRET;

    if (!secret) {
      return res.status(503).json({
        success: false,
        message: "SCORING_SECRET is not configured."
      });
    }

    if (req.get("x-scoring-secret") !== secret) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized."
      });
    }

    checkSupabaseConfiguration();

    // Read pending prediction slips.
    const entries = await supabaseRequest(
      "prediction_entries",
      "select=id,user_id,picks,point,status&status=eq.pending&limit=500"
    );

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.json({
        success: true,
        message: "No pending prediction slips found.",
        graded: 0
      });
    }

    // Discover which sports are needed.
    // Prefer the sport key stored with a pick, if available.
    const sportsNeeded = new Set();

    for (const entry of entries) {
      const picks = Array.isArray(entry.picks)
        ? entry.picks
        : [];

      for (const pick of picks) {
        const sport =
          pick.sport_key ||
          pick.sport ||
          (
            typeof pick.league === "string" &&
            pick.league.startsWith("soccer_")
              ? pick.league
              : null
          );

        if (sport && /^soccer_[a-z0-9_]+$/.test(sport)) {
          sportsNeeded.add(sport);
        }
      }
    }

    // Existing slips may store only a league title.
    // In that case, try the configured competitions.
    if (sportsNeeded.size === 0) {
      for (const league of FOOTBALL_LEAGUES) {
        sportsNeeded.add(league.key);
      }
    }

    const outcomesById = new Map();
    const scoreErrors = [];

    // Fetch recent completed scores for relevant sports.
    // Limit requests to the sports identified above.
    for (const sport of sportsNeeded) {
      try {
        const result = await oddsRequest(
          `/sports/${encodeURIComponent(sport)}/scores/`,
          {
            daysFrom: 3,
            dateFormat: "iso"
          }
        );

        for (const event of result.data || []) {
          const outcome = getFinalOutcome(event);

          if (outcome) {
            outcomesById.set(String(event.id), outcome);
          }
        }
      } catch (error) {
        scoreErrors.push({
          sport,
          message: error.message
        });
      }
    }

    let graded = 0;
    let waiting = 0;
    let skipped = 0;
    let pointsAwarded = 0;

    for (const entry of entries) {
      const picks = Array.isArray(entry.picks)
        ? entry.picks
        : [];

      if (picks.length === 0) {
        skipped++;
        continue;
      }

      let allResultsAvailable = true;
      let slipPoints = 0;

      for (const pick of picks) {
        const fixtureId =
          pick.fixture_id ||
          pick.fixtureId ||
          pick.id;

        const outcome = outcomesById.get(String(fixtureId));

        if (!fixtureId || !outcome) {
          allResultsAvailable = false;
          break;
        }

        const selected = normalizeChoice(pick.choice);

        if (!selected) {
          allResultsAvailable = false;
          break;
        }

        // Three points per correct Home/Draw/Away prediction.
        if (selected === outcome) {
          slipPoints += 3;
        }
      }

      // Never partially grade a slip.
      if (!allResultsAvailable) {
        waiting++;
        continue;
      }

      // Update only the backend-controlled score and status.
      await supabaseRequest(
        "prediction_entries",
        `id=eq.${encodeURIComponent(entry.id)}&status=eq.pending`,
        {
          method: "PATCH",
          headers: {
            Prefer: "return=representation"
          },
          body: {
            point: slipPoints,
            status: "graded"
          }
        }
      );

      graded++;
      pointsAwarded += slipPoints;
    }

    res.json({
      success: true,
      message: "Scoring process finished.",
      slipsFound: entries.length,
      graded,
      waitingForResults: waiting,
      skipped,
      pointsAwarded,
      sportsChecked: [...sportsNeeded],
      scoreErrors
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

// ------------------------------------
// LEADERBOARD
// ------------------------------------

app.get("/api/leaderboard", async (req, res) => {
  try {
    checkSupabaseConfiguration();

    const [profiles, entries] = await Promise.all([
      supabaseRequest(
        "profiles",
        "select=user_id,username"
      ),

      supabaseRequest(
        "prediction_entries",
        "select=user_id,point,status&status=eq.graded&limit=10000"
      )
    ]);

    const totals = new Map();

    for (const profile of profiles || []) {
      totals.set(String(profile.user_id), {
        user_id: profile.user_id,
        username: profile.username || "Player",
        points: 0,
        gradedSlips: 0
      });
    }

    for (const entry of entries || []) {
      const userId = String(entry.user_id);

      if (!totals.has(userId)) {
        totals.set(userId, {
          user_id: entry.user_id,
          username: "Player",
          points: 0,
          gradedSlips: 0
        });
      }

      const player = totals.get(userId);

      player.points += Math.max(0, Number(entry.point) || 0);
      player.gradedSlips++;
    }

    const leaderboard = [...totals.values()]
      .sort((a, b) =>
        b.points - a.points ||
        b.gradedSlips - a.gradedSlips ||
        a.username.localeCompare(b.username)
      )
      .slice(0, 100)
      .map((player, index) => ({
        rank: index + 1,
        username: player.username,
        points: player.points,
        gradedSlips: player.gradedSlips
      }));

    res.json({
      success: true,
      count: leaderboard.length,
      response: leaderboard
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

// ------------------------------------
// UNKNOWN ROUTES
// ------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found."
  });
});

// ------------------------------------
// START SERVER
// ------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FootStats backend listening on port ${PORT}`);
}); 
