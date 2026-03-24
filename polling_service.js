const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 30000; // Elke 30 seconden checken

// Omgevingsvariabelen (Railway)
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

let latestCheckinTimestamp = Date.now(); 
let isPolling = false;

/**
 * Haalt lid-details op en checkt op verjaardag/nieuw lid
 */
async function getEnhancedMemberData(memberId) {
    try {
        const res = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        
        let data = res.data.result;
        if (Array.isArray(data)) data = data[0];
        if (!data) return { name: `Lid ${memberId}`, codes: "" };

        let codes = { B: "", N: "" };
        const nu = new Date();
        const fullName = `${data.firstname} ${data.lastname || ''} `.trim();

        // 1. Verjaardag Check [B]
        if (data.birthday) {
            const bday = new Date(data.birthday);
            if (bday.getDate() === nu.getDate() && bday.getMonth() === nu.getMonth()) {
                codes.B = "[B]";
            }
        }

        // 2. Nieuw Lid Check [N] (Geregistreerd in de laatste 30 dagen)
        if (data.member_since) {
            const regDate = new Date(data.member_since).getTime();
            const dertigDagenInMs = 30 * 24 * 60 * 60 * 1000;
            if (Date.now() - regDate < dertigDagenInMs) {
                codes.N = "[N]";
            }
        }

        return { 
            name: fullName, 
            codes: `${codes.B}${codes.N}` 
        };
    } catch (e) {
        return { name: `Lid ${memberId}`, codes: "" };
    }
}

/**
 * Hoofd-functie voor het pollen van nieuwe bezoeken
 */
async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;

    try {
        const response = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`, {
            params: { 
                api_key: API_KEY, 
                club_secret: CLUB_SECRET, 
                sync_from: latestCheckinTimestamp 
            }
        });

        const visits = (response.data.result || [])
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of visits) {
            const memberInfo = await getEnhancedMemberData(visit.member_id);
            const time = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { 
                hour: '2-digit', 
                minute: '2-digit', 
                timeZone: 'Europe/Amsterdam' 
            });

            // Formaat: [X][B][N]12:34 - Voornaam Achternaam
            const statusPrefix = visit.status === "rejected" ? "[X]" : "";
            const tagValue = `${statusPrefix}${memberInfo.codes}${time} - ${memberInfo.name}`;

            if (HOMEY_INDIVIDUAL_URL) {
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
                console.log(`[RAILWAY] Verzonden naar Homey: ${tagValue}`);
            }

            latestCheckinTimestamp = visit.check_in_timestamp;
        }
    } catch (e) {
        console.error(`Poll error: ${e.message}`);
    }
    
    isPolling = false;
}

// Basis route voor status check
app.get('/', (req, res) => res.send('Virtuagym to Homey Connector is actief.'));

app.listen(PORT, () => {
    console.log(`Server gestart op poort ${PORT}`);
    // Start de loop
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    // Eerste run
    pollVirtuagym();
});
