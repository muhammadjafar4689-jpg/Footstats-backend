const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

app.get("/", (req, res) => {
    res.json({
        app: "FootStats Backend",
        status: "online",
        message: "Your backend is running."
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "online",
        apiKeyConfigured: Boolean(API_KEY)
    });
});

app.get("/api/competitions", async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({
                error: "API key is not configured in Render."
            });
        }

        const response = await fetch(
            "https://api.football-data.org/v4/competitions",
            {
                headers: {
                    "X-Auth-Token": API_KEY
                }
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json(data);
        }

        res.json(data);

    } catch (error) {
        res.status(502).json({
            error: "Could not retrieve competitions.",
            details: error.message
        });
    }
});

app.get("/api/matches", async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({
                error: "API key is not configured in Render."
            });
        }

        const competition = String(
            req.query.competition || "PL"
        ).toUpperCase();

        if (!/^[A-Z0-9]{2,5}$/.test(competition)) {
            return res.status(400).json({
                error: "Invalid competition code."
            });
        }

        const url =
            "https://api.football-data.org/v4/competitions/" +
            encodeURIComponent(competition) +
            "/matches";

        const response = await fetch(url, {
            headers: {
                "X-Auth-Token": API_KEY
            }
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: "Football-Data.org rejected the request.",
                providerStatus: response.status,
                details: data
            });
        }

        res.json(data);

    } catch (error) {
        res.status(502).json({
            error: "Could not retrieve football matches.",
            details: error.message
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("FootStats backend running on port " + PORT);
}); 
