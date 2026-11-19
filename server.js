require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto"); 

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
// ---------------- HOUSE ACCOUNT AUTH ----------------

async function supabaseAuthAdminRequest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase is not configured.");
  }

  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/${path}`,
    {
      method: options.method || "GET",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body)
    }
  );

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase Auth HTTP ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}

// ---------------- HOUSE ACCOUNT SETTINGS ----------------

const HOUSE_ACCOUNT_COUNT = 19;

const HOUSE_ACCOUNT_STRATEGIES = new Set([
  "balanced",
  "favorites",
  "underdog",
  "odds_based"
]);
// ---------------- HOUSEBOT STRATEGY ENGINE ----------------

function selectHouseOutcome(outcomes, strategy) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    return null;
  }

  if (!HOUSE_ACCOUNT_STRATEGIES.has(strategy)) {
    throw new Error("Invalid HouseBot strategy.");
  }

  const valid = outcomes.filter(o => {
    const price = safeNumber(o.price);
    return o.name && price !== null && price > 1;
  });

  if (valid.length === 0) return null;

  // FAVORITES: choose the lowest available odds.
  if (strategy === "favorites") {
    return {
      ...valid.reduce((a, b) =>
        a.price <= b.price ? a : b
      )
    };
  }

  // UNDERDOG: choose the highest odds,
  // avoiding extreme odds above 8 when possible.
  if (strategy === "underdog") {
    const candidates = valid.filter(o => o.price <= 8);
    const pool = candidates.length ? candidates : valid;

    return {
      ...pool.reduce((a, b) =>
        a.price >= b.price ? a : b
      )
    };
  }

  // BALANCED: choose odds closest to 2.00.
  if (strategy === "balanced") {
    const distance = Math.min(
      ...valid.map(o => Math.abs(o.price - 2))
    );

    const candidates = valid.filter(
      o => Math.abs(o.price - 2) === distance
    );

    return {
      ...candidates[crypto.randomInt(candidates.length)]
    };
  }

  // ODDS BASED: randomly select using implied
  // probability as the selection weight.
  if (strategy === "odds_based") {
    const weights = valid.map(o =>
      Math.max(1, Math.round((1 / o.price) * 1000000))
    );

    const total = weights.reduce((sum, weight) => sum + weight, 0);

    let ticket = crypto.randomInt(total);

    for (let i = 0; i < valid.length; i++) {
      ticket -= weights[i];

      if (ticket < 0) {
        return { ...valid[i] };
      }
    }
  }

  return null;
      }
function selectHouseMarket(markets, strategy) {
  if (!markets || typeof markets !== "object") {
    return null;
  }

  // Only use the five active FootStats markets.
  const availableMarkets = MARKET_CATALOG
    .filter(m => [
      "h2h",
      "double_chance",
      "draw_no_bet",
      "alternate_totals",
      "btts"
    ].includes(m.key))
    .filter(m =>
      Array.isArray(markets[m.key]?.outcomes) &&
      markets[m.key].outcomes.length > 0
    );

  if (availableMarkets.length === 0) {
    return null;
  }

  // Randomly choose one available market.
  const market = availableMarkets[
    crypto.randomInt(availableMarkets.length)
  ];

  const outcome = selectHouseOutcome(
    markets[market.key].outcomes,
    strategy
  );

  if (!outcome) return null;

  return {
    market_key: market.key,
    market_name: market.name,
    outcome: outcome.name,
    selection: outcome.name,
    odds: outcome.price,
    price: outcome.price,
    point: outcome.point ?? null,
    point_value: outcome.point ?? null,
    description: outcome.description ?? null
  };
}
// ---------------- HOUSEBOT FIXTURE LOADER ----------------

async function getHouseBotAvailableFixtures() {
  const today = todayNigeria();
  const cacheDay = getNigeriaMarketCacheDay();

  // Load today's real cached fixtures.
  const fixtureRows = await supabaseRequest(
    `fixtures_cache?fixture_date=eq.${today}&select=event_id,sport_key,payload`,
    { method: "GET" }
  );

  // Load today's saved bookmaker market data.
  const marketQuery = new URLSearchParams({
    select: "event_id,sport_key,payload",
    regions: "eq.uk",
    and: `(fetched_at.gte.${cacheDay.start},fetched_at.lt.${cacheDay.end})`
  });

  const marketRows = await supabaseRequest(
    `match_markets_cache?${marketQuery.toString()}`,
    { method: "GET" }
  );

  const marketMap = new Map(
    (marketRows || []).map(row => [
      `${row.sport_key}|${row.event_id}`,
      row.payload
    ])
  );

  const now = Date.now();
  const available = [];

  for (const row of fixtureRows || []) {
    const fixture = row.payload;

    if (!fixture || fixture.cache_marker) continue;

    if (!fixture.event_id || !fixture.sport_key || !fixture.kickoff) {
      continue;
    }

    // Never select matches that have already started.
    if (new Date(fixture.kickoff).getTime() <= now) {
      continue;
    }

    const marketPayload = marketMap.get(
      `${row.sport_key}|${row.event_id}`
    );

    const cachedMarkets = marketPayload?.markets || {}; 

    available.push({
      ...fixture,
      markets: cachedMarkets 
    });
  }

  return available;
 }
// ---------------- HOUSEBOT PREDICTION GENERATOR ----------------

async function generateHouseBotPicks(userId, strategy) {
  if (!HOUSE_ACCOUNT_STRATEGIES.has(strategy)) {
    throw new Error("Invalid HouseBot strategy.");
  }

  const [fixtures, previousEntries] = await Promise.all([
    getHouseBotAvailableFixtures(),
    supabaseRequest(
      `${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=picks`,
      { method: "GET" }
    )
  ]);

  const usedEventIds = new Set();

  for (const entry of previousEntries || []) {
    for (const pick of Array.isArray(entry.picks) ? entry.picks : []) {
      const eventId = getEventId(pick);
      if (eventId) usedEventIds.add(eventId);
    }
  }

  const activeMarketKeys = [
    "h2h",
    "double_chance",
    "draw_no_bet",
    "alternate_totals",
    "btts"
  ];

  const eligibleFixtures = fixtures.filter(fixture =>
    fixture.event_id &&
    fixture.sport_key &&
    !usedEventIds.has(fixture.event_id)
  );

  const results = await Promise.all(
    eligibleFixtures.map(async fixture => {
      // Each bot independently chooses a market for this match.
      const marketKey =
        activeMarketKeys[crypto.randomInt(activeMarketKeys.length)];

      // Reuse the normal fixture market cache when available.
      let market = fixture.markets?.[marketKey];

      // Otherwise, use the shared HouseBot market fetcher.
      if (!market?.outcomes?.length) {
        let fetchedMarkets = {};

try {
  fetchedMarkets = await fetchHouseBotMarkets(
    fixture.sport_key,
    fixture.event_id,
    "uk",
    [marketKey]
  );
} catch (error) {
  console.warn(
    `HouseBot market fetch failed for ${fixture.event_id}:`,
    error.message
  );

  return null;
}

market = fetchedMarkets[marketKey]; 

        market = fetchedMarkets[marketKey];
      }

      if (!market?.outcomes?.length) {
        return null;
      }

      // Keep the existing strategy-based outcome selection.
      const selected = selectHouseMarket(
        { [marketKey]: market },
        strategy
      );

      if (!selected) return null;

      return {
        event_id: fixture.event_id,
        sport_key: fixture.sport_key,
        kickoff: fixture.kickoff,
        home: fixture.home || fixture.home_team || "",
        away: fixture.away || fixture.away_team || "",
        league: fixture.league || fixture.sport_title || "",
        market_key: selected.market_key,
        market_name: selected.market_name,
        outcome: selected.outcome,
        selection: selected.selection,
        odds: selected.odds,
        price: selected.price,
        point_value: selected.point_value,
        description: selected.description
      };
    })
  );

  const picks = results.filter(Boolean);

  if (picks.length < 3) {
    throw new Error(
      `Only ${picks.length} eligible matches available. At least 3 are required.`
    );
  }

  return picks;
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

  const today = `${values.year}-${values.month}-${values.day}`;

  const [year, month, day] = today.split("-").map(Number);

  const tomorrowDate = new Date(
    Date.UTC(year, month - 1, day + 1)
  );

  const tomorrow = tomorrowDate.toISOString().slice(0, 10);

  return {
    start: new Date(`${today}T00:00:00+01:00`).toISOString(),
    end: new Date(`${tomorrow}T00:00:00+01:00`).toISOString()
  };
}
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
    `Supabase HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`
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
const today = `${values.year}-${values.month}-${values.day}`;  
const start = new Date(`${today}T00:00:00+01:00`); 
const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

return {
start: start.toISOString(),
end: end.toISOString()
};
} 


/* -------------------------------------------------------
   MARKET REFERENCE CATALOGUE — THE 5 FOOTBALL MARKETS

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
  /* A. Match result markets */
  {
    key: "h2h",
    name: "Match Winner (1X2)",
    group: "match_result",
    endpoint: "featured",
    supported: true
  },
  {
    key: "double_chance",
    name: "Double Chance",
    group: "match_result",
    endpoint: "event",
    supported: true
  },
  {
    key: "draw_no_bet",
    name: "Draw No Bet",
    group: "match_result",
    endpoint: "event",
    supported: true
  },

  /* B. Goal markets */
  {
    key: "alternate_totals",
    name: "Alternative Over/Under",
    group: "goals",
    endpoint: "event",
    supported: true
  },
  {
    key: "btts",
    name: "Both Teams to Score",
    group: "goals",
    endpoint: "event",
    supported: true
  }
];

const MARKET_GROUPS = [
  { id: "match_result", title: "Match Result" },
  { id: "goals", title: "Goals" }
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
// ---------------- HOUSEBOT MARKET CACHE HELPERS ----------------

// Read one market from the shared HouseBot cache.
async function readHouseBotMarketCache(
  sport,
  eventId,
  regions,
  marketKey
) {
  const cacheQuery = new URLSearchParams({
    select: "payload",
    sport_key: `eq.${sport}`,
    event_id: `eq.${eventId}`,
    regions: `eq.${regions}`,
    market_key: `eq.${marketKey}`,
    cache_day: `eq.${todayNigeria()}`
  });

  const rows = await supabaseRequest(
    `housebot_market_cache?${cacheQuery.toString()}`,
    { method: "GET" }
  );

  return rows?.length ? rows[0].payload : null;
}


// Save one market so all HouseBots can reuse it.
async function saveHouseBotMarketCache(
  sport,
  eventId,
  regions,
  marketKey,
  payload
) {
  return await supabaseRequest(
    "housebot_market_cache?on_conflict=sport_key,event_id,regions,market_key,cache_day",
    {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        sport_key: sport,
        event_id: eventId,
        regions,
        market_key: marketKey,
        cache_day: todayNigeria(),
        payload,
        fetched_at: new Date().toISOString()
      }
    }
  );
}
// ---------------- HOUSEBOT TARGETED MARKET FETCHER ----------------

async function fetchHouseBotMarketsNow( 
  sport,
  eventId,
  regions,
  requestedMarketKeys
) {
  const marketKeys = [
    ...new Set(
      requestedMarketKeys.filter(key =>
        REQUESTABLE_MARKET_KEYS.includes(key)
      )
    )
  ];

  const markets = {};

  // First, check the shared HouseBot cache.
  const cachedResults = await Promise.all(
    marketKeys.map(async key => ({
      key,
      payload: await readHouseBotMarketCache(
        sport,
        eventId,
        regions,
        key
      )
    }))
  );

  const missingKeys = [];

  for (const item of cachedResults) {
    if (item.payload) {
      markets[item.key] = item.payload;
    } else {
      missingKeys.push(item.key);
    }
  }

  // Everything is already cached.
  if (!missingKeys.length) {
    return markets;
  }

  // Fetch only the missing markets.
  const result = await fetchBatchResilient(
    sport,
    eventId,
    regions,
    missingKeys
  );

  // Combine bookmaker responses.
  const mergedBookmakers = new Map();

  for (const data of result.events) {
    for (const bookmaker of data.bookmakers || []) {
      const bookmakerKey =
        bookmaker.key || bookmaker.title || "unknown";

      if (!mergedBookmakers.has(bookmakerKey)) {
        mergedBookmakers.set(bookmakerKey, {
          key: bookmaker.key,
          title: bookmaker.title,
          markets: []
        });
      }

      mergedBookmakers.get(bookmakerKey).markets.push(
        ...(bookmaker.markets || [])
      );
    }
  }

  const normalizedMarkets = getBestMarkets({
    bookmakers: Array.from(mergedBookmakers.values())
  });

 // Save each returned market separately.
for (const key of missingKeys) {
  const market = normalizedMarkets[key];

  if (!market || !market.outcomes?.length) {
    continue;
  }

  // Keep the fetched market even if cache saving fails.
  markets[key] = market;

  try {
    await saveHouseBotMarketCache(
      sport,
      eventId,
      regions,
      key,
      market
    );
  } catch (error) {
    console.warn(
      `HouseBot cache save failed for ${eventId} (${key}):`,
      error.message
    );
  }
} 

  return markets;
 }
// ---------------- HOUSEBOT SHARED MARKET REQUEST COORDINATOR ----------------

const houseBotMarketPendingBatches = new Map();
const houseBotMarketInFlight = new Map();

async function fetchHouseBotMarkets(
  sport,
  eventId,
  regions,
  requestedMarketKeys
) {
  const marketKeys = [
    ...new Set(
      requestedMarketKeys.filter(key =>
        REQUESTABLE_MARKET_KEYS.includes(key)
      )
    )
  ];

  if (!marketKeys.length) return {};

  const matchId = `${sport}|${eventId}|${regions}`;
  const marketPromises = [];

  for (const marketKey of marketKeys) {
    const requestId = `${matchId}|${marketKey}`;

    // Reuse a market request already being processed.
    if (houseBotMarketInFlight.has(requestId)) {
      marketPromises.push(
        houseBotMarketInFlight.get(requestId).then(
          market => ({ key: marketKey, market })
        )
      );
      continue;
    }

    let resolveMarket;
    let rejectMarket;

    const marketPromise = new Promise((resolve, reject) => {
      resolveMarket = resolve;
      rejectMarket = reject;
    });

    houseBotMarketInFlight.set(requestId, marketPromise);

    let batch = houseBotMarketPendingBatches.get(matchId);

    if (!batch) {
      batch = {
        sport,
        eventId,
        regions,
        markets: new Map(),
        timer: null
      };

      houseBotMarketPendingBatches.set(matchId, batch);
    }

    batch.markets.set(marketKey, {
      resolve: resolveMarket,
      reject: rejectMarket
    });

    marketPromises.push(
      marketPromise.then(market => ({
        key: marketKey,
        market
      }))
    );

    // Give other bots a short window to add their markets.
    if (!batch.timer) {
      batch.timer = setTimeout(async () => {
        houseBotMarketPendingBatches.delete(matchId);

        const entries = Array.from(batch.markets.entries());
        const keys = entries.map(([key]) => key);

        try {
          const results = await fetchHouseBotMarketsNow(
            batch.sport,
            batch.eventId,
            batch.regions,
            keys
          );

          for (const [key, handlers] of entries) {
            const requestId = `${matchId}|${key}`;

            houseBotMarketInFlight.delete(requestId);
            handlers.resolve(results[key] || null);
          }
        } catch (error) {
          for (const [key, handlers] of entries) {
            const requestId = `${matchId}|${key}`;

            houseBotMarketInFlight.delete(requestId);
            handlers.reject(error);
          }
        }
      }, 50);
    }
  }

  const results = await Promise.all(marketPromises);
  const markets = {};

  for (const item of results) {
    if (item.market) {
      markets[item.key] = item.market;
    }
  }

  return markets;  
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
        "Selection void. Associated odds excluded from points calculation.";
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

  // ---------- CARD-LEVEL RESULT ----------

  const losses = updatedPicks.filter(
    p => p.result === "lost"
  ).length;

  const wins = updatedPicks.filter(
    p => p.result === "won"
  ).length;

  let result;

  if (losses > 0) {
    result = "lost";
    totalPoints = 0;
  } else if (wins === 0) {
    result = "void";
    totalPoints = 0;
  } else {
    result = "win";
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
  console.log("[CARDS] Submission request received", {
  picksCount: Array.isArray(req.body?.picks)
    ? req.body.picks.length
    : 0,
  time: new Date().toISOString()
}); 
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

    const marketCacheDay = getNigeriaMarketCacheDay();

    const verifiedCache = new Map();

    const picks = rawPicks.map(p => {
     const marketKey = getMarketKey(p);

  const line = marketKey === "alternate_totals"
  ? safeNumber(p.point_value ?? p.line ?? p.point)
  : null;  

      return {
        event_id: getEventId(p),
        sport_key: getSportKey(p),
        kickoff: p.kickoff ?? null,
        home: String(p.home ?? p.home_team ?? ""),
        away: String(p.away ?? p.away_team ?? ""),
        league: String(p.league ?? ""),
        market_key: marketKey,
        market_name: String(
          p.market_name ?? marketLabel(marketKey)
        ),
        outcome: getSelection(p),
        selection: String(p.selection ?? ""),
        point: line,
        point_value: line,
        description: p.description
          ? String(p.description)
          : null
      };
    });

    for (const pick of picks) {
      if (!pick.event_id || !pick.sport_key) {
       console.error("[CARDS] REJECTED: Missing event_id or sport_key.");  
        return sendError(
          res,
          400,
          "Pick is missing event_id or sport_key."
        );
      }

      if (!pick.outcome) {
  console.error("[CARDS] REJECTED: Pick is missing its outcome.");
  return sendError(
    res,
    400,
    "Pick is missing its outcome."
  );
} 

      if (!SETTLEABLE_MARKET_KEYS.has(pick.market_key)) {
        console.error("[CARDS] REJECTED: Unsupported market:", pick.market_key); 
        return sendError(
          res,
          400,
          `Market "${pick.market_key}" is display-only and is not scored.`
        );
      }

      if (
        [
          "spreads",
          "alternate_spreads",
          "totals",
          "alternate_totals",
          "team_totals"
        ].includes(pick.market_key) &&
        pick.point !== null &&
        isQuarterLine(pick.point)
      ) {
        return sendError(
          res,
          400,
          "Quarter lines (x.25 / x.75) are not scored — they split the stake."
        );
      }

      const cacheKey =
        `${pick.sport_key}|${pick.event_id}|uk`;

      if (!verifiedCache.has(cacheKey)) {
        const query = new URLSearchParams({
          select: "payload",
          event_id: `eq.${pick.event_id}`,
          sport_key: `eq.${pick.sport_key}`,
          regions: "eq.uk",
          and: `(fetched_at.gte.${marketCacheDay.start},fetched_at.lt.${marketCacheDay.end})`
        });

        const rows = await supabaseRequest(
          `match_markets_cache?${query.toString()}`
        );

        if (!Array.isArray(rows) || rows.length === 0) {
          return sendError(
            res,
            400,
            "Cannot verify this match's odds. Please refresh the market and try again."
          );
        }

        verifiedCache.set(
          cacheKey,
          rows[0].payload
        );
      }

      const savedPayload = verifiedCache.get(cacheKey);

      const savedMarket =
        savedPayload?.markets?.[pick.market_key];

      if (!savedMarket || !Array.isArray(savedMarket.outcomes)) {
        return sendError(
          res,
          400,
          "This market could not be verified. Please refresh and try again."
        );
      }

      const submittedLine = pick.point;
      const submittedDescription = normalizeText(
        pick.description || ""
      );

      const verifiedOutcome = savedMarket.outcomes.find(o => {
        const sameName =
          normalizeText(o.name) === normalizeText(pick.outcome);

        const savedLine =
          o.point == null || o.point === ""
            ? null
            : safeNumber(o.point);

        const sameLine = savedLine === submittedLine;

        const savedDescription = normalizeText(
          o.description || ""
        );

        const sameDescription =
          savedDescription === submittedDescription;

        return sameName && sameLine && sameDescription;
      });

      if (!verifiedOutcome) {
       console.error("[CARDS] REJECTED: Selection does not match cached odds.", {
  market: pick.market_key,
  outcome: pick.outcome,
  point: pick.point
});  
        return sendError(
          res,
          400,
          "This selection or betting line does not match the saved market. Please refresh your odds."
        );
      }

      const trustedOdds = safeNumber(verifiedOutcome.price);

      if (trustedOdds === null || trustedOdds <= 1) {
        return sendError(
          res,
          400,
          "The saved odds for this selection are invalid."
        );
      }

      // Always save backend-verified odds.
      // Never use odds supplied by the user's phone.
      pick.odds = trustedOdds;
      pick.price = trustedOdds;
    }

    console.log("[CARDS] All picks verified. Attempting to save card."); 
    const card = await supabaseRequest(
      "rpc/submit_prediction_card",
      {
        method: "POST",
        body: {
          p_user_id: user.id,
          p_picks: picks
        }
      }
    );

    // Check whether this submission qualifies a referral reward.
    let referralRewardAwarded = false;

    try {
      referralRewardAwarded = await supabaseRequest(
        "rpc/award_referral_if_qualified",
        {
          method: "POST",
          body: {
            p_referred_user_id: user.id
          }
        }
      );
    } catch (referralError) {
      console.error(
        "Referral reward check failed:",
        referralError.message
      );
    }

    res.json({
      success: true,
      card,
      referralRewardAwarded:
        referralRewardAwarded === true
    });

  } catch (error) {
    console.error("[CARDS] SUBMISSION FAILED:", error.message);
console.error("[CARDS] ERROR DETAILS:", error.stack); 
    const status = error.message?.includes("Supabase HTTP 400")
      ? 400
      : 500;

    sendError(res, status, "Could not submit card.", {
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
function getWeeklyCompetitionPeriod(referenceDate = new Date()) {
  const now = referenceDate; 
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const get = type => Number(
    parts.find(p => p.type === type).value
  );

  const year = get("year");
  const month = get("month");
  const day = get("day");

  const todayUTC = new Date(Date.UTC(year, month - 1, day));
  const daysSinceSaturday = (todayUTC.getUTCDay() + 1) % 7;

  const start = new Date(
    Date.UTC(year, month - 1, day - daysSinceSaturday, -1)
  );

  const end = new Date(
    start.getTime() + 7 * 24 * 60 * 60 * 1000
  );

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
} 
// ---------------- ADMIN SECURITY ----------------

async function verifyAdmin(req) {
const adminId = process.env.ADMIN_USER_ID;

if (!adminId) {
throw new Error("ADMIN_USER_ID is not configured.");
}

const authorization = String(req.headers.authorization || "");
const token = authorization.startsWith("Bearer ")
? authorization.slice(7).trim()
: "";

if (!token) {
throw new Error("Authentication required.");
}

const user = await getUserFromJwt(token);

if (!user || user.id !== adminId) {
throw new Error("Administrator access denied.");
}

return user;
}

// ---------------- VIEW USERS ----------------

app.get("/api/admin/users", async (req, res) => {
try {
await verifyAdmin(req);

const users = await supabaseRequest(
  "profiles?select=user_id,username&order=username.asc",
  { method: "GET" }
);

res.json({
  success: true,
  count: users.length,
  users
});

} catch (error) {
sendError(res, 403, "Administrator access denied.", {
details: error.message
});
}
});
// ---------------- ADMIN ADJUSTMENT HISTORY ----------------

app.get("/api/admin/adjustments", async (req, res) => {
  try {
    await verifyAdmin(req);

    const adjustments = await supabaseRequest(
      "admin_user_adjustments?select=id,target_user_id,admin_user_id,points_delta,win_cards_delta,reason,created_at&order=created_at.desc&limit=100",
      { method: "GET" }
    );

    const profiles = await supabaseRequest(
      "profiles?select=user_id,username",
      { method: "GET" }
    );

    const usernames = new Map(
      (profiles || []).map(p => [p.user_id, p.username])
    );

    const history = (adjustments || []).map(item => ({
      ...item,
      username: usernames.get(item.target_user_id) || "Unknown user"
    }));

    res.json({
      success: true,
      count: history.length,
      adjustments: history
    });

  } catch (error) {
    sendError(res, 403, "Could not load administrator history.", {
      details: error.message
    });
  }
});

// ---------------- ADJUST USER POINTS AND WIN CARDS ----------------

app.post("/api/admin/adjust-user", async (req, res) => {
try {
const admin = await verifyAdmin(req);

const targetUserId = String(
  req.body.target_user_id || ""
).trim();

const pointsDelta = req.body.points_delta ?? 0;
const winCardsDelta = req.body.win_cards_delta ?? 0;
const reason = String(req.body.reason || "").trim();

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
  return sendError(res, 400, "Invalid target user ID.");
}

if (
  !Number.isSafeInteger(pointsDelta) ||
  !Number.isSafeInteger(winCardsDelta)
) {
  return sendError(res, 400, "Points and win cards must be whole numbers.");
}

if (pointsDelta === 0 && winCardsDelta === 0) {
  return sendError(res, 400, "Enter points or win cards to adjust.");
}

if (!reason || reason.length > 300) {
  return sendError(res, 400, "Enter a reason (maximum 300 characters).");
}

const profiles = await supabaseRequest(
  `profiles?user_id=eq.${targetUserId}&select=user_id,username`,
  { method: "GET" }
);

if (!profiles.length) {
  return sendError(res, 404, "User not found.");
}

const adjustment = await supabaseRequest(
  "admin_user_adjustments",
  {
    method: "POST",
    body: {
      target_user_id: targetUserId,
      admin_user_id: admin.id,
      points_delta: pointsDelta,
      win_cards_delta: winCardsDelta,
      reason
    }
  }
);

res.json({
  success: true,
  message: "User adjustment recorded.",
  user: profiles[0],
  adjustment: adjustment[0]
});

} catch (error) {
sendError(res, 403, "Could not complete administrator adjustment.", {
details: error.message
});
}
});
// ---------------- VIEW HOUSE ACCOUNTS ----------------

app.get("/api/admin/house-accounts", async (req, res) => {
  try {
    await verifyAdmin(req);

    const [accounts, profiles] = await Promise.all([
      supabaseRequest(
        "house_accounts?select=user_id,is_active,strategy,settings,prize_eligible,created_at,updated_at&order=created_at.asc",
        { method: "GET" }
      ),
      supabaseRequest(
        "profiles?select=user_id,username",
        { method: "GET" }
      )
    ]);

    const usernames = new Map(
      (profiles || []).map(p => [p.user_id, p.username])
    );

    const result = (accounts || []).map(account => ({
      ...account,
      username: usernames.get(account.user_id) || "Unknown house account"
    }));

    res.json({
      success: true,
      count: result.length,
      accounts: result
    });

  } catch (error) {
    sendError(res, 403, "Could not load house accounts.", {
      details: error.message
    });
  }
});
// ---------------- INITIALIZE 19 HOUSE ACCOUNTS ----------------

app.post("/api/admin/house-accounts/initialize", async (req, res) => {
  try {
    const admin = await verifyAdmin(req); 

    const [profiles, houseAccounts] = await Promise.all([
      supabaseRequest(
        "profiles?select=user_id,username",
        { method: "GET" }
      ),
      supabaseRequest(
        "house_accounts?select=user_id,settings",
        { method: "GET" }
      )
    ]);

    const profileByUsername = new Map(
      (profiles || []).map(p => [
        String(p.username || "").toLowerCase(),
        p
      ])
    );

    const houseUserIds = new Set(
  (houseAccounts || []).map(a => a.user_id)
);

const houseAccountNumbers = new Set(
  (houseAccounts || [])
    .map(a => Number(a.settings?.bot_number))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= HOUSE_ACCOUNT_COUNT)
); 

    const created = [];
    const skipped = [];

    for (let i = 1; i <= HOUSE_ACCOUNT_COUNT; i++) {
      const username = `HouseBot${String(i).padStart(2, "0")}`;
      const email = `${username.toLowerCase()}@footstats.invalid`;
      if (houseAccountNumbers.has(i)) {
       skipped.push(username);
       continue;
      }

      const existingProfile = profileByUsername.get(
        username.toLowerCase()
      );

      if (existingProfile) {
        if (houseUserIds.has(existingProfile.user_id)) {
          skipped.push(username);
          continue;
        }

        throw new Error(
          `${username} already exists but is not registered as a house account.`
        );
      }

      const password = crypto.randomBytes(36).toString("base64url");

      const authUser = await supabaseAuthAdminRequest("users", {
        method: "POST",
        body: {
          email,
          password,
          email_confirm: true,
          user_metadata: {
          account_type: "house",
          username: username,
          display_name: username
          } 
        }
      });

      const userId = authUser?.id || authUser?.user?.id;

      if (!userId) {
        throw new Error(`Could not obtain the ID for ${username}.`);
      }

      try {
        const existingUserProfile = await supabaseRequest(
          `profiles?user_id=eq.${userId}&select=user_id`,
          { method: "GET" }
        );

        // An Auth trigger may already have created this profile.
        if (!existingUserProfile || existingUserProfile.length === 0) {
          await supabaseRequest("profiles", {
            method: "POST",
            body: {
              user_id: userId,
              username
            }
          });
        }

               await supabaseRequest("house_accounts", {
          method: "POST",
          body: {
            user_id: userId,
            is_active: true,
            strategy: "balanced",
            settings: {
            bot_number: i
            }, 
            prize_eligible: false,
            created_by: admin.id
           } 
        }); 

        created.push(username);
        houseUserIds.add(userId);
        houseAccountNumbers.add(i); 

      } catch (error) {
        // Clean up the profile and Auth user if setup fails.
        try {
          await supabaseRequest(
            `profiles?user_id=eq.${userId}`,
            { method: "DELETE", prefer: "return=minimal" }
          );
        } catch {}

        try {
          await supabaseAuthAdminRequest(`users/${userId}`, {
            method: "DELETE"
          });
        } catch {}

        throw new Error(
          `Failed to set up ${username}: ${error.message}`
        );
      }
    }

    res.json({
      success: true,
      message: "House account initialization completed.",
      created_count: created.length,
      skipped_count: skipped.length,
      created,
      skipped,
      prize_eligible: false
    });

  } catch (error) {
    sendError(res, 400, "Could not initialize house accounts.", {
      details: error.message
    });
  }
});
// ---------------- UPDATE HOUSE ACCOUNT ----------------

app.patch("/api/admin/house-accounts/:userId", async (req, res) => {
  try {
    await verifyAdmin(req);

    const userId = String(req.params.userId || "").trim();
    const { username, is_active, strategy } = req.body || {};

    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      return sendError(res, 400, "Invalid house account ID.");
    }

    const updates = {};

    if (username !== undefined) {
      const cleanUsername = String(username).trim();

      if (!/^[a-zA-Z0-9_]{3,24}$/.test(cleanUsername)) {
        return sendError(
          res,
          400,
          "Username must be 3–24 characters using letters, numbers or underscores."
        );
      }

      const profiles = await supabaseRequest(
        "profiles?select=user_id,username",
        { method: "GET" }
      );

      const duplicate = (profiles || []).some(profile =>
        String(profile.username).toLowerCase() === cleanUsername.toLowerCase() &&
        profile.user_id !== userId
      );

      if (duplicate) {
        return sendError(res, 409, "That username is already taken.");
      }

      updates.username = cleanUsername;
    }

    if (is_active !== undefined) {
      if (typeof is_active !== "boolean") {
        return sendError(res, 400, "is_active must be true or false.");
      }

      updates.is_active = is_active;
    }

    if (strategy !== undefined) {
      if (!HOUSE_ACCOUNT_STRATEGIES.has(strategy)) {
        return sendError(res, 400, "Invalid house account strategy.");
      }

      updates.strategy = strategy;
    }

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, "No valid changes supplied.");
    }

    const existing = await supabaseRequest(
      `house_accounts?user_id=eq.${encodeURIComponent(userId)}&select=user_id`,
      { method: "GET" }
    );

    if (!existing || existing.length === 0) {
      return sendError(res, 404, "House account not found.");
    }

    if (updates.username !== undefined) {
      await supabaseRequest(
        `profiles?user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          body: { username: updates.username }
        }
      );
    }

    const houseUpdates = {};

    if (updates.is_active !== undefined) {
      houseUpdates.is_active = updates.is_active;
    }

    if (updates.strategy !== undefined) {
      houseUpdates.strategy = updates.strategy;
    }

    if (Object.keys(houseUpdates).length > 0) {
      houseUpdates.updated_at = new Date().toISOString();

      await supabaseRequest(
        `house_accounts?user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          body: houseUpdates
        }
      );
    }

    res.json({
      success: true,
      message: "House account updated successfully.",
      user_id: userId,
      changes: updates
    });

  } catch (error) {
    sendError(res, 400, "Could not update house account.", {
      details: error.message
    });
  }
});
async function submitHouseBotCard(account) {
  const userId = account.user_id;

  if (!account.is_active) {
    throw new Error("This HouseBot is currently paused.");
  }

  if (account.prize_eligible !== false) {
    throw new Error("HouseBots cannot be prize eligible.");
  }

  if (!HOUSE_ACCOUNT_STRATEGIES.has(account.strategy)) {
    throw new Error("HouseBot has an invalid strategy.");
  }

  const picks = await generateHouseBotPicks(
    userId,
    account.strategy
  );

  const result = await supabaseRequest(
    "rpc/submit_prediction_card",
    {
      method: "POST",
      body: {
        p_user_id: userId,
        p_picks: picks
      }
    }
  );

  return {
    user_id: userId,
    strategy: account.strategy,
    picks_count: picks.length,
    result
  };
} 
// ---------------- HOUSEBOT PREDICTION SUBMISSION ----------------

app.post("/api/admin/house-accounts/:userId/submit", async (req, res) => {
  try {
    // Only a verified admin can trigger HouseBot submissions.
    await verifyAdmin(req);

    const userId = req.params.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "HouseBot user ID is required."
      });
    }

    // Confirm this is a registered HouseBot.
    const accounts = await supabaseRequest(
      `house_accounts?user_id=eq.${encodeURIComponent(userId)}&select=user_id,is_active,strategy,prize_eligible`,
      { method: "GET" }
    );

    const account = accounts?.[0];

    if (!account) {
      return res.status(404).json({
        success: false,
        error: "HouseBot account not found."
      });
    }

    if (!account.is_active) {
      return res.status(400).json({
        success: false,
        error: "This HouseBot is currently paused."
      });
    }

    if (account.prize_eligible !== false) {
      return res.status(403).json({
        success: false,
        error: "HouseBots cannot be prize eligible."
      });
    }

    if (!HOUSE_ACCOUNT_STRATEGIES.has(account.strategy)) {
      return res.status(400).json({
        success: false,
        error: "HouseBot has an invalid strategy."
      });
    }

    const submission = await submitHouseBotCard(account); 

    return res.json({
      success: true,
      message: "HouseBot prediction card submitted.",
      user_id: userId,
      strategy: account.strategy,
      picks_count: submission.picks_count,
      result: submission.result 
    });

  } catch (error) {
    console.error("HouseBot submission error:", error);

    return res.status(400).json({
      success: false,
      error: error.message || "HouseBot submission failed."
    });
  }
});
// ---------------- HOUSE ACCOUNT MANAGEMENT ----------------

app.get("/api/admin/house-accounts", async (req, res) => {
  try {
    await verifyAdmin(req);

    const [accounts, profiles] = await Promise.all([
      supabaseRequest(
        "house_accounts?select=user_id,is_active,strategy,settings,prize_eligible,created_at,updated_at&order=created_at.asc",
        { method: "GET" }
      ),
      supabaseRequest(
        "profiles?select=user_id,username",
        { method: "GET" }
      )
    ]);

    const usernames = new Map(
      (profiles || []).map(p => [p.user_id, p.username])
    );

    const result = (accounts || []).map(account => ({
      ...account,
      username: usernames.get(account.user_id) || "Unknown house account"
    }));

    res.json({
      success: true,
      count: result.length,
      accounts: result
    });

  } catch (error) {
    sendError(res, 403, "Could not load house accounts.", {
      details: error.message
    });
  }
});
app.get("/api/leaderboard", async (req, res) => {
  try {
    const requestedDate = String(req.query.weekDate || "").trim();

let referenceDate = new Date();

if (requestedDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return sendError(res, 400, "Invalid week date. Use YYYY-MM-DD.");
  }

  referenceDate = new Date(`${requestedDate}T12:00:00Z`);

if (
  Number.isNaN(referenceDate.getTime()) ||
  referenceDate.toISOString().slice(0, 10) !== requestedDate
) {
  return sendError(res, 400, "Invalid week date.");
} 
}

const period = getWeeklyCompetitionPeriod(referenceDate); 
    const entries = await supabaseRequest(
  `${TABLE}?created_at=gte.${period.start}&created_at=lt.${period.end}&select=user_id,result,points,settled_at,created_at,status`,
  { method: "GET" }
); 
const referralRewards = await supabaseRequest(
  `referral_rewards?awarded_at=gte.${period.start}&awarded_at=lt.${period.end}&select=referrer_user_id,points,awarded_at`,
  { method: "GET" }
);
  const adminAdjustments = await supabaseRequest(
  `admin_user_adjustments?created_at=gte.${period.start}&created_at=lt.${period.end}&select=target_user_id,points_delta,win_cards_delta,created_at`,
  { method: "GET" }
);   
  const unsettledCards = (entries || []).filter(
  entry => entry.status !== "graded"
).length;

const weekEnded = Date.now() >= new Date(period.end).getTime();

const isFinal = weekEnded && unsettledCards === 0;   
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
// Add referral points
for (const reward of referralRewards || []) {
  const userId = reward.referrer_user_id;
  if (!userId) continue;

  const row = totals.get(userId);

  if (row) {
    row.points += safeNumber(reward.points) || 0;
  }
}

// Add administrator adjustments
for (const adjustment of adminAdjustments || []) {
  const userId = adjustment.target_user_id;
  if (!userId) continue;

  const row = totals.get(userId);
  if (!row) continue;

  row.points += safeNumber(adjustment.points_delta) || 0;
  row.win_cards += safeNumber(adjustment.win_cards_delta) || 0;

  if (
    (safeNumber(adjustment.win_cards_delta) || 0) > 0 &&
    (!row.first_win_at ||
      adjustment.created_at < row.first_win_at)
  ) {
    row.first_win_at = adjustment.created_at;
  }
}
    const leaderboard = Array.from(totals.values())
  .sort((a, b) =>
    b.points - a.points ||
    b.win_cards - a.win_cards ||
    (a.first_win_at ? new Date(a.first_win_at).getTime() : Infinity) -
    (b.first_win_at ? new Date(b.first_win_at).getTime() : Infinity)
  )
  .map((row, index) => ({
    rank: index + 1,
    username: row.username,
    win_cards: row.win_cards,
    points: Math.round(row.points * 100) / 100
  })); 

    res.json({
  success: true,
  period,
  weekEnded,
  isFinal,
  unsettledCards,
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
  
 
