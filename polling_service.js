const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten

// Configuratie via Omgevingsvariabelen
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

// Virtuagym Base URL's
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 

// Statusvariabele
let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 

// =======================================================
// HOOFD WEBHOOK TRIGGER
// =======================================================

async function triggerHomeyIndividualWebhook(memberId, checkinTime) {
    if (!HOMEY_INDIVIDUAL_URL) return;
    try {
        const memberRes = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });

        const memberData = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        if (!memberData) return;

        const memberName = `${memberData.firstname} ${memberData.lastname || ''}`.trim();
        
        // Gebruik de tijdnotatie zoals die standaard uit het systeem rolt
        const amsTimeStr = new Date(checkinTime).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        const tagValue = `${amsTimeStr} - ${memberName}`;
        
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
        console.log(`[VERSTUURD] ${tagValue}`);

    } catch (error) {
        console.error(`[FOUT] Webhook mislukt:`, error.message);
    }
}

// =======================================================
// POLLING LOGICA
// =======================================================

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;
    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp }
        });
        
        const visits = response.data.result || [];
        const newVisits = visits.filter(v => v.check_in_timestamp > latestCheckinTimestamp);

        if (newVisits.length > 0) {
            newVisits.sort((a, b) => b.check_in_timestamp - a.check_in_timestamp);
            const latestVisit = newVisits[0];
            
            await triggerHomeyIndividualWebhook(latestVisit.member_id, latestVisit.check_in_timestamp);
            latestCheckinTimestamp = latestVisit.check_in_timestamp;
        }
    } catch (e) { console.error("Polling error:", e.message); }
    isPolling = false;
}

// =======================================================
// SERVER START
// =======================================================

app.get('/', (req, res) => res.send('Polling service actief.'));

app.listen(PORT, () => {
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    console.log("Service gestart.");
});
