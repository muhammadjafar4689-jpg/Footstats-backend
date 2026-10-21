const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API_URL = "https://api.football-data.org/v4";

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
const response = await fetch("${API_URL}${path}", {
headers: {
"X-Auth-Token": API_KEY
}
});

const rawText = await response.text();

let data;
try {
data = JSON.parse(rawText);
} catch {
data = { message: rawText };
}

return {
ok: response.ok,
status: response.status,
data
};
}

app.get("/", (req, res) => {
res.json({
name: "FootStats Backend",
status: "online",
provider: "Football-Data.org",
diagnostic: "/api/diagnostic",
fixtures: "/api/fixtures?date=2026-10-21"
});
});

// Check API access and list competitions visible to your API key.
app.get("/api/diagnostic", async (req, res) => {
try {
if (!API_KEY) {
return res.status(500).json({
success: false,
error: "Missing API key",
message: "Set FOOTBALL_DATA_API_KEY in Render Environment Variables."
});
}

const result = await footballRequest("/competitions");

if (!result.ok) {
  return res.status(200).json({
    success: false,
    providerStatus: result.status,
    message: result.data.message || "Competition request failed.",
    apiResponse: result.data
  });
}

const availableCompetitions = (result.data.competitions || []).map(c => ({
  id: c.id,
  code: c.code,
  name: c.name,
  area: c.area?.name,
  seasonStart: c.currentSeason?.startDate,
  seasonEnd: c.currentSeason?.endDate
}));

res.json({
  success: true,
  provider: "Football-Data.org",
  competitionsReturned: availableCompetitions.length,
  competitions: availableCompetitions
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
error: "API key not configured",
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
  const key = String(req.query.league).trim().toLowerCase();
  const code = competitions[key] || competitions[String(req.query.league)];

  if (!code) {
    return res.status(400).json({
      success: false,
      error: "Unknown competition",
      requestedLeague: req.query.league
    });
  }

  params.set("competitions", code);
}

const result = await footballRequest(`/matches?${params.toString()}`);

if (!result.ok) {
  return res.status(200).json({
    success: false,
    providerStatus: result.status,
    date,
    requestedLeague: req.query.league || null,
    message: result.data.message || "Football-Data.org rejected the request.",
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
      id: match.competition?.id,
      name: match.competition?.name || "Football",
      country: match.area?.name || match.competition?.area?.name || "",
      logo: match.competition?.emblem || null
    },
    teams: {
      home: {
        id: match.homeTeam?.id,
        name: match.homeTeam?.name || "Home",
        logo: match.homeTeam?.crest || null,
        winner: match.score?.winner === "HOME"
      },
      away: {
        id: match.awayTeam?.id,
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
});

res.json({
  success: true,
  date,
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
console.log("FootStats backend running on port ${PORT}");
}); 
