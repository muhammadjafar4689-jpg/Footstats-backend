const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = "https://v3.football.api-sports.io";

// Supported competitions
const LEAGUES = {
  39: "Premier League",
  140: "La Liga",
  135: "Serie A",
  78: "Bundesliga",
  61: "Ligue 1",
  94: "Portugal First League",
  88: "Netherlands First League",
  40: "Championship",
  71: "Brazil First League",
  1: "World Cup",
  4: "Euro"
};

// Backend status
app.get("/", (req, res) => {
  res.json({
    status: "online",
    name: "FootStats Backend",
    fixturesEndpoint: "/api/fixtures?date=2026-10-20"
  });
});

// Get real football fixtures
app.get("/api/fixtures", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "API key not configured",
        message: "Add API_FOOTBALL_KEY in Render Environment Variables."
      });
    }

    const date = req.query.date;
    const league = req.query.league;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        error: "Invalid date",
        message: "Use ?date=2026-10-20"
      });
    }

    const params = new URLSearchParams();
    params.set("date", date);
    params.set("timezone", "Africa/Lagos");

    if (league && league !== "all") {
      if (!LEAGUES[Number(league)]) {
        return res.status(400).json({
          error: "Unsupported league ID"
        });
      }

      params.set("league", league);

      const year = Number(date.slice(0, 4));
      const month = Number(date.slice(5, 7));

      // International tournaments use the calendar year.
      // Most European league seasons begin in July.
      const season =
        Number(league) === 1 || Number(league) === 4
          ? year
          : month >= 7
            ? year
            : year - 1;

      params.set("season", String(season));
    }

    const response = await fetch(
      `${API_URL}/fixtures?${params.toString()}`,
      {
        headers: {
          "x-apisports-key": API_KEY
        }
      }
    );

    const data = await response.json();

    if (!response.ok || data.errors &&
        Object.keys(data.errors).length > 0) {
      return res.status(502).json({
        error: "Football data provider error",
        details: data.errors || data.message || response.statusText
      });
    }

    const fixtures = Array.isArray(data.response)
      ? data.response
      : [];

    res.json({
      success: true,
      date,
      results: fixtures.length,
      response: fixtures
    });

  } catch (error) {
    console.error("Fixtures error:", error.message);

    res.status(500).json({
      error: "Could not retrieve fixtures",
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`FootStats backend running on port ${PORT}`);
}); 
