const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten

// Configuratie
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 

// STARTWAARDE: Kijk bij opstarten precies 120 seconden terug
let latestCheckinTimestamp = Math.floor(Date.now() / 1000) - 120; 
let isPolling = false; 

async function triggerHomeyIndividualWebhook(memberId, checkinTime) {
    if (!HOMEY_INDIVIDUAL_URL) return;
    try {
        const memberRes = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });

        const memberData = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        if (!memberData) return;

        const memberName = `${memberData.firstname} ${memberData.lastname || ''}`.trim();
        
        // Tijdcorrectie voor Homey (seconden naar milliseconden)
        const amsTimeStr = new Date(checkinTime * 1000).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        const tagValue = `${amsTimeStr} - ${memberName}`;
        
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
        console.log(`[VERSTUURD] ${tagValue}`);

    } catch (error) {
        console.error(`[FOUT] Webhook mislukt:`, error.message);
    }
}

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;
    try {
        // We vragen aan Virtuagym: "Geef alles sinds onze laatste opgeslagen tijdstempel"
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { 
                api_key: API_KEY, 
                club_secret: CLUB_SECRET, 
                sync_from: latestCheckinTimestamp 
            }
        });
        
        const visits = response.data.result || [];
        
        // Filter alleen de écht nieuwe bezoeken
        const newVisits = visits.filter(v => v.check_in_timestamp > latestCheckinTimestamp);

        if (newVisits.length > 0) {
            // Sorteer van oud naar nieuw zodat ze in de juiste volgorde in Homey komen
            newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

            for (const visit of newVisits) {
                await triggerHomeyIndividualWebhook(visit.member_id, visit.check_in_timestamp);
                
                // Update de tijdstempel direct na elke verwerkte scan
                latestCheckinTimestamp = visit.check_in_timestamp;
                
                // 1 seconde pauze tussen personen om Virtuagym te vriend te houden (tegen 429 errors)
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    } catch (e) { 
        if (e.response && e.response.status === 429) {
            console.error("429: Virtuagym blokkeert ons nog. Wacht even met herstarten.");
        } else {
            console.error("Polling error:", e.message); 
        }
    }
    isPolling = false;
}

app.get('/', (req, res) => res.send('Polling actief (2 min venster).'));

app.listen(PORT, () => {
    console.log(`Service gestart. Kijkt terug vanaf: ${new Date(latestCheckinTimestamp * 1000).toLocaleString()}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
});
