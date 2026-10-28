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
    if (item.type !== "literal") p[item.type] = item.value;
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
    if (item.type !== "literal") p[item.type] = item.value;
  }

  return `${p.year}-${p.month}-${p.day}`;
}

function isTodayNigeria(value) {
  return dateInNigeria(value) === todayNigeria();
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

function getKickoff(pick) {
  return pick.kickoff || pick.commence_time || pick.date || null;
}

/* -------------------------------------------------------
   EXTERNAL API HELPERS
------------------------------------------------------- */

async function oddsRequest(path, params = {}) {
  if (!ODDS_API_KEY) {
    throw new Error("ODDS_API_KEY is missing in Render environment variables.");
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

  if (!response.ok) {
    const message =
      data.message ||
      data.error ||
      `The Odds API returned HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return {
    data,
    remaining: response.headers.get("x-requests-remaining"),
    used: response.headers.get("x-requests-used"),
    last: response.headers.get("x-requests-last")
  };
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
   ODDS NORMALIZATION
------------------------------------------------------- */

function marketLabel(key) {
  const labels = {
    h2h: "Match Result",
    totals: "Over/Under",
    btts: "Both Teams to Score",
    spreads: "Handicap",
    draw_no_bet: "Draw No Bet",
    double_chance: "Double Chance",
    h2h_3_way: "Home / Draw / Away"
  };

  return labels[key] || key.replace(/_/g, " ");
}

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

        // Keep the highest valid price found for each outcome.
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

    // Compatibility with the existing frontend.
    odds: {
      home: homeOdds,
      draw: drawOdds,
      away: awayOdds
    },
    home_odds: homeOdds,
    draw_odds: drawOdds,
    away_odds: awayOdds,

    // Full markets and prices actually returned by the provider.
    markets,
    market_list: marketArray
  };
}

/* -------------------------------------------------------
   API ROUTES
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
      "/api/fixtures",
      "/api/scores",
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
    oddsConfigured: Boolean(ODDS_API_KEY),
    supabaseConfigured: Boolean(
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    )
  });
});

app.get("/api/diagnostic", async (req, res) => {
  res.json({
    success: true,
    provider: "The Odds API",
    timezone: TZ,
    predictionDate: todayNigeria(),
    oddsApiKeyConfigured: Boolean(ODDS_API_KEY),
    supabaseConfigured: Boolean(
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ),
    scoringSecretConfigured: Boolean(SCORING_SECRET)
  });
});

app.get("/api/odds/sports", async (req, res) => {
  try {
    const result = await oddsRequest("/sports", {
      all: "false"
    });

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
    sendError(res, error.status || 502, error.message);
  }
});

app.get("/api/competitions", async (req, res) => {
  try {
    const result = await oddsRequest("/sports", {
      all: "false"
    });

    const competitions = (result.data || [])
      .filter(sport =>
        sport.active !== false &&
        String(sport.key).startsWith("soccer_")
      )
      .map(sport => ({
        id: sport.key,
        key: sport.key,
        name: sport.title,
        title: sport.title,
        group: sport.group
      }));

    res.json({
      success: true,
      provider: "The Odds API",
      competitionsReturned: competitions.length,
      competitions
    });
  } catch (error) {
    sendError(res, error.status || 502, error.message);
  }
});

/*
 * Fetch odds from the actual odds endpoint.
 * This is NOT the scores endpoint.
 *
 * Supported markets depend on the competition and provider coverage.
 */
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
      req.query.markets || "h2h,totals,btts,spreads"
    )
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .join(",");

    const result = await oddsRequest(
      `/sports/${encodeURIComponent(sport)}/odds`,
      {
        regions,
        markets: requestedMarkets,
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
    sendError(res, error.status || 502, error.message);
  }
});

/*
 * Prediction Challenge fixtures:
 * only future matches scheduled for today's date in Nigeria.
 */
app.get("/api/fixtures", async (req, res) => {
  try {
    const sportsResult = await oddsRequest("/sports", {
      all: "false"
    });

    const sports = (sportsResult.data || []).filter(s =>
      s.active !== false &&
      String(s.key).startsWith("soccer_")
    );

    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "10", 10) || 10, 1),
      20
    );

    const selectedSports = sports.slice(0, limit);

    const results = await Promise.allSettled(
      selectedSports.map(async sport => {
        const result = await oddsRequest(
          `/sports/${encodeURIComponent(sport.key)}/odds`,
          {
            regions: "uk",
            markets: "h2h",
            oddsFormat: "decimal",
            dateFormat: "iso"
          }
        );

        return (result.data || []).map(normalizeEvent);
      })
    );

    const matches = [];
    const errors = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        matches.push(...result.value);
      } else {
        errors.push({
          sport: selectedSports[index].key,
          error: result.reason?.message || "Request failed"
        });
      }
    });

    const now = Date.now();

    const todaysMatches = matches
      .filter(match => {
        const kickoff = new Date(match.kickoff).getTime();

        return (
          Number.isFinite(kickoff) &&
          kickoff > now &&
          isTodayNigeria(match.kickoff)
        );
      })
      .sort((a, b) =>
        new Date(a.kickoff) - new Date(b.kickoff)
      );

    // Remove duplicate events if a provider response repeats an event.
    const unique = [];
    const seen = new Set();

    for (const match of todaysMatches) {
      if (seen.has(match.event_id)) continue;
      seen.add(match.event_id);
      unique.push(match);
    }

    res.json({
      success: true,
      provider: "The Odds API",
      timezone: TZ,
      date: todayNigeria(),
      count: unique.length,
      matches: unique,
      errors
    });
  } catch (error) {
    sendError(res, error.status || 502, error.message);
  }
});

/*
 * Scores route:
 * can be called with ?sport=soccer_epl
 */
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
    sendError(res, error.status || 502, error.message);
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
 * Returns true, false, or null.
 * null means this backend cannot safely settle this market/selection.
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

    const actual = home > away ? "H" : home < away ? "A" : "D";
    return selected === actual;
  }

  if (market === "totals") {
    const s = normalizeText(selection);
    const total = home + away;

    const match = s.match(/^(over|under)\s*(\d+(?:\.\d+)?)$/);

    if (!match) return null;

    const line = Number(match[2]);

    if (match[1] === "over") return total > line;
    return total < line;
  }

  if (market === "btts") {
    const s = normalizeText(selection);

    const yes = ["yes", "btts yes", "both teams to score yes"];
    const no = ["no", "btts no", "both teams to score no"];

    if (yes.includes(s)) return home > 0 && away > 0;
    if (no.includes(s)) return home === 0 || away === 0;

    return null;
  }

  // Other markets are deliberately not graded with guessed rules.
  return null;
}

function calculateTicket(picks, scoreEvents) {
  if (!Array.isArray(picks) || picks.length === 0) {
    return { state: "unresolved", reason: "Ticket has no selections." };
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
        // The result is known, but the required odds snapshot is missing.
        // Do not invent points for a legacy selection.
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
    points: anyLoss ? 0 : Math.round(totalPoints * 100) / 100,
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

/*
 * This endpoint should be called by your trusted scheduler.
 *
 * It uses exact Odds API event IDs. Old tickets without those IDs
 * are left pending rather than matched by approximate team names.
 */
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
        if (sportKey && getEventId(pick)) sports.add(sportKey);
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

      /*
       * Critical duplicate protection:
       * update only while the row is still pending.
       * Both columns receive the same final points value.
       */
      const updated = await supabaseRequest(
        `${TABLE}?id=eq.${encodeURIComponent(entry.id)}&status=eq.pending`,
        {
          method: "PATCH",
          prefer: "return=representation",
          body: {
            picks: outcome.picks,
            point: points,
            points: points,
            status: "graded"
          }
        }
      );

      if (Array.isArray(updated) && updated.length > 0) {
        graded++;
        pointsAwarded += points;
      } else {
        // Another scoring run may already have processed this ticket.
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
  console.log(`Provider: The Odds API`);
  console.log(`Nigeria prediction date: ${todayNigeria()}`);
}); 
