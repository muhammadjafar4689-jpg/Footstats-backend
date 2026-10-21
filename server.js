const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API_URL = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

const competitions = {
"39": "PL",
"140": "PD",
"135": "SA",
"78": "BL1",
"61": "FL1",
"94": "PPL",
"88": "DED",
"40": "ELC",
"71": "BSA",
"1": "WC",
"4": "EC",

"premier league": "PL",
"la liga": "PD",
"primera division": "PD",
"serie a": "SA",
"bundesliga": "BL1",
"ligue 1": "FL1",
"portugal first league": "PPL",
"primeira liga": "PPL",
"netherlands first league": "DED",
"eredivisie": "DED",
"championship": "ELC",
"brazil first league": "BSA",
"campeonato brasileiro serie a": "BSA",
"world cup": "WC",
"euro": "EC",
"european championship": "EC",
"champions league": "CL",
"copa libertadores": "CLI"
};

function validDate(date) {
return /^\d{4}-\d{2}-\d{2}$/.test(date) &&
!Number.isNaN(Date.parse(date + "T00:00:00Z")) &&
new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date;
}

function todayUTC() {
return new Date().toISOString().slice(0, 10);
}

function addDays(date, days) {
const result = new Date(date + "T00:00:00Z");
result.setUTCDate(result.getUTCDate() + days);
return result.toISOString().slice(0, 10);
}

async function footballRequest(path) {
const response = await fetch(API_URL + path, {
headers: {
"X-Auth-Token": API_KEY
}
});

const text = await response.text();

let data;
try {
data = JSON.parse(text);
} catch {
data = { message: text };
}

return {
ok: response.ok,
status: response.status,
data
};
}

function normalizeMatch(match) {
const statusMap = {
FINISHED: "FT",
IN_PLAY: "LIVE",
PAUSED: "LIVE",
SCHEDULED: "NS",
TIMED: "NS",
POSTPONED: "PST",
CANCELLED: "CANC",
SUSPENDED: "SUSP",
AWARDED: "FT"
};

return {
fixture: {
id: match.id,
date: match.utcDate,
status: {
short: statusMap[match.status] || match.status,
long: match.status
}
},
league: {
id: match.competition?.id ?? null,
code: match.competition?.code ?? null,
name: match.competition?.name || "Football",
country: match.area?.name || "",
logo: match.competition?.emblem || null
},
teams: {
home: {
id: match.homeTeam?.id ?? null,
name: match.homeTeam?.name || "Home",
logo: match.homeTeam?.crest || null,
winner: match.score?.winner === "HOME"
},
away: {
id: match.awayTeam?.id ?? null,
name: match.awayTeam?.name || "Away",
logo: match.awayTeam?.crest || null,
winner: match.score?.winner === "AWAY"
}
},
goals: {
home: match.score?.fullTime?.home ?? null,
away: match.score?.fullTime?.away ?? null
},
score: match.score
};
}

app.get("/", (req, res) => {
res.json({
name: "FootStats Backend",
status: "online",
provider: "Football-Data.org",
endpoints: {
today: "/api/fixtures",
exactDate: "/api/fixtures?date=2026-10-21",
dateRange: "/api/fixtures?from=2026-10-18&to=2026-10-25",
premierLeague: "/api/fixtures?league=39",
competitions: "/api/competitions",
diagnostic: "/api/diagnostic"
}
});
});

// Show the competitions available to this API key.
app.get("/api/competitions", async (req, res) => {
try {
if (!API_KEY) {
return res.status(500).json({
success: false,
error: "FOOTBALL_DATA_API_KEY is missing in Render."
});
}

const result = await footballRequest("/competitions");

if (!result.ok) {
  return res.status(502).json({
    success: false,
    providerStatus: result.status,
    apiResponse: result.data
  });
}

res.json({
  success: true,
  results: (result.data.competitions || []).length,
  response: result.data.competitions || []
});

} catch (error) {
res.status(500).json({
success: false,
error: error.message
});
}
});

// Check API connectivity and competition access.
app.get("/api/diagnostic", async (req, res) => {
try {
if (!API_KEY) {
return res.status(500).json({
success: false,
error: "FOOTBALL_DATA_API_KEY is missing in Render."
});
}

const result = await footballRequest("/competitions");

res.json({
  success: result.ok,
  providerStatus: result.status,
  competitionsReturned:
    (result.data.competitions || []).length,
  competitions: (result.data.competitions || []).map(c => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.area?.name
  })),
  apiMessage: result.data.message || null
});

} catch (error) {
res.status(500).json({
success: false,
error: error.message
});
}
});

// Get fixtures by exact date or date range.
app.get("/api/fixtures", async (req, res) => {
try {
if (!API_KEY) {
return res.status(500).json({
success: false,
error: "API key missing",
message: "Set FOOTBALL_DATA_API_KEY in Render Environment Variables."
});
}

const today = todayUTC();

let from = req.query.from || req.query.date || today;
let to = req.query.to || req.query.date || addDays(today, 7);

if (!validDate(from) || !validDate(to)) {
  return res.status(400).json({
    success: false,
    error: "Invalid date",
    message: "Use YYYY-MM-DD for date, from and to."
  });
}

if (from > to) {
  return res.status(400).json({
    success: false,
    error: "'from' must be earlier than or equal to 'to'."
  });
}

const days =
  (Date.parse(to + "T00:00:00Z") -
   Date.parse(from + "T00:00:00Z")) / 86400000;

if (days > 30) {
  return res.status(400).json({
    success: false,
    error: "Date range too large",
    message: "Request a maximum of 31 calendar days at a time."
  });
}

const params = new URLSearchParams({
  dateFrom: from,
  dateTo: to
});

let competitionCode = null;

if (req.query.league) {
  const league = String(req.query.league).trim().toLowerCase();
  competitionCode = competitions[league];

  if (!competitionCode) {
    return res.status(400).json({
      success: false,
      error: "Unknown competition",
      requestedLeague: req.query.league
    });
  }

  params.set("competitions", competitionCode);
}

const result = await footballRequest(
  "/matches?" + params.toString()
);

if (!result.ok) {
  return res.status(502).json({
    success: false,
    providerStatus: result.status,
    from,
    to,
    competition: competitionCode,
    message: result.data.message || "Football API request failed",
    apiResponse: result.data
  });
}

const matches = (result.data.matches || []).map(normalizeMatch);

res.json({
  success: true,
  from,
  to,
  competition: competitionCode,
  results: matches.length,
  response: matches
});

} catch (error) {
res.status(500).json({
success: false,
error: "Backend error",
message: error.message
});
}
});

app.listen(PORT, () => {
console.log("FootStats backend running on port " + PORT);
}); 
