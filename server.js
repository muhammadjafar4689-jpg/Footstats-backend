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

const FIXTURES_CONCURRENCY = 5;

/* -------------------------------------------------------
   DATE HELPERS (Nigeria time)
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

function isValidDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(new Date(`${value}T00:00:00+01:00`).getTime());
}

function shiftNigeriaDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00+01:00`);
  d.setUTCDate(d.getUTCDate() + days);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);

  const p = {};

  for (const item of parts) {
    if (item.type !== "literal") {
      p[item.type] = item.value;
    }
  }

  return `${p.year}-${p.month}-${p.day}`;
}

function toOddsApiTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nigeriaBoundsForDate(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+01:00`);

  return {
    from: toOddsApiTime(start),
    to: toOddsApiTime(new Date(start.getTime() + 24 * 60 * 60 * 1000))
  };
}
 

/* -------------------------------------------------------
   50 COMPETITIONS

   Reference list only. Returned by /api/competitions.
   Costs ZERO API requests.

   Fixtures are only FETCHED for ACTIVE_COMPETITIONS
   (see the fixtures section below) to protect quota.
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

const url = "${SUPABASE_URL}/rest/v1/${path}";

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
"Supabase HTTP ${response.status}: ${ typeof data === "string" ? data : JSON.stringify(data) }"
);
}

return data;
}

function getNigeriaMarketCacheDay() {
const parts = new Intl.DateTimeFormat("en-CA", {
timeZone: "Africa/Lagos",
year: "numeric",
month: "2-digit",
day: "2-digit"
}).formatToParts(new Date());

const values = {};

for (const part of parts) {
values[part.type] = part.value;
}

const today = "${values.year}-${values.month}-${values.day}";

const start = new Date("${today}T00:00:00+01:00");
const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

return {
start: start.toISOString(),
end: end.toISOString()
};
} 
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
   MARKET REFERENCE CATALOGUE — THE 30 FOOTBALL MARKETS

   Grouped A–E exactly as documented for the product.

   - key: The Odds API market key (null when the provider
     does not offer the market at all).
   - endpoint: "featured" markets come back on the standard
     odds endpoint; "event" markets must be requested per
     event through the event odds endpoint.
   - supported: false means The Odds API has no such market
     (currently the two fouls markets). They are listed for
     the UI so the product can show them honestly as
     unavailable instead of guessing an API key.

   NOTE: even for supported keys, actual availability varies
   by sport, event, region and bookmaker. Never assume a key
   returns data — always check the response.
------------------------------------------------------- */

const MARKET_CATALOG = [
  /* A. Match result and handicap markets */
  { key: "h2h", name: "Match Winner (1X2)", group: "match_result", endpoint: "featured", supported: true },
  { key: "h2h_3_way", name: "Three-Way Match Result", group: "match_result", endpoint: "event", supported: true },
  { key: "double_chance", name: "Double Chance", group: "match_result", endpoint: "event", supported: true },
  { key: "double_chance_h1", name: "First-Half Double Chance", group: "match_result", endpoint: "event", supported: true },
  { key: "draw_no_bet", name: "Draw No Bet", group: "match_result", endpoint: "event", supported: true },
  { key: "spreads", name: "Asian Handicap", group: "match_result", endpoint: "featured", supported: true },
  { key: "alternate_spreads", name: "Alternative Handicap", group: "match_result", endpoint: "event", supported: true },
  { key: "halftime_fulltime", name: "Half Time / Full Time", group: "match_result", endpoint: "event", supported: true },
  { key: "h2h_3_way_h1", name: "First-Half Match Result", group: "match_result", endpoint: "event", supported: true },
  { key: "h2h_3_way_h2", name: "Second-Half Match Result", group: "match_result", endpoint: "event", supported: true },

  /* B. Goal markets */
  { key: "totals", name: "Over/Under Goals", group: "goals", endpoint: "featured", supported: true },
  { key: "alternate_totals", name: "Alternative Over/Under", group: "goals", endpoint: "event", supported: true },
  { key: "btts", name: "Both Teams to Score", group: "goals", endpoint: "event", supported: true },
  { key: "btts_h1", name: "First-Half Both Teams to Score", group: "goals", endpoint: "event", supported: true },
  { key: "btts_h2", name: "Second-Half Both Teams to Score", group: "goals", endpoint: "event", supported: true },
  { key: "correct_score", name: "Correct Score", group: "goals", endpoint: "event", supported: true },
  { key: "correct_score_h1", name: "First-Half Correct Score", group: "goals", endpoint: "event", supported: true },
  { key: "totals_h1", name: "First-Half Over/Under", group: "goals", endpoint: "event", supported: true },
  { key: "totals_h2", name: "Second-Half Over/Under", group: "goals", endpoint: "event", supported: true },
  { key: "team_totals", name: "Team Goals Over/Under", group: "goals", endpoint: "event", supported: true },
  { key: "team_totals_h1", name: "First-Half Team Goals", group: "goals", endpoint: "event", supported: true },
  { key: "team_totals_h2", name: "Second-Half Team Goals", group: "goals", endpoint: "event", supported: true },

  /* C. Corner markets */
  { key: "alternate_totals_corners", name: "Total Corners", group: "corners", endpoint: "event", supported: true },
  { key: "alternate_spreads_corners", name: "Corner Handicap", group: "corners", endpoint: "event", supported: true },
  { key: "alternate_team_totals_corners", name: "Team Total Corners", group: "corners", endpoint: "event", supported: true },
  { key: "corners_1x2", name: "Corner Result", group: "corners", endpoint: "event", supported: true },

  /* D. Card markets */
  { key: "alternate_totals_cards", name: "Total Cards", group: "cards", endpoint: "event", supported: true },
  { key: "alternate_spreads_cards", name: "Card Handicap", group: "cards", endpoint: "event", supported: true },

  /* E. Fouls markets — NOT offered by The Odds API.
     Listed so the UI can display them as unavailable.
     Do not request keys that the provider does not have. */
  { key: null, name: "Total Fouls", group: "fouls", endpoint: null, supported: false },
  { key: null, name: "Team Fouls", group: "fouls", endpoint: null, supported: false }
];

const MARKET_GROUPS = [
  { id: "match_result", title: "Match Result & Handicap" },
  { id: "goals", title: "Goals" },
  { id: "corners", title: "Corners" },
  { id: "cards", title: "Cards" },
  { id: "fouls", title: "Fouls" }
];

/* Market keys that can actually be requested from the provider. */
const REQUESTABLE_MARKET_KEYS = MARKET_CATALOG
  .filter(m => m.supported && m.key)
  .map(m => m.key);

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
          `${normalizeText(o.name)}|${o.point ?? ""}|${normalizeText(o.description ?? "")}`,
          o
        ])
      );

      for (const outcome of market.outcomes || []) {
        const price = safeNumber(outcome.price);

        if (price === null || price <= 1) continue;

        const identity =
          `${normalizeText(outcome.name)}|${outcome.point ?? ""}|${normalizeText(outcome.description ?? "")}`;

        const previous = existing.get(identity);

        if (!previous || price > previous.price) {
          existing.set(identity, {
            name: outcome.name,
            price,
            ...(outcome.point !== undefined
              ? { point: outcome.point }
              : {}),
            // FIX: keep provider description — it holds the TEAM NAME
            // for team_totals picks. Without it market 20 never settles.
            ...(outcome.description
              ? { description: outcome.description }
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
      "/api/match-markets?sport=soccer_epl&eventId=EVENT_ID",
      "/api/fixtures",
      "/api/fixtures?date=YYYY-MM-DD",
      "/api/scores?sport=soccer_epl",
      "/api/score-predictions",
      "/api/cards",
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
    activeCompetitions: ACTIVE_COMPETITIONS.length,
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
    activeCompetitions: ACTIVE_COMPETITIONS.length,
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
    note: "Reference catalogue of the 30 product markets. Actual availability depends on sport, event, region and bookmaker. Markets with supported=false are not offered by the provider at all.",
    groups: MARKET_GROUPS,
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
   MATCH DETAIL — ALL 30 MARKETS FOR ONE EVENT

   /api/match-markets?sport=soccer_epl&eventId=EVENT_ID

   Called when a user taps a match card. Fetches every
   provider-supported market from our 30-market catalogue
   for that single event, in batches of 10 keys per Odds
   API request (usage is charged per market per region,
   so this endpoint intentionally serves ONE event only).

   A short in-memory cache (per event + region) prevents
   repeated taps on the same match from burning quota.

   Markets the provider does not return are reported in
   "unavailable" with a reason — they are never invented.
------------------------------------------------------- */

const MATCH_MARKETS_CACHE_TTL_MS = 10 * 60 * 1000;
const MATCH_MARKETS_BATCH_SIZE = 10;
const matchMarketsCache = new Map();

async function fetchEventMarketBatch(sport, eventId, regions, marketKeys) {
  const result = await oddsRequest(
    `/sports/${encodeURIComponent(sport)}/events/${encodeURIComponent(eventId)}/odds`,
    {
      regions,
      markets: marketKeys.join(","),
      oddsFormat: "decimal",
      dateFormat: "iso"
    }
  );

  return result;
}

/*
  Fetch a batch of market keys. If the provider rejects the
  batch (e.g. one key is not valid for this sport/plan),
  fall back to requesting each key individually so a single
  unsupported key cannot take down the whole batch.
*/
async function fetchBatchResilient(sport, eventId, regions, marketKeys) {
  try {
    const result = await fetchEventMarketBatch(
      sport, eventId, regions, marketKeys
    );
    return {
      events: [result.data].filter(Boolean),
      failures: [],
      quota: { remaining: result.remaining, used: result.used }
    };
  } catch (batchError) {
    const events = [];
    const failures = [];
    let quota = null;

    for (const key of marketKeys) {
      try {
        const single = await fetchEventMarketBatch(
          sport, eventId, regions, [key]
        );
        if (single.data) events.push(single.data);
        quota = { remaining: single.remaining, used: single.used };
      } catch (error) {
        failures.push({ market: key, error: error.message });
      }
    }

    if (!events.length && !failures.length) {
      throw batchError;
    }

    return { events, failures, quota, batchError: batchError.message };
  }
}

app.get("/api/match-markets", async (req, res) => {
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
        "Required: sport and eventId. Example: /api/match-markets?sport=soccer_epl&eventId=EVENT_ID"
      );
    }
     const marketCacheDay = getNigeriaMarketCacheDay();

const cacheKey = `${sport}|${eventId}|${regions}|${marketCacheDay.start}`;

try {
  const query = new URLSearchParams({
    select: "payload",
    event_id: `eq.${eventId}`,
    sport_key: `eq.${sport}`,
    regions: `eq.${regions}`,
    and: `(fetched_at.gte.${marketCacheDay.start},fetched_at.lt.${marketCacheDay.end})`
  });

  const savedMarkets = await supabaseRequest(
    `match_markets_cache?${query.toString()}`
  );

  if (savedMarkets && savedMarkets.length > 0) {
    const savedPayload = savedMarkets[0].payload;

    matchMarketsCache.set(cacheKey, {
      at: Date.now(),
      payload: savedPayload
    });

    return res.json({
      ...savedPayload,
      cached: true
    });
  }
} catch (cacheError) {
  console.error(
    "Market cache read error:",
    cacheError.message
  );
  } 
    const cached = matchMarketsCache.get(cacheKey);

    if (cached && (Date.now() - cached.at) < MATCH_MARKETS_CACHE_TTL_MS) {
      return res.json({
        ...cached.payload,
        cached: true
      });
    }

    const batches = [];

    for (let i = 0; i < REQUESTABLE_MARKET_KEYS.length; i += MATCH_MARKETS_BATCH_SIZE) {
      batches.push(REQUESTABLE_MARKET_KEYS.slice(i, i + MATCH_MARKETS_BATCH_SIZE));
    }

    const mergedBookmakers = new Map();
    const fetchFailures = [];

    let eventInfo = null;
    let requestsRemaining = null;
    let requestsUsed = null;

    for (const batch of batches) {
      const { events, failures, quota, batchError } =
        await fetchBatchResilient(sport, eventId, regions, batch);

      fetchFailures.push(...failures);
      if (batchError) {
        fetchFailures.push({ market: batch.join(","), error: batchError });
      }

      if (quota) {
        requestsRemaining = quota.remaining;
        requestsUsed = quota.used;
      }

      for (const data of events) {
        if (!eventInfo && data && data.id) {
          eventInfo = {
            id: data.id,
            sport_key: data.sport_key || sport,
            sport_title: data.sport_title || null,
            home_team: data.home_team || null,
            away_team: data.away_team || null,
            commence_time: data.commence_time || null
          };
        }

        for (const bookmaker of data.bookmakers || []) {
          const bk = bookmaker.key || bookmaker.title || "unknown";

          if (!mergedBookmakers.has(bk)) {
            mergedBookmakers.set(bk, {
              key: bookmaker.key,
              title: bookmaker.title,
              markets: []
            });
          }

          mergedBookmakers.get(bk).markets.push(
            ...(bookmaker.markets || [])
          );
        }
      }
    }

    const mergedEvent = {
      ...(eventInfo || {}),
      id: eventId,
      sport_key: sport,
      bookmakers: Array.from(mergedBookmakers.values())
    };

    const markets = getBestMarkets(mergedEvent);

    const returnedKeys = new Set(Object.keys(markets));

    const failedKeys = new Set(
      fetchFailures.map(f => f.market).filter(k => !k.includes(","))
    );

    const groups = MARKET_GROUPS.map(group => ({
      id: group.id,
      title: group.title,
      markets: MARKET_CATALOG
        .filter(m => m.group === group.id)
        .map(m => {
          if (!m.supported) {
            return {
              key: null,
              name: m.name,
              status: "unavailable",
              reason: "The Odds API does not offer this market."
            };
          }

          const found = markets[m.key];

          if (found && found.outcomes.length) {
            return {
              key: m.key,
              name: m.name,
              status: "available",
              bookmaker: found.bookmaker,
              outcomes: found.outcomes
            };
          }

          return {
            key: m.key,
            name: m.name,
            status: "unavailable",
            reason: failedKeys.has(m.key)
              ? "The provider rejected this market key for this event or plan."
              : "No bookmaker returned odds for this market on this event."
          };
        })
    }));

    const payload = {
      success: true,
      provider: "The Odds API",
      sport,
      eventId,
      regions,

      event: eventInfo || {
        id: eventId,
        sport_key: sport,
        home_team: null,
        away_team: null,
        commence_time: null
      },

      groups,
      markets,
      returnedMarketKeys: Array.from(returnedKeys),
      unavailableCount: groups
        .flatMap(g => g.markets)
        .filter(m => m.status === "unavailable").length,

      requestsRemaining,
      requestsUsed,
      cacheTtlMs: MATCH_MARKETS_CACHE_TTL_MS
    };
   try {
  await supabaseRequest(
    "match_markets_cache?on_conflict=event_id,sport_key,regions",
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        event_id: eventId,
        sport_key: sport,
        regions: regions,
        payload: payload,
        fetched_at: new Date().toISOString()
      }
    }
  );
} catch (cacheError) {
  console.error(
    "Market cache save error:",
    cacheError.message
  );
       } 
    matchMarketsCache.set(cacheKey, {
      at: Date.now(),
      payload
    });

    if (matchMarketsCache.size > 500) {
      const oldestKey = matchMarketsCache.keys().next().value;
      matchMarketsCache.delete(oldestKey);
    }

    res.json({ ...payload, cached: false });
  } catch (error) {
    sendApiError(res, error);
  }
});

/* -------------------------------------------------------
   SPORTS / COMPETITIONS

   /api/odds/sports is STATIC (zero API credits) and only
   lists the competitions we actually serve fixtures for.
   Keep the frontend dropdown and the fetchable list in
   sync automatically.
------------------------------------------------------- */

// All 50 active by default. Trim without code edits:
// ACTIVE_COMPETITIONS="soccer_epl,soccer_spain_la_liga" in Render.
const ACTIVE_COMPETITIONS = (process.env.ACTIVE_COMPETITIONS
  ? process.env.ACTIVE_COMPETITIONS.split(",").map(s => s.trim()).filter(Boolean)
  : COMPETITIONS.map(c => c.key)
).map(key => ({
  key,
  name: (COMPETITIONS.find(c => c.key === key) || { name: key }).name
}));

const TODAY_CACHE_REFRESH_MS = 24 * 60 * 60 * 1000;
const FUTURE_CACHE_REFRESH_MS = 48 * 60 * 60 * 1000;
const MAX_FUTURE_DAYS = 0;

app.get("/api/odds/sports", (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    sports: ACTIVE_COMPETITIONS.map(sport => ({
      key: sport.key,
      title: sport.name,
      group: "Soccer",
      description: sport.name,
      active: true
    })),
    count: ACTIVE_COMPETITIONS.length
  });
});

/*
  Reference list of all 50 competitions on your plan.
  Does not call The Odds API and costs zero requests.
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
   FIXTURES — THE DATE ENGINE

   /api/fixtures?date=YYYY-MM-DD

   The frontend controls which day is displayed. We serve
   exactly that Nigeria-calendar date.

   First request for a date: fetch from The Odds API for
   ACTIVE_COMPETITIONS and store in Supabase (fixtures_cache
   table). Later requests for the same date: served from
   Supabase at ZERO API cost.

   Refresh policy: "today" re-fetches if cache is older than
   12h; future dates re-fetch if older than 48h. Point your
   cron at /api/fixtures (no date) once a day at ~05:00
   Nigeria time to pre-warm today.
  ------------------------------------------------------ */
async function fetchCompetitionFixturesForRange(sport, bounds) { 
    
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
    }))
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

app.get("/api/fixtures", async (req, res) => {
  try {
    const requested = String(req.query.date || "").trim();
    const date = isValidDateKey(requested) ? requested : todayNigeria();

    const today = todayNigeria();

    if (date < today || date > shiftNigeriaDate(today, MAX_FUTURE_DAYS)) {
      return sendError(
        res,
        400,
        `Date must be between ${today} and ${shiftNigeriaDate(today, MAX_FUTURE_DAYS)} (Nigeria time).`
      );
    }

    const refreshMs = date === today
      ? TODAY_CACHE_REFRESH_MS
      : FUTURE_CACHE_REFRESH_MS;

    let rows = await supabaseRequest(
      `fixtures_cache?fixture_date=eq.${date}&select=event_id,sport_key,payload,fetched_at`,
      { method: "GET" }
    );

    let freshEnough = false;

    const competitionsToRefresh = ACTIVE_COMPETITIONS.filter(sport => {
  return !rows.some(r =>
    r.sport_key === sport.key &&
    r.payload?.cache_marker === true
  );
});

freshEnough = competitionsToRefresh.length === 0; 

    const fetchErrors = [];

    if (!freshEnough) {
      const bounds = nigeriaBoundsForDate(date);

      const results = await mapWithConcurrency(
       competitionsToRefresh,
        FIXTURES_CONCURRENCY,
        sport => fetchCompetitionFixturesForRange(sport, bounds)
      );

      const fetched = [];
       const cacheMarkers = [];

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "fulfilled") {
  fetched.push(...results[i].value.matches);

  cacheMarkers.push({
    event_id: `__cache_marker__${date}__${competitionsToRefresh[i].key}`,
    sport_key: competitionsToRefresh[i].key,
    fixture_date: date,
    fetched_at: new Date().toISOString(),
    payload: { cache_marker: true }
  });
}  else {
          fetchErrors.push({
            competition: competitionsToRefresh[i].key,
            error: results[i].reason?.message || "Request failed"
          });
        }
      }

      const forDate = fetched.filter(m =>
        m.event_id &&
        m.kickoff &&
        dateInNigeria(m.kickoff) === date
      );

      const seen = new Set();
      const unique = [];

      for (const m of forDate) {
        const k = `${m.sport_key}|${m.event_id}`;

        if (seen.has(k)) continue;

        seen.add(k);
        unique.push(m);
      }

      if (unique.length || cacheMarkers.length) {
  await supabaseRequest(
    `fixtures_cache?on_conflict=event_id,sport_key`,
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [
        ...unique.map(m => ({
          event_id: m.event_id,
          sport_key: m.sport_key,
          fixture_date: date,
          fetched_at: new Date().toISOString(),
          payload: { ...m, fixture_date: date }
        })),
        ...cacheMarkers
      ]
    }
  );
     } 

      // Delete previous days' fixtures and cache markers
await supabaseRequest(
  `fixtures_cache?fixture_date=lt.${today}`,
  { method: "DELETE", prefer: "return=minimal" }
).catch(() => {});

      rows = await supabaseRequest(
        `fixtures_cache?fixture_date=eq.${date}&select=event_id,sport_key,payload,fetched_at`,
        { method: "GET" }
      );
    }

    const seen = new Set();
    const matches = [];

    for (const r of (Array.isArray(rows) ? rows : [])) {
  if (r.payload?.cache_marker) continue; 
      const k = `${r.sport_key}|${r.event_id}`;

      if (seen.has(k)) continue;

      seen.add(k);
      matches.push(r.payload);
    }

    matches.sort((a, b) =>
      new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()
    );

    res.json({
      success: true,
      provider: "The Odds API",
      timezone: TZ,
      date,
      count: matches.length,
      matches,
      cached: freshEnough,
      errors: fetchErrors
    });
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

/* OPTION B backstop: markets that can NEVER be auto-settled
   (/scores returns full-time goals only — no HT, corners,
   cards or fouls). The UI blocks these; this stops a forged
   request from smuggling one in. */
const SETTLEABLE_MARKET_KEYS = new Set([
  "h2h", "h2h_3_way", "double_chance", "draw_no_bet",
  "spreads", "alternate_spreads",
  "totals", "alternate_totals",
  "btts", "correct_score", "team_totals"
]);

// .25 / .75 lines split the stake — never a clean win/loss
function isQuarterLine(point) {
  return point !== null && Math.abs(point * 4) % 2 === 1;
}

/*
  The betting line (2.5, -1, ...) wherever the frontend hid it.
  point_value is read FIRST because legacy rows stored potential
  points in `point` and the real line in `point_value`.
*/
function getLine(pick) {
  return safeNumber(
    pick.point_value ?? pick.line ?? pick.point
  );
}

/*
  Returns true, false, "void", or null.
  - true/false: settled win/loss.
  - "void": the selection is a push/refund (draw no bet draw,
    handicap push). It is settled, contributes zero points,
    and must NOT kill the ticket.
  - null: the selection cannot safely be settled.
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

  const actualResult =
    home > away ? "H" :
    home < away ? "A" :
    "D";

  if (market === "h2h" || market === "h2h_3_way") {
    const selected = normalizeH2HSelection(
      selection,
      homeName,
      awayName
    );

    if (!selected) return null;

    return selected === actualResult;
  }

  if (market === "double_chance") {
    /*
      Provider outcome names look like "Arsenal/Draw",
      "Draw/Chelsea", "Arsenal/Chelsea".
    */
    const parts = String(selection)
      .split(/\/|,| or /i)
      .map(part => normalizeH2HSelection(part, homeName, awayName))
      .filter(Boolean);

    if (!parts.length) return null;

    return parts.includes(actualResult);
  }

  if (market === "draw_no_bet") {
    const selected = normalizeH2HSelection(
      selection,
      homeName,
      awayName
    );

    if (!selected || selected === "D") return null;

    if (actualResult === "D") return "void";

    return selected === actualResult;
  }

  if (market === "totals" || market === "alternate_totals") {
    const s = normalizeText(selection);
    const total = home + away;

    let line = getLine(pick);

    if (line === null) {
      const match = s.match(/^(over|under)\s*(\d+(?:\.\d+)?)$/);
      if (!match) return null;
      line = Number(match[2]);
    }

    if (isQuarterLine(line)) return null;

    const isOver = s.startsWith("over");
    if (!isOver && !s.startsWith("under")) return null;

    if (total === line) return "void";   // push on whole-number line

    return isOver ? total > line : total < line;
  }

  if (market === "team_totals") {
    const s = normalizeText(selection);
    const line = getLine(pick);
    const team = String(pick.description ?? pick.team ?? "").trim();

    if (line === null || !team) return null;
    if (isQuarterLine(line)) return null;

    const goals =
      normalizeText(team) === normalizeText(homeName) ? home :
      normalizeText(team) === normalizeText(awayName) ? away :
      null;

    if (goals === null) return null;

    if (s.startsWith("over")) return goals > line;
    if (s.startsWith("under")) return goals < line;

    return null;
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

  if (market === "correct_score") {
    /*
      Outcome names contain an exact score such as "2-1" or
      "2:1", optionally prefixed with a team name.
    */
    const match = String(selection).match(
      /(\d+)\s*[-:]\s*(\d+)/
    );

    if (!match) return null;

    const selHome = Number(match[1]);
    const selAway = Number(match[2]);

    return selHome === home && selAway === away;
  }

  if (market === "spreads" || market === "alternate_spreads") {
    /*
      Asian handicap from the final score. Quarter lines
      (x.25 / x.75) split the stake in real betting and
      cannot be settled as a simple win/loss, so they are
      deliberately left unsettled.
    */
    const point = getLine(pick);

    if (point === null) return null;

    if (Math.abs(point * 4) % 2 === 1) {
      return null; // quarter line — half win / half loss
    }

    const selected = normalizeH2HSelection(
      selection,
      homeName,
      awayName
    );

    if (selected !== "H" && selected !== "A") return null;

    const adjustedHome = selected === "H" ? home + point : home;
    const adjustedAway = selected === "A" ? away + point : away;

    if (adjustedHome === adjustedAway) return "void";

    return adjustedHome > adjustedAway;
  }

  /*
    Every other market (half-time/second-half markets,
    corners, cards, fouls, etc.) needs data the provider's
    scores endpoint does not return, so it is never graded
    on guessed rules.
  */
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

    pick.settled = true;
    pick.final_score = readScores(event);
    pick.settled_at = new Date().toISOString();

    if (won === "void") {
      pick.result = "void";
      pick.settlement_note =
        "Selection void (push/refund). Contributes 0 points.";
      return pick;
    }

    pick.result = won ? "won" : "lost";

    if (won) {
      const odds = getSavedOdds(pick);

      if (odds === null) {
        allSettled = false;
        pick.settlement_note =
          "Final result found, but saved decimal odds are missing.";
      } else {
        totalPoints += (odds - 1) * POINTS_MULTIPLIER;
      }
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

  // ---------- card-level result: THE HOUSE RULES ----------
  const voids  = updatedPicks.filter(p => p.result === "void").length;
  const losses = updatedPicks.filter(p => p.result === "lost").length;
  const wins   = updatedPicks.filter(p => p.result === "won").length;

  let result;

  if (voids >= 2) {
    result = "lost";          // two voids = automatic lost card
    totalPoints = 0;
  } else if (losses > 0) {
    result = "lost";          // any lost pick zeroes the card
    totalPoints = 0;
  } else if (wins === 0) {
    result = "void";          // only reachable when ALL picks void
    totalPoints = 0;
  } else {
    result = "win";           // 0 or 1 void excluded from judgement
  }

  return {
    state: "graded",
    result,
    picks: updatedPicks,
    points: Math.round(totalPoints * 100) / 100
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
   CARD SUBMISSION — replaces direct browser inserts.

   The browser sends the user's Supabase JWT; we verify it
   against Supabase Auth, validate every pick against the
   auto-settleable market list, sanitize the payload (the
   server owns points/status/result), and insert with the
   service role. RLS blocks user inserts, so this endpoint
   is the ONLY way in.
------------------------------------------------------- */

async function getUserFromJwt(token) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !token) return null;

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) return null;

  return response.json();
}

app.post("/api/cards", async (req, res) => {
  try {
    const token = String(req.get("authorization") || "")
      .replace(/^Bearer\s+/i, "");

    const user = await getUserFromJwt(token);

    if (!user || !user.id) {
      return sendError(res, 401, "Not signed in.");
    }

    const rawPicks = req.body?.picks;

    if (!Array.isArray(rawPicks) || rawPicks.length === 0) {
      return sendError(res, 400, "Card must contain at least 1 pick.");
    }

    /*
      Keep ONLY the fields the scorer reads plus harmless
      display labels. Anything the client sends for
      points/status/result is discarded here.
    */
    const picks = rawPicks.map(p => {
      const marketKey = getMarketKey(p);
      const line = safeNumber(p.point_value ?? p.line ?? p.point);

      return {
        event_id: getEventId(p),
        sport_key: getSportKey(p),
        kickoff: p.kickoff ?? null,
        home: String(p.home ?? p.home_team ?? ""),
        away: String(p.away ?? p.away_team ?? ""),
        league: String(p.league ?? ""),
        market_key: marketKey,
        market_name: String(p.market_name ?? marketLabel(marketKey)),
        outcome: getSelection(p),
        selection: String(p.selection ?? ""),
        odds: getSavedOdds(p),
        price: getSavedOdds(p),
        // the line under BOTH names: legacy rows read point_value first
        ...(line !== null ? { point: line, point_value: line } : {}),
        // team name for team_totals — without it market 20 can't settle
        ...(p.description ? { description: String(p.description) } : {})
      };
    });

    for (const pick of picks) {
      if (!pick.event_id || !pick.sport_key) {
        return sendError(res, 400,
          "Pick is missing event_id or sport_key.", { pick });
      }

      if (!pick.outcome) {
        return sendError(res, 400, "Pick is missing its outcome.", { pick });
      }

      if (pick.odds === null) {
        return sendError(res, 400, "Pick has invalid decimal odds.", { pick });
      }

      if (!SETTLEABLE_MARKET_KEYS.has(pick.market_key)) {
        return sendError(res, 400,
          `Market "${pick.market_key}" is display-only and is not scored.`);
      }

      if (
        ["spreads", "alternate_spreads", "totals", "alternate_totals", "team_totals"]
          .includes(pick.market_key) &&
        pick.point !== undefined &&
        isQuarterLine(pick.point)
      ) {
        return sendError(res, 400,
          "Quarter lines (x.25 / x.75) are not scored — they split the stake.");
      }
    }

    const inserted = await supabaseRequest(TABLE, {
      method: "POST",
      prefer: "return=representation",
      body: {
        user_id: user.id,
        picks,
        point: 0,
        points: 0,
        status: "pending",
        result: null,
        points_awarded: false
      }
    });

    const card = Array.isArray(inserted) ? inserted[0] : inserted;

    res.json({ success: true, card });
  } catch (error) {
    sendError(res, 500, "Could not submit card.", {
      details: error.message
    });
  }
});

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
            status: "graded",
            result: outcome.result,
            settled_at: new Date().toISOString(),
            points_awarded: outcome.result === "win"
          }
        }
      );

      if (Array.isArray(updated) && updated.length > 0) {
        graded++;
        pointsAwarded += points;

        // audit trail — never let an audit failure break scoring
        await supabaseRequest("scoring_audit", {
          method: "POST",
          prefer: "return=minimal",
          body: {
            card_id: entry.id,
            action: "card_settled",
            details: {
              result: outcome.result,
              points,
              picks: outcome.picks.map(p => ({
                market: getMarketKey(p),
                outcome: getSelection(p),
                result: p.result ?? "pending"
              }))
            }
          }
        }).catch(() => {});
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
      `${TABLE}?status=eq.graded&select=user_id,result,points,settled_at`,
      { method: "GET" }
    );

    // profiles table may not exist yet — degrade gracefully
    let profiles = [];

    try {
      profiles = await supabaseRequest("profiles?select=user_id,username", {
        method: "GET"
      });
    } catch {
      profiles = [];
    }

    const nameOf = new Map(
      (Array.isArray(profiles) ? profiles : []).map(p => [
        p.user_id,
        p.username || `Player ${String(p.user_id).slice(0, 8)}`
      ])
    );

    const totals = new Map();
     // Add every registered user, even with zero wins and points.
for (const profile of profiles || []) {
  if (!profile.user_id) continue;

  totals.set(profile.user_id, {
    user_id: profile.user_id,
    username: profile.username ||
      `Player ${String(profile.user_id).slice(0, 8)}`,
    win_cards: 0,
    points: 0,
    first_win_at: null
  });
}

    for (const entry of entries || []) {
      const userId = entry.user_id;

      if (!userId) continue;

      const row = totals.get(userId) || {
        user_id: userId,
        username: nameOf.get(userId) || `Player ${String(userId).slice(0, 8)}`,
        win_cards: 0,
        points: 0,
        first_win_at: null
      };

      if (entry.result === "win") {
        row.win_cards += 1;
        row.points += safeNumber(entry.points) || 0;

        // earliest winning card breaks ties
        if (!row.first_win_at || entry.settled_at < row.first_win_at) {
          row.first_win_at = entry.settled_at;
        }
      }

      totals.set(userId, row);
    }

    const leaderboard = Array.from(totals.values())
      .map(row => ({
        username: row.username,
        win_cards: row.win_cards,
        points: Math.round(row.points * 100) / 100
      }))
      .sort((a, b) =>
        b.points - a.points ||
        b.win_cards - a.win_cards ||
        new Date(a.first_win_at) - new Date(b.first_win_at)
      )
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
  console.log(`Active competitions (fixtures fetched): ${ACTIVE_COMPETITIONS.length}`);
  console.log(`Nigeria prediction date: ${todayNigeria()}`);
});
  
 
