require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCORING_SECRET = process.env.SCORING_SECRET;

const ODDS_BASE = "https://api.the-odds-api.com/v4";
const TABLE = "prediction_entries";
const TZ = "Africa/Lagos";
const POINTS_MULTIPLIER = 100;

const FIXTURES_CACHE_MS = 60 * 1000;
const FIXTURES_CONCURRENCY = 5;

let fixturesCache = {
  date: "",
  expiresAt: 0,
  data: null
};

/* -------------------------------------------------------
   50 COMPETITIONS

   These are the competition keys returned by your
   /api/competitions endpoint.

   The Odds API can change availability by season.
   A listed competition may temporarily have no fixtures.
------------------------------------------------------- */

const COMPETITIONS = [
  { key: "soccer_argentina_primera_division", name: "Primera División - Argentina" },
  { key: "soccer_australia_aleague", name: "A-League" },
  { key: "soccer_austria_bundesliga", name: "Austrian Football Bundesliga" },
  { key: "soccer_belgium_first_div", name: "Belgium First Div" },
  { key: "soccer_brazil_campeonato", name: "Brazil Série A" },
  { key: "soccer_brazil_serie_b", name: "Brazil Série B" },
  { key: "soccer_chile_campeonato", name: "Primera División - Chile" },
  { key: "soccer_china_superleague", name: "Super League - China" },
  { key: "soccer_conmebol_copa_libertadores", name: "Copa Libertadores" },
  { key: "soccer_conmebol_copa_sudamericana", name: "Copa Sudamericana" },
  { key: "soccer_denmark_superliga", name: "Denmark Superliga" },
  { key: "soccer_efl_champ", name: "Championship" },
  { key: "soccer_england_efl_cup", name: "EFL Cup" },
  { key: "soccer_england_league1", name: "League 1" },
  { key: "soccer_england_league2", name: "League 2" },
  { key: "soccer_epl", name: "EPL" },
  { key: "soccer_finland_veikkausliiga", name: "Veikkausliiga - Finland" },
  { key: "soccer_france_ligue_one", name: "Ligue 1 - France" },
  { key: "soccer_france_ligue_two", name: "Ligue 2 - France" },
  { key: "soccer_germany_bundesliga", name: "Bundesliga - Germany" },
  { key: "soccer_germany_bundesliga2", name: "Bundesliga 2 - Germany" },
  { key: "soccer_germany_bundesliga_women", name: "Frauen-Bundesliga" },
  { key: "soccer_germany_liga3", name: "3. Liga - Germany" },
  { key: "soccer_greece_super_league", name: "Super League - Greece" },
  { key: "soccer_italy_serie_a", name: "Serie A - Italy" },
  { key: "soccer_italy_serie_b", name: "Serie B - Italy" },
  { key: "soccer_japan_j_league", name: "J League" },
  { key: "soccer_korea_kleague1", name: "K League 1" },
  { key: "soccer_league_of_ireland", name: "League of Ireland" },
  { key: "soccer_mexico_ligamx", name: "Liga MX" },
  { key: "soccer_netherlands_eredivisie", name: "Dutch Eredivisie" },
  { key: "soccer_norway_eliteserien", name: "Eliteserien - Norway" },
  { key: "soccer_poland_ekstraklasa", name: "Ekstraklasa - Poland" },
  { key: "soccer_portugal_primeira_liga", name: "Primeira Liga - Portugal" },
  { key: "soccer_russia_premier_league", name: "Premier League - Russia" },
  { key: "soccer_saudi_arabia_pro_league", name: "Saudi Pro League" },
  { key: "soccer_spain_copa_del_rey", name: "Copa del Rey" },
  { key: "soccer_spain_la_liga", name: "La Liga - Spain" },
  { key: "soccer_spain_segunda_division", name: "La Liga 2 - Spain" },
  { key: "soccer_spl", name: "Premiership - Scotland" },
  { key: "soccer_sweden_allsvenskan", name: "Allsvenskan - Sweden" },
  { key: "soccer_sweden_superettan", name: "Superettan - Sweden" },
  { key: "soccer_switzerland_superleague", name: "Swiss Superleague" },
  { key: "soccer_turkey_super_league", name: "Turkey Super League" },
  { key: "soccer_uefa_champs_league", name: "UEFA Champions League" },
  { key: "soccer_uefa_champs_league_women", name: "UEFA Champions League Women" },
  { key: "soccer_uefa_europa_conference_league", name: "UEFA Europa Conference League" },
  { key: "soccer_uefa_europa_league", name: "UEFA Europa League" },
  { key: "soccer_uefa_nations_league", name: "UEFA Nations League" },
  { key: "soccer_usa_mls", name: "MLS" }
];

/* -------------------------------------------------------
   BASIC HELPERS
------------------------------------------------------- */

function todayNigeria() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const p = {};

  for (const item of parts) {
    if (item.type !== "literal") {
      p[item.type] = item.value;
    }
  }

  return `${p.year}-${p.month}-${p.day}`;
}

function dateInNigeria(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const p = {};

  for (const item of parts) {
    if (item.type !== "literal") {
      p[item.type] = item.value;
    }
  }

  return `${p.year}-${p.month}-${p.day}`;
}

function isTodayNigeria(value) {
  return dateInNigeria(value) === todayNigeria();
}

function getNigeriaDayBounds() {
  const date = todayNigeria();

  const start = new Date(`${date}T00:00:00+01:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return {
    date,
    from: start.toISOString(),
    to: end.toISOString()
  };
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    error: message,
    ...extra
  });
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getTeamNames(pick) {
  return {
    home: pick.home || pick.home_team || "",
    away: pick.away || pick.away_team || ""
  };
}

function getEventId(pick) {
  return String(
    pick.event_id ||
    pick.odds_event_id ||
    pick.oddsApiEventId ||
    ""
  ).trim();
}

function getSportKey(pick) {
  return String(
    pick.sport_key ||
    pick.sportKey ||
    ""
  ).trim();
}

function getMarketKey(pick) {
  return String(
    pick.market_key ||
    pick.marketKey ||
    "h2h"
  ).trim().toLowerCase();
}

function getSelection(pick) {
  return String(
    pick.outcome ||
    pick.selection ||
    pick.choice ||
    ""
  ).trim();
}

function getSavedOdds(pick) {
  const odds = safeNumber(
    pick.odds ??
    pick.decimal_odds ??
    pick.price
  );

  return odds !== null && odds > 1 ? odds : null;
}

/* -------------------------------------------------------
   ODDS API HELPERS
------------------------------------------------------- */

async function oddsRequest(path, params = {}) {
  if (!ODDS_API_KEY) {
    throw new Error(
      "ODDS_API_KEY is missing in Render environment variables."
    );
  }

  const url = new URL(`${ODDS_BASE}${path}`);

  url.searchParams.set("apiKey", ODDS_API_KEY);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString());
  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  const quota = {
    remaining: response.headers.get("x-requests-remaining"),
    used: response.headers.get("x-requests-used"),
    last: response.headers.get("x-requests-last")
  };

  if (!response.ok) {
    const message =
      data.message ||
      data.error ||
      `The Odds API returned HTTP ${response.status}`;

    const error = new Error(message);

    error.status = response.status;
    error.quota = quota;

    throw error;
  }

  return {
    data,
    ...quota
  };
}

function sendApiError(res, error) {
  return sendError(res, error.status || 502, error.message, {
    ...(error.quota ? { quota: error.quota } : {})
  });
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render."
    );
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const response = await fetch(url, {
    method: options.method || "GET",

    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {})
    },

    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}

/* -------------------------------------------------------
   MARKET REFERENCE CATALOGUE
------------------------------------------------------- */

const MARKET_CATALOG = [
  { key: "h2h", name: "Head to Head / Match Winner", endpoint: "featured" },
  { key: "h2h_3_way", name: "Home / Draw / Away", endpoint: "event" },
  { key: "h2h_lay", name: "Lay Match Winner", endpoint: "event" },
  { key: "draw_no_bet", name: "Draw No Bet", endpoint: "event" },
  { key: "double_chance", name: "Double Chance", endpoint: "event" },
  { key: "double_chance_h1", name: "First-Half Double Chance", endpoint: "event" },
  { key: "to_qualify", name: "To Qualify", endpoint: "event" },
  { key: "halftime_fulltime", name: "Half Time / Full Time", endpoint: "event" },
  { key: "totals", name: "Over / Under Goals", endpoint: "featured" },
  { key: "alternate_totals", name: "Alternative Goal Totals", endpoint: "event" },
  { key: "team_totals", name: "Team Total Goals", endpoint: "event" },
  { key: "alternate_team_totals", name: "Alternative Team Totals", endpoint: "event" },
  { key: "btts", name: "Both Teams to Score", endpoint: "event" },
  { key: "btts_h1", name: "First-Half Both Teams to Score", endpoint: "event" },
  { key: "correct_score", name: "Correct Score", endpoint: "event" },
  { key: "correct_score_h1", name: "First-Half Correct Score", endpoint: "event" },
  { key: "spreads", name: "Asian Handicap / Spreads", endpoint: "featured" },
  { key: "alternate_spreads", name: "Alternative Handicaps", endpoint: "event" },
  { key: "alternate_spreads_corners", name: "Corner Handicap", endpoint: "event" },
  { key: "alternate_totals_corners", name: "Total Corners", endpoint: "event" },
  { key: "alternate_team_totals_corners", name: "Team Total Corners", endpoint: "event" },
  { key: "corners_1x2", name: "Corner Result", endpoint: "event" },
  { key: "alternate_spreads_cards", name: "Card Handicap", endpoint: "event" },
  { key: "alternate_totals_cards", name: "Total Cards", endpoint: "event" },
  { key: "player_shots", name: "Player Shots", endpoint: "event" },
  { key: "player_shots_alternate", name: "Alternative Player Shots", endpoint: "event" },
  { key: "player_shots_on_target", name: "Player Shots on Target", endpoint: "event" },
  { key: "player_shots_on_target_alternate", name: "Alternative Shots on Target", endpoint: "event" },
  { key: "player_to_receive_card", name: "Player to Receive a Card", endpoint: "event" },
  { key: "player_to_receive_red_card", name: "Player to Receive a Red Card", endpoint: "event" }
];

function marketLabel(key) {
  const item = MARKET_CATALOG.find(m => m.key === key);

  return item
    ? item.name
    : String(key || "").replace(/_/g, " ");
}

/* -------------------------------------------------------
   ODDS NORMALIZATION
------------------------------------------------------- */

function getBestMarkets(event) {
  const collected = {};

  for (const bookmaker of event.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      const key = market.key;

      if (!collected[key]) {
        collected[key] = {
          market_key: key,
          market_name: marketLabel(key),
          outcomes: [],
          bookmaker: bookmaker.title || bookmaker.key
        };
      }

      const existing = new Map(
        collected[key].outcomes.map(o => [
          `${normalizeText(o.name)}|${o.point ?? ""}`,
          o
        ])
      );

      for (const outcome of market.outcomes || []) {
        const price = safeNumber(outcome.price);

        if (price === null || price <= 1) continue;

        const identity =
          `${normalizeText(outcome.name)}|${outcome.point ?? ""}`;

        const previous = existing.get(identity);

        if (!previous || price > previous.price) {
          existing.set(identity, {
            name: outcome.name,
            price,
            ...(outcome.point !== undefined
              ? { point: outcome.point }
              : {})
          });
        }
      }

      collected[key].outcomes = Array.from(existing.values());
    }
  }

  return collected;
}

function normalizeEvent(event) {
  const markets = getBestMarkets(event);
  const h2h = markets.h2h || markets.h2h_3_way;

  let homeOdds = null;
  let drawOdds = null;
  let awayOdds = null;

  if (h2h) {
    for (const outcome of h2h.outcomes) {
      const name = normalizeText(outcome.name);

      if (name === normalizeText(event.home_team)) {
        homeOdds = outcome.price;
      } else if (name === normalizeText(event.away_team)) {
        awayOdds = outcome.price;
      } else if (name === "draw") {
        drawOdds = outcome.price;
      }
    }
  }

  const marketArray = Object.values(markets);

  return {
    id: event.id,
    event_id: event.id,
    fixture_id: event.id,

    sport_key: event.sport_key,
    sport_title: event.sport_title,
    league: event.sport_title,

    home: event.home_team,
    away: event.away_team,
    home_team: event.home_team,
    away_team: event.away_team,

    date: event.commence_time,
    kickoff: event.commence_time,
    commence_time: event.commence_time,

    status: event.completed ? "FINISHED" : "TIMED",

    odds: {
      home: homeOdds,
      draw: drawOdds,
      away: awayOdds
    },

    home_odds: homeOdds,
    draw_odds: drawOdds,
    away_odds: awayOdds,

    markets,
    market_list: marketArray
  };
}

/* -------------------------------------------------------
   COMMON API ROUTES
------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    name: "FootStats Prediction Challenge Backend",
    status: "online",
    provider: "The Odds API",
    timezone: TZ,
    predictionDate: todayNigeria(),

    endpoints: [
      "/api/health",
      "/api/diagnostic",
      "/api/competitions",
      "/api/odds/sports",
      "/api/odds?sport=soccer_epl",
      "/api/markets/catalog",
      "/api/markets?sport=soccer_epl&eventId=EVENT_ID",
      "/api/event-odds?sport=soccer_epl&eventId=EVENT_ID&markets=h2h,totals",
      "/api/fixtures",
      "/api/fixtures?limit=5",
      "/api/scores?sport=soccer_epl",
      "/api/score-predictions",
      "/api/leaderboard"
    ]
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    provider: "The Odds API",
    timezone: TZ,
    predictionDate: todayNigeria(),
    competitionsConfigured: COMPETITIONS.length,
    oddsConfigured: Boolean(ODDS_API_KEY),
    supabaseConfigured: Boolean(
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    )
  });
});

app.get("/api/diagnostic", (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    timezone: TZ,
    predictionDate: todayNigeria(),
    competitionsConfigured: COMPETITIONS.length,
    oddsApiKeyConfigured: Boolean(ODDS_API_KEY),
    supabaseConfigured: Boolean(
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ),
    scoringSecretConfigured: Boolean(SCORING_SECRET)
  });
});

/* -------------------------------------------------------
   MARKET ENDPOINTS
------------------------------------------------------- */

app.get("/api/markets/catalog", (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    count: MARKET_CATALOG.length,
    note: "Reference catalogue only. Actual market availability depends on sport, event and bookmaker.",
    markets: MARKET_CATALOG
  });
});

app.get("/api/markets", async (req, res) => {
  try {
    const sport = String(req.query.sport || "").trim();

    const eventId = String(
      req.query.eventId || req.query.event_id || ""
    ).trim();

    const regions = String(req.query.regions || "uk").trim();

    if (!sport || !eventId) {
      return sendError(
        res,
        400,
        "Required: sport and eventId. Example: /api/markets?sport=soccer_epl&eventId=EVENT_ID"
      );
    }

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/events/${encodeURIComponent(eventId)}/markets`,
      { regions }
    );

    const data = result.data || {};
    const bookmakers = Array.isArray(data.bookmakers)
      ? data.bookmakers
      : [];

    const unique = new Map();

    for (const bookmaker of bookmakers) {
      for (const market of bookmaker.markets || []) {
        if (!unique.has(market.key)) {
          unique.set(market.key, {
            key: market.key,
            name: marketLabel(market.key),
            bookmakers: []
          });
        }

        const item = unique.get(market.key);
        const bookmakerName = bookmaker.title || bookmaker.key;

        if (!item.bookmakers.includes(bookmakerName)) {
          item.bookmakers.push(bookmakerName);
        }
      }
    }

    res.json({
      success: true,
      provider: "The Odds API",
      sport,
      eventId,

      event: {
        id: data.id || eventId,
        home_team: data.home_team || null,
        away_team: data.away_team || null,
        commence_time: data.commence_time || null
      },

      regions,
      count: unique.size,
      markets: Array.from(unique.values()),
      requestsRemaining: result.remaining,
      requestsUsed: result.used
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.get("/api/event-odds", async (req, res) => {
  try {
    const sport = String(req.query.sport || "").trim();

    const eventId = String(
      req.query.eventId || req.query.event_id || ""
    ).trim();

    const regions = String(req.query.regions || "uk").trim();

    const markets = String(req.query.markets || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (!sport || !eventId || markets.length === 0) {
      return sendError(
        res,
        400,
        "Required: sport, eventId and markets. Example: /api/event-odds?sport=soccer_epl&eventId=EVENT_ID&markets=btts,double_chance"
      );
    }

    if (markets.length > 10) {
      return sendError(
        res,
        400,
        "Request up to 10 market keys at a time. Split larger requests into batches."
      );
    }

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/events/${encodeURIComponent(eventId)}/odds`,
      {
        regions,
        markets: markets.join(","),
        oddsFormat: "decimal",
        dateFormat: "iso"
      }
    );

    const data = result.data || {};

    const bookmakers = (data.bookmakers || []).map(bookmaker => ({
      key: bookmaker.key,
      title: bookmaker.title,
      last_update: bookmaker.last_update,

      markets: (bookmaker.markets || []).map(market => ({
        key: market.key,
        name: marketLabel(market.key),
        last_update: market.last_update,

        outcomes: (market.outcomes || []).map(outcome => ({
          name: outcome.name,
          price: safeNumber(outcome.price),

          ...(outcome.point !== undefined
            ? { point: outcome.point }
            : {}),

          ...(outcome.description
            ? { description: outcome.description }
            : {})
        }))
      }))
    }));

    res.json({
      success: true,
      provider: "The Odds API",
      sport,
      eventId,

      event: {
        id: data.id || eventId,
        home_team: data.home_team || null,
        away_team: data.away_team || null,
        commence_time: data.commence_time || null
      },

      requestedMarkets: markets,
      regions,
      bookmakers,

      availableMarketKeys: Array.from(new Set(
        bookmakers.flatMap(b => b.markets.map(m => m.key))
      )),

      requestsRemaining: result.remaining,
      requestsUsed: result.used,
      requestsLast: result.last
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

/* -------------------------------------------------------
   SPORTS AND COMPETITIONS
------------------------------------------------------- */

app.get("/api/odds/sports", async (req, res) => {
  try {
    const result = await oddsRequest("/sports", { all: "false" });

    const sports = (result.data || [])
      .filter(sport => sport.active !== false)
      .map(sport => ({
        key: sport.key,
        title: sport.title,
        group: sport.group,
        description: sport.description,
        active: sport.active
      }));

    res.json({
      success: true,
      provider: "The Odds API",
      sports,
      count: sports.length,
      requestsRemaining: result.remaining
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

/*
  This route uses the saved 50-competition list.
  It does not call The Odds API and therefore does
  not consume an API request.
*/
app.get("/api/competitions", (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    competitionsReturned: COMPETITIONS.length,
    competitions: COMPETITIONS.map(sport => ({
      id: sport.key,
      key: sport.key,
      name: sport.name,
      title: sport.name,
      group: "Soccer"
    }))
  });
});

/* -------------------------------------------------------
   STANDARD ODDS ENDPOINT
------------------------------------------------------- */

app.get("/api/odds", async (req, res) => {
  try {
    const sport = String(req.query.sport || "").trim();

    if (!sport) {
      return sendError(
        res,
        400,
        "Missing sport parameter. Example: /api/odds?sport=soccer_epl"
      );
    }

    const regions = String(req.query.regions || "uk").trim();

    const requestedMarkets = String(
      req.query.markets || "h2h,totals,spreads"
    )
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const eventSpecific = requestedMarkets.filter(key =>
      MARKET_CATALOG.some(
        m => m.key === key && m.endpoint === "event"
      )
    );

    if (eventSpecific.length) {
      return sendError(
        res,
        400,
        "The standard odds endpoint does not support some requested markets. Use /api/event-odds for event-specific markets.",
        { eventSpecificMarkets: eventSpecific }
      );
    }

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/odds`,
      {
        regions,
        markets: requestedMarkets.join(","),
        oddsFormat: "decimal",
        dateFormat: "iso"
      }
    );

    const matches = (result.data || []).map(normalizeEvent);

    res.json({
      success: true,
      provider: "The Odds API",
      sport,
      date: todayNigeria(),
      count: matches.length,
      matches,
      requestsRemaining: result.remaining,
      requestsUsed: result.used
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

/* -------------------------------------------------------
   FIXTURE FETCHING HELPERS
------------------------------------------------------- */

async function fetchCompetitionFixtures(sport, bounds) {
  const result = await oddsRequest(
    `/sports/${encodeURIComponent(sport.key)}/odds`,
    {
      regions: "uk",
      markets: "h2h",
      oddsFormat: "decimal",
      dateFormat: "iso",
      commenceTimeFrom: bounds.from,
      commenceTimeTo: bounds.to
    }
  );

  return {
    sport,
    matches: (result.data || []).map(event => ({
      ...normalizeEvent(event),
      league: sport.name,
      sport_title: sport.name,
      sport_key: sport.key
    })),
    quota: {
      remaining: result.remaining,
      used: result.used,
      last: result.last
    }
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index], index)
        };
      } catch (error) {
        results[index] = {
          status: "rejected",
          reason: error
        };
      }
    }
  }

  const workerCount = Math.min(
    Math.max(concurrency, 1),
    items.length
  );

  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker())
  );

  return results;
}

/* -------------------------------------------------------
   PREDICTION CHALLENGE FIXTURES

   Default: all 50 configured competitions.

   ?limit=5 limits a test to the first five competitions.

   Fixtures are filtered by Nigeria's calendar day.
   We deliberately do not remove an event merely because
   its kickoff time has passed.

   Results are cached for 60 seconds per Nigeria date.
------------------------------------------------------- */

app.get("/api/fixtures", async (req, res) => {
  try {
    const bounds = getNigeriaDayBounds();

    const requestedLimit = parseInt(req.query.limit || "50", 10);

    const limit = Math.min(
      Math.max(
        Number.isFinite(requestedLimit) ? requestedLimit : 50,
        1
      ),
      COMPETITIONS.length
    );

    const selectedSports = COMPETITIONS.slice(0, limit);

    const cacheKey = `${bounds.date}|${limit}`;

    if (
      fixturesCache.data &&
      fixturesCache.date === cacheKey &&
      Date.now() < fixturesCache.expiresAt
    ) {
      return res.json({
        ...fixturesCache.data,
        cached: true
      });
    }

    const results = await mapWithConcurrency(
      selectedSports,
      FIXTURES_CONCURRENCY,
      sport => fetchCompetitionFixtures(sport, bounds)
    );

    const matches = [];
    const errors = [];
    const successfulCompetitions = [];
    const quotaReports = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const sport = selectedSports[i];

      if (result.status === "fulfilled") {
        successfulCompetitions.push({
          key: sport.key,
          name: sport.name,
          matchesReturned: result.value.matches.length
        });

        matches.push(...result.value.matches);

        quotaReports.push({
          competition: sport.key,
          ...result.value.quota
        });
      } else {
        errors.push({
          competition: sport.key,
          name: sport.name,
          error: result.reason?.message || "Request failed",
          status: result.reason?.status || null,
          ...(result.reason?.quota
            ? { quota: result.reason.quota }
            : {})
        });
      }
    }

    /*
      Keep only events whose kickoff falls on today's
      Nigeria calendar date. Do not check kickoff > now:
      a match may already have started and still be returned
      by the provider.
    */
    const todaysMatches = matches
      .filter(match =>
        match.event_id &&
        match.kickoff &&
        isTodayNigeria(match.kickoff)
      )
      .sort((a, b) =>
        new Date(a.kickoff).getTime() -
        new Date(b.kickoff).getTime()
      );

    /*
      Deduplicate events by Odds API event ID.
    */
    const unique = [];
    const seen = new Set();

    for (const match of todaysMatches) {
      const id = String(match.event_id);

      if (seen.has(id)) continue;

      seen.add(id);
      unique.push(match);
    }

    const payload = {
      success: true,
      provider: "The Odds API",
      timezone: TZ,
      date: bounds.date,

      competitionsAvailable: COMPETITIONS.length,
      competitionsRequested: selectedSports.length,
      competitionsChecked: successfulCompetitions.length,
      competitionsFailed: errors.length,

      count: unique.length,
      matches: unique,

      successfulCompetitions,
      errors,
      quota: quotaReports,

      cached: false,
      cacheSeconds: FIXTURES_CACHE_MS / 1000
    };

    fixturesCache = {
      date: cacheKey,
      expiresAt: Date.now() + FIXTURES_CACHE_MS,
      data: payload
    };

    res.json(payload);
  } catch (error) {
    console.error("Fixtures error:", error);
    sendApiError(res, error);
  }
});

/* -------------------------------------------------------
   SCORES
------------------------------------------------------- */

app.get("/api/scores", async (req, res) => {
  try {
    const sport = String(req.query.sport || "").trim();

    if (!sport) {
      return sendError(
        res,
        400,
        "Missing sport parameter. Example: /api/scores?sport=soccer_epl"
      );
    }

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/scores`,
      {
        daysFrom: "3",
        dateFormat: "iso"
      }
    );

    res.json({
      success: true,
      provider: "The Odds API",
      sport,
      count: (result.data || []).length,
      scores: result.data || [],
      requestsRemaining: result.remaining
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

/* -------------------------------------------------------
   RESULT SETTLEMENT
------------------------------------------------------- */

function readScores(event) {
  const scores = event.scores || [];

  const homeEntry = scores.find(s =>
    normalizeText(s.name) === normalizeText(event.home_team)
  );

  const awayEntry = scores.find(s =>
    normalizeText(s.name) === normalizeText(event.away_team)
  );

  if (!homeEntry || !awayEntry) return null;

  const home = safeNumber(homeEntry.score);
  const away = safeNumber(awayEntry.score);

  if (home === null || away === null) return null;

  return { home, away };
}

function normalizeH2HSelection(selection, homeName, awayName) {
  const s = normalizeText(selection);

  if (["h", "home", "1"].includes(s)) return "H";
  if (["d", "draw", "x"].includes(s)) return "D";
  if (["a", "away", "2"].includes(s)) return "A";

  if (s === normalizeText(homeName)) return "H";
  if (s === normalizeText(awayName)) return "A";

  return null;
}

/*
  Returns true, false, or null.
  null means the selection cannot safely be settled.
*/
function settlePick(pick, event) {
  if (!event || event.completed !== true) return null;

  const score = readScores(event);

  if (!score) return null;

  const homeName = event.home_team || getTeamNames(pick).home;
  const awayName = event.away_team || getTeamNames(pick).away;

  const market = getMarketKey(pick);
  const selection = getSelection(pick);

  const { home, away } = score;

  if (market === "h2h" || market === "h2h_3_way") {
    const selected = normalizeH2HSelection(
      selection,
      homeName,
      awayName
    );

    if (!selected) return null;

    const actual =
      home > away ? "H" :
      home < away ? "A" :
      "D";

    return selected === actual;
  }

  if (market === "totals") {
    const s = normalizeText(selection);
    const total = home + away;

    const match = s.match(
      /^(over|under)\s*(\d+(?:\.\d+)?)$/
    );

    if (!match) return null;

    const line = Number(match[2]);

    if (match[1] === "over") return total > line;

    return total < line;
  }

  if (market === "btts") {
    const s = normalizeText(selection);

    const yes = [
      "yes",
      "btts yes",
      "both teams to score yes"
    ];

    const no = [
      "no",
      "btts no",
      "both teams to score no"
    ];

    if (yes.includes(s)) {
      return home > 0 && away > 0;
    }

    if (no.includes(s)) {
      return home === 0 || away === 0;
    }

    return null;
  }

  // Do not grade unsupported markets using guessed rules.
  return null;
}

function calculateTicket(picks, scoreEvents) {
  if (!Array.isArray(picks) || picks.length === 0) {
    return {
      state: "unresolved",
      reason: "Ticket has no selections."
    };
  }

  let totalPoints = 0;
  let anyLoss = false;
  let allSettled = true;

  const updatedPicks = picks.map(original => {
    const pick = { ...original };

    const eventId = getEventId(pick);
    const sportKey = getSportKey(pick);

    if (!eventId || !sportKey) {
      allSettled = false;

      pick.settlement_note =
        "Legacy selection: missing exact Odds API event ID or sport key.";

      return pick;
    }

    const event = scoreEvents.get(`${sportKey}|${eventId}`);

    if (!event || event.completed !== true) {
      allSettled = false;
      return pick;
    }

    const won = settlePick(pick, event);

    if (won === null) {
      allSettled = false;

      pick.settlement_note =
        "This market or selection could not be settled safely.";

      return pick;
    }

    pick.result = won ? "won" : "lost";
    pick.settled = true;
    pick.final_score = readScores(event);
    pick.settled_at = new Date().toISOString();

    if (won) {
      const odds = getSavedOdds(pick);

      if (odds === null) {
        allSettled = false;

        pick.settlement_note =
          "Final result found, but saved decimal odds are missing.";
      } else {
        totalPoints += (odds - 1) * POINTS_MULTIPLIER;
      }
    } else {
      anyLoss = true;
    }

    return pick;
  });

  if (!allSettled) {
    return {
      state: "pending",
      picks: updatedPicks,
      reason: "Waiting for complete results or required saved data."
    };
  }

  return {
    state: "graded",
    picks: updatedPicks,
    points: anyLoss
      ? 0
      : Math.round(totalPoints * 100) / 100,
    anyLoss
  };
}

async function fetchScoreEvents(sportKey) {
  const result = await oddsRequest(
    `/sports/${encodeURIComponent(sportKey)}/scores`,
    {
      daysFrom: "3",
      dateFormat: "iso"
    }
  );

  return result.data || [];
}

function scoringAuthorized(req) {
  if (!SCORING_SECRET) return false;

  const supplied =
    req.get("x-scoring-secret") ||
    req.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";

  return supplied === SCORING_SECRET;
}

/* -------------------------------------------------------
   PREDICTION SCORING
------------------------------------------------------- */

app.post("/api/score-predictions", async (req, res) => {
  if (!scoringAuthorized(req)) {
    return sendError(res, 401, "Unauthorized scoring request.");
  }

  try {
    const entries = await supabaseRequest(
      `${TABLE}?status=eq.pending&select=id,user_id,picks,point,points,status,created_at`,
      { method: "GET" }
    );

    const pendingEntries = Array.isArray(entries) ? entries : [];

    if (pendingEntries.length === 0) {
      return res.json({
        success: true,
        message: "No pending prediction tickets.",
        checked: 0,
        graded: 0,
        pending: 0,
        skipped: 0,
        pointsAwarded: 0
      });
    }

    const sports = new Set();

    for (const entry of pendingEntries) {
      for (const pick of Array.isArray(entry.picks) ? entry.picks : []) {
        const sportKey = getSportKey(pick);

        if (sportKey && getEventId(pick)) {
          sports.add(sportKey);
        }
      }
    }

    const scoreEvents = new Map();
    const sportErrors = [];

    for (const sportKey of sports) {
      try {
        const events = await fetchScoreEvents(sportKey);

        for (const event of events) {
          scoreEvents.set(`${sportKey}|${event.id}`, event);
        }
      } catch (error) {
        sportErrors.push({
          sport: sportKey,
          error: error.message
        });
      }
    }

    let graded = 0;
    let pending = 0;
    let skipped = 0;
    let pointsAwarded = 0;

    for (const entry of pendingEntries) {
      const picks = Array.isArray(entry.picks) ? entry.picks : [];

      if (!picks.length) {
        skipped++;
        continue;
      }

      const outcome = calculateTicket(picks, scoreEvents);

      if (outcome.state !== "graded") {
        pending++;
        continue;
      }

      const points = outcome.points || 0;

      const updated = await supabaseRequest(
        `${TABLE}?id=eq.${encodeURIComponent(entry.id)}&status=eq.pending`,
        {
          method: "PATCH",
          prefer: "return=representation",

          body: {
            picks: outcome.picks,
            point: points,
            points,
            status: "graded"
          }
        }
      );

      if (Array.isArray(updated) && updated.length > 0) {
        graded++;
        pointsAwarded += points;
      } else {
        skipped++;
      }
    }

    res.json({
      success: true,
      message: "Prediction scoring check completed.",
      checked: pendingEntries.length,
      graded,
      pending,
      skipped,
      pointsAwarded: Math.round(pointsAwarded * 100) / 100,
      sportsChecked: Array.from(sports),
      sportErrors
    });
  } catch (error) {
    console.error("Scoring error:", error);

    sendError(res, 500, "Prediction scoring failed.", {
      details: error.message
    });
  }
});

/* -------------------------------------------------------
   LEADERBOARD
------------------------------------------------------- */

app.get("/api/leaderboard", async (req, res) => {
  try {
    const entries = await supabaseRequest(
      `${TABLE}?status=eq.graded&select=user_id,point,points,created_at`,
      { method: "GET" }
    );

    const totals = new Map();

    for (const entry of entries || []) {
      const userId = entry.user_id;

      if (!userId) continue;

      const points = safeNumber(entry.points ?? entry.point) || 0;

      const existing = totals.get(userId) || {
        user_id: userId,
        points: 0,
        tickets: 0
      };

      existing.points += points;
      existing.tickets += 1;

      totals.set(userId, existing);
    }

    const leaderboard = Array.from(totals.values())
      .map(row => ({
        ...row,
        points: Math.round(row.points * 100) / 100
      }))
      .sort((a, b) => b.points - a.points)
      .map((row, index) => ({
        rank: index + 1,
        ...row
      }));

    res.json({
      success: true,
      count: leaderboard.length,
      leaderboard
    });
  } catch (error) {
    sendError(res, 502, "Could not load leaderboard.", {
      details: error.message
    });
  }
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`FootStats backend running on port ${PORT}`);
  console.log("Provider: The Odds API");
  console.log(`Competitions configured: ${COMPETITIONS.length}`);
  console.log(`Nigeria prediction date: ${todayNigeria()}`);
}); 
