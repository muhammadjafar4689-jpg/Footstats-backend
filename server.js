const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API_URL = "https://api.football-data.org/v4";

// Football-Data.org competition codes
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

app.get("/", (req, res) => {
res.json({
name: "FootStats Backend",
status: "online",
provider: "Football-Data.org",
fixturesEndpoint: "/api/fixtures?date=2026-10-21"
});
});

app.get("/api/fixtures", async (req, res) => {
try {
if (!API_KEY) {
return res.status(500).json({
error: "API key not configured",
message: "Add FOOTBALL_DATA_API_KEY in Render Environment Variables."
});
}

const date = req.query.date || new Date().toISOString().slice(0, 10);
const league = req.query.league;

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  return res.status(400).json({
    error: "Invalid date",
    message: "Use YYYY-MM-DD format."
  });
}

const params = new URLSearchParams({
  dateFrom: date,
  dateTo: date
});

if (league) {
  const key = String(league).trim().toLowerCase();
  const competitionCode = competitions[key] || competitions[String(league)];

  if (!competitionCode) {
    return res.status(400).json({
      error: "Unknown competition",
      message: "This league is not mapped in the backend."
    });
  }

  params.set("competitions", competitionCode);
}

const response = await fetch(`${API_URL}/matches?${params.toString()}`, {
  headers: {
    "X-Auth-Token": API_KEY
  }
});

const data = await response.json();

if (!response.ok) {
  return res.status(response.status).json({
    error: "Football-Data.org request failed",
    status: response.status,
    message: data.message || "The API rejected the request.",
    details: data
  });
}

const matches = (data.matches || []).map(match => {
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
console.error("Fixtures error:", error.message);

res.status(500).json({
  error: "Server error",
  message: "Could not retrieve fixtures. Please try again."
});

}
});

app.listen(PORT, () => {
console.log("FootStats backend running on port ${PORT}");
}); 
