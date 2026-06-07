import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";

const router = Router();

router.get("/api/airport", async (req: Request, res: Response) => {
    try {
        const response = await fetch("https://nasstatus.faa.gov/api/airport-events", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        
        if (!response.ok) {
            throw new Error(`FAA API returned ${response.status}`);
        }
        
        const data = await response.json();
        const hnl = data.find((a: any) => a.airportId === "HNL");
        
        let status = "NORMAL OPERATIONS";
        let color = "#1dd1a1"; // Green
        let details = "No known delays or closures at this time.";
        
        if (hnl) {
            if (hnl.airportClosure) {
                status = "AIRPORT CLOSED";
                color = "#ee5253"; // Red
                details = hnl.airportClosure.simpleText || "Runways closed.";
            } else if (hnl.groundStop) {
                status = "GROUND STOP";
                color = "#ee5253"; // Red
                details = `Reason: ${hnl.groundStop.impactingCondition || 'Unknown'}. End: ${new Date(hnl.groundStop.endTime).toLocaleTimeString()}`;
            } else if (hnl.groundDelay) {
                status = "GROUND DELAY";
                color = "#ff9f43"; // Orange
                details = `Avg delay: ${hnl.groundDelay.avgDelay} min. Reason: ${hnl.groundDelay.impactingCondition || 'Unknown'}.`;
            } else if (hnl.departureDelay) {
                status = "DEPARTURE DELAY";
                color = "#fdcb6e"; // Yellow
                details = `Delay: ${hnl.departureDelay.arrivalDeparture?.min || ''} - ${hnl.departureDelay.arrivalDeparture?.max || ''}. Reason: ${hnl.departureDelay.reason || 'Unknown'}`;
            } else if (hnl.arrivalDelay) {
                status = "ARRIVAL DELAY";
                color = "#fdcb6e"; // Yellow
                details = `Reason: ${hnl.arrivalDelay.reason || 'Unknown'}`;
            } else if (hnl.freeForm) {
                status = "ADVISORY";
                color = "#a29bfe"; // Purple
                details = hnl.freeForm.text || hnl.freeForm.simpleText || "General advisory.";
            }
        }
        
        res.json({
            status,
            color,
            details
        });
    } catch (error: any) {
        logger.error({ err: error }, "Error fetching airport status");
        res.json({
            status: "STATUS UNAVAILABLE",
            color: "#636e72", // Gray
            details: "Could not fetch data from FAA systems."
        });
    }
});

export default router;
