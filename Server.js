// =====================================================
// FOOTSTATS BACKEND
// The Odds API + Football Fixtures + Bookmaker Odds
// =====================================================

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(express.json());

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
    );
    res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

// =====================================================
// DEFAULT FOOTBALL LEAGUES
// =====================================================

const FOOTBALL_LEAGUES = [
    {
        key: "soccer_epl",
        name: "Premier League",
        country: "England"
    },
    {
        key: "soccer_england_efl_champ",
        name: "Championship",
        country: "England"
    },
    {
        key: "soccer_spain_la_liga",
        name: "La Liga",
        country: "Spain"
    },
    {
        key: "soccer_germany_bundesliga",
        name: "Bundesliga",
        country: "Germany"
    },
    {
        key: "soccer_italy_serie_a",
        name: "Serie A",
        country: "Italy"
    },
    {
        key: "soccer_france_ligue_one",
        name: "Ligue 1",
        country: "France"
    },
    {
        key: "soccer_portugal_primeira_liga",
        name: "Primeira Liga",
        country: "Portugal"
    },
    {
        key: "soccer_netherlands_eredivisie",
        name: "Eredivisie",
        country: "Netherlands"
    },
    {
        key: "soccer_brazil_campeonato",
        name: "Brazil Serie A",
        country: "Brazil"
    },
    {
        key: "soccer_uefa_champs_league",
        name: "Champions League",
        country: "Europe"
    },
    {
        key: "soccer_uefa_europa_league",
        name: "Europa League",
        country: "Europe"
    },
    {
        key: "soccer_uefa_european_championship",
        name: "European Championship",
        country: "International"
    },
    {
        key: "soccer_fifa_world_cup",
        name: "World Cup",
        country: "International"
    }
];

// =====================================================
// API HELPERS
// =====================================================

function getApiKey() {
    return process.env.ODDS_API_KEY;
}

function validateApiKey(res) {
    if (!getApiKey()) {
        res.status(500).json({
            success: false,
            message:
                "ODDS_API_KEY is missing. Add it to Render Environment Variables."
        });

        return false;
    }

    return true;
}

async function oddsRequest(path, params = {}) {
    const url = new URL(`${ODDS_API_BASE}${path}`);

    url.searchParams.set("apiKey", getApiKey());

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }

    const response = await fetch(url.toString());

    const text = await response.text();

    let data;

    try {
        data = JSON.parse(text);
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        const error = new Error(
            data.message || "The Odds API request failed."
        );

        error.status = response.status;

        throw error;
    }

    return {
        data,
        requestsRemaining:
            response.headers.get("x-requests-remaining"),
        requestsUsed:
            response.headers.get("x-requests-used"),
        requestsLast:
            response.headers.get("x-requests-last")
    };
}

function sendApiError(res, error) {
    console.error("FootStats API error:", error.message);

    res.status(error.status || 500).json({
        success: false,
        message: error.message || "An unexpected server error occurred."
    });
}

function validSportKey(sport) {
    return /^soccer_[a-z0-9_]+$/.test(sport);
}

// =====================================================
// FIND BEST HOME / DRAW / AWAY ODDS
// =====================================================

function getBestOdds(event) {
    const best = {
        home: null,
        draw: null,
        away: null
    };

    const homeName = event.home_team;
    const awayName = event.away_team;

    for (const bookmaker of event.bookmakers || []) {
        for (const market of bookmaker.markets || []) {
            if (market.key !== "h2h") continue;

            for (const outcome of market.outcomes || []) {
                const price = Number(outcome.price);

                if (!Number.isFinite(price)) continue;

                let key = null;

                if (outcome.name === homeName) {
                    key = "home";
                } else if (outcome.name === awayName) {
                    key = "away";
                } else if (
                    String(outcome.name).toLowerCase() === "draw"
                ) {
                    key = "draw";
                }

                if (
                    key &&
                    (best[key] === null || price > best[key].price)
                ) {
                    best[key] = {
                        price,
                        bookmaker: bookmaker.title
                    };
                }
            }
        }
    }

    return best;
}

// =====================================================
// MAP ODDS API EVENTS TO FOOTSTATS FIXTURES
// =====================================================

function mapFixture(event) {
    const odds = getBestOdds(event);

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

        odds: {
            home: odds.home ? odds.home.price : null,
            draw: odds.draw ? odds.draw.price : null,
            away: odds.away ? odds.away.price : null
        },

        bookmakers: event.bookmakers || [],

        bestBookmakers: {
            home: odds.home ? odds.home.bookmaker : null,
            draw: odds.draw ? odds.draw.bookmaker : null,
            away: odds.away ? odds.away.bookmaker : null
        },

        source: "The Odds API"
    };
}

// =====================================================
// HOME
// =====================================================

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
            "/api/fixtures",
            "/api/fixtures?league=soccer_epl",
            "/api/fixtures?from=2026-10-27&to=2026-10-30",
            "/api/scores?sport=soccer_epl"
        ]
    });
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        status: "online",
        provider: "The Odds API",
        timestamp: new Date().toISOString()
    });
});

// =====================================================
// DIAGNOSTICS
// Never return the actual API key.
// =====================================================

app.get("/api/diagnostic", (req, res) => {
    res.json({
        success: true,
        backend: "online",
        provider: "The Odds API",
        oddsApiKeyConfigured: Boolean(getApiKey()),
        nodeVersion: process.version
    });
});

// =====================================================
// COMPETITIONS
// =====================================================

app.get("/api/competitions", (req, res) => {
    res.json({
        success: true,
        provider: "The Odds API",
        competitionsReturned: FOOTBALL_LEAGUES.length,
        response: FOOTBALL_LEAGUES
    });
});

// =====================================================
// AVAILABLE SPORTS FROM THE ODDS API
// =====================================================

app.get("/api/odds/sports", async (req, res) => {
    if (!validateApiKey(res)) return;

    try {
        const result = await oddsRequest("/sports/");

        const sports = (result.data || []).filter(
            sport => sport.key.startsWith("soccer_")
        );

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

// =====================================================
// BOOKMAKER ODDS FOR A LEAGUE
//
// Example:
// /api/odds?sport=soccer_epl
// /api/odds?sport=soccer_spain_la_liga
// =====================================================

app.get("/api/odds", async (req, res) => {
    if (!validateApiKey(res)) return;

    try {
        const sport = req.query.sport || "soccer_epl";

        if (!validSportKey(sport)) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid football sport key."
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

        const fixtures = (result.data || []).map(mapFixture);

        res.json({
            success: true,
            provider: "The Odds API",
            sport,
            count: fixtures.length,
            requestsRemaining: result.requestsRemaining,
            response: fixtures
        });
    } catch (error) {
        sendApiError(res, error);
    }
});

// =====================================================
// FIXTURES
//
// Compatible with the existing FootStats app:
//
// /api/fixtures
// /api/fixtures?league=soccer_epl
// /api/fixtures?date=2026-10-28
// /api/fixtures?from=2026-10-27&to=2026-10-30
//
// NOTE: This endpoint returns events for which the Odds API
// has odds available. It is not a complete historical fixture
// database.
// =====================================================

app.get("/api/fixtures", async (req, res) => {
    if (!validateApiKey(res)) return;

    try {
        const sport =
            req.query.sport ||
            req.query.league ||
            "soccer_epl";

        if (!validSportKey(sport)) {
            return res.status(400).json({
                success: false,
                message:
                    "Use a football sport key, for example soccer_epl."
            });
        }

        let from = req.query.from;
        let to = req.query.to;

        if (req.query.date) {
            from = req.query.date;
            to = req.query.date;
        }

        const params = {
            regions: "uk,eu",
            markets: "h2h",
            oddsFormat: "decimal",
            dateFormat: "iso"
        };

        if (from) {
            const startDate = new Date(`${from}T00:00:00Z`);

            if (Number.isNaN(startDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid from/date parameter."
                });
            }

            params.commenceTimeFrom = startDate.toISOString();
        }

        if (to) {
            const endDate = new Date(`${to}T23:59:59Z`);

            if (Number.isNaN(endDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid to/date parameter."
                });
            }

            params.commenceTimeTo = endDate.toISOString();
        }

        const result = await oddsRequest(
            `/sports/${encodeURIComponent(sport)}/odds/`,
            params
        );

        let events = result.data || [];

        // Extra date filtering
        if (from) {
            events = events.filter(event =>
                event.commence_time >= `${from}T00:00:00Z`
            );
        }

        if (to) {
            events = events.filter(event =>
                event.commence_time <= `${to}T23:59:59Z`
            );
        }

        const fixtures = events
            .map(mapFixture)
            .sort((a, b) =>
                new Date(a.fixture.date) - new Date(b.fixture.date)
            );

        res.json({
            success: true,
            provider: "The Odds API",
            from: from || null,
            to: to || null,
            competition: sport,
            results: fixtures.length,
            requestsRemaining: result.requestsRemaining,
            response: fixtures
        });
    } catch (error) {
        sendApiError(res, error);
    }
});

// =====================================================
// MATCH SCORES
//
// Scores are separate from odds. This endpoint asks the
// Odds API for available event scores.
// =====================================================

app.get("/api/scores", async (req, res) => {
    if (!validateApiKey(res)) return;

    try {
        const sport = req.query.sport || "soccer_epl";

        if (!validSportKey(sport)) {
            return res.status(400).json({
                success: false,
                message: "Invalid football sport key."
            });
        }

        const daysFrom = Number(req.query.daysFrom || 3);

        if (
            !Number.isInteger(daysFrom) ||
            daysFrom < 1 ||
            daysFrom > 3
        ) {
            return res.status(400).json({
                success: false,
                message: "daysFrom must be 1, 2, or 3."
            });
        }

        const result = await oddsRequest(
            `/sports/${encodeURIComponent(sport)}/scores/`,
            {
                daysFrom,
                dateFormat: "iso"
            }
        );

        res.json({
            success: true,
            provider: "The Odds API",
            sport,
            count: (result.data || []).length,
            requestsRemaining: result.requestsRemaining,
            response: result.data || []
        });
    } catch (error) {
        sendApiError(res, error);
    }
});

// =====================================================
// UNKNOWN ROUTES
// =====================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "Endpoint not found.",
        path: req.path
    });
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`FootStats backend running on port ${PORT}`);
    console.log("Provider: The Odds API");
    console.log(
        "Odds API key configured:",
        Boolean(getApiKey())
    );
});
