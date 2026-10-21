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
"serie a": "SA",
"bundesliga": "BL1",
"ligue 1": "FL1",
"portugal first league": "PPL",
"primeira liga": "PPL",
"netherlands first league": "DED",
"eredivisie": "DED",
"championship": "ELC",
"brazil first league": "BSA",
"world cup": "WC",
"euro": "EC",
"champions league": "CL"
};

async function footballRequest(path) {
const url = API_URL + path;

const response = await fetch(url, {
method: "GET",
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
data: data
};
}

app.get("/", (req, res) => {
res.json({
name: "FootStats",
status: "online",
provider: "Football-Data.org",
fixtures: "/api/fixtures?date=2026-10-21",
diagnostic: "/api/diagnostic"
});
});

app.get("/api/diagnostic", async (req, res) => {
try {
if (!API_KEY) {
return res.status(500).json({
success: false,
error: "API key missing",
message: "Set FOOTBALL_DATA_API_KEY in Render Environment Variables."
});
}

const result = await footballRequest("/competitions");

if (!result.ok) {
  return res.status(200).json({
    success: false,
    providerStatus: result.status,
    message: result.data.message || "API request failed",
    apiResponse: result.data
  });
}

const list = (result.data.competitions || []).map(c => ({
  id: c.id,
  code: c.code,
  name: c.name,
  country: c.area ? c.area.name : "",
  seasonStart: c.currentSeason ? c.currentSeason.startDate : null,
  seasonEnd: c.currentSeason ? c.currentSeason.endDate : null
}));

res.json({
  success: true,
  provider: "Football-Data.org",
  competitionsReturned: list.length,
  competitions: list
});

} catch (error) {
res.status(500).json({
success: false,
error: error.message
});
}
});

app.get("/api/fixtures", async (req, res) => {
try {
if (!API_KEY) {
return res.status(500).json({
success: false,
error: "API key missing",
message: "Set FOOTBALL_DATA_API_KEY in Render Environment Variables."
});
}

const date = req.query.date || new Date().toISOString().slice(0, 10);

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  return res.status(400).json({
    success: false,
    error: "Invalid date",
    message: "Use YYYY-MM-DD."
  });
}

const params = new URLSearchParams({
  dateFrom: date,
  dateTo: date
});

if (req.query.league) {
  const league = String(req.query.league).trim().toLowerCase();
  const code = competitions[league];

  if (!code) {
    return res.status(400).json({
      success: false,
      error: "Unknown competition",
      requestedLeague: req.query.league
    });
  }

  params.set("competitions", code);
}

const result = await footballRequest("/matches?" + params.toString());

if (!result.ok) {
  return res.status(200).json({
    success: false,
    providerStatus: result.status,
    date: date,
    requestedLeague: req.query.league || null,
    message: result.data.message || "Football-Data.org request failed",
    apiResponse: result.data
  });
}

const matches = (result.data.matches || []).map(match => {
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
      id: match.competition ? match.competition.id : null,
      name: match.competition ? match.competition.name : "Football",
      country: match.area ? match.area.name : "",
      logo: match.competition ? match.competition.emblem : null
    },
    teams: {
      home: {
        id: match.homeTeam.id,
        name: match.homeTeam.name,
        logo: match.homeTeam.crest || null,
        winner: match.score.winner === "HOME"
      },
      away: {
        id: match.awayTeam.id,
        name: match.awayTeam.name,
        logo: match.awayTeam.crest || null,
        winner: match.score.winner === "AWAY"
      }
    },
    goals: {
      home: match.score.fullTime.home,
      away: match.score.fullTime.away
    },
    score: match.score
  };
});

res.json({
  success: true,
  date: date,
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
