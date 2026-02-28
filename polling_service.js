const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 

// We onthouden de ID's van de laatste paar minuten om dubbele meldingen te blokkeren
let processedMemberIds = new Set();
let isPolling = false;

// Functie om de naam op te halen
async function getMemberName(memberId) {
    try {
        const res = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        const data = Array.isArray(res.data.result) ? res.data.result[0] : res.data.result;
        return data ? `${data.firstname} ${data.lastname || ''}`.trim() : `Lid ${memberId}`;
    } catch (e) { return `Lid ${memberId}`; }
}

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;

    const nuSeconds = Math.floor(Date.now() / 1000);
    // WE KIJKEN MAXIMAAL 3 MINUTEN TERUG IN DE TIJD
    const tweeMinutenGeleden = nuSeconds - 180; 

    console.log(`--- [POLL] Zoeken naar check-ins na: ${new Date(tweeMinutenGeleden * 1000).toLocaleTimeString()} ---`);

    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { 
                api_key: API_KEY, 
                club_secret: CLUB_SECRET, 
                sync_from: tweeMinutenGeleden // We vragen alleen de laatste 3 minuten op
            }
        });

        const visits = response.data.result || [];

        // STRENGE FILTERING:
        // 1. Scan moet in de laatste 3 minuten zijn gebeurd.
        // 2. We mogen dit lid deze poll nog niet verwerkt hebben.
        const freshVisits = visits.filter(v => 
            v.check_in_timestamp >= tweeMinutenGeleden &&
            !processedMemberIds.has(`${v.member_id}-${v.check_in_timestamp}`)
        );

        if (freshVisits.length > 0) {
            console.log(`[LOG] ${freshVisits.length} nieuwe relevante check-ins gevonden.`);
            
            for (const visit of freshVisits) {
                const uniqueKey = `${visit.member_id}-${visit.check_in_timestamp}`;
                
                const memberName = await getMemberName(visit.member_id);
                const formattedTime = new Date(visit.check_in_timestamp * 1000).toLocaleTimeString('nl-NL', { 
                    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
                });

                const tagValue = `${memberName} is nu ingecheckt om ${formattedTime}.`;
                
                // Verstuur naar Homey
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
                console.log(`[HOME-SEND] ${tagValue}`);

                // Voeg toe aan tijdelijk geheugen om dubbelingen te voorkomen
                processedMemberIds.add(uniqueKey);
            }
        } else {
            console.log("Geen nieuwe check-ins in de afgelopen 3 minuten.");
        }

        // Maak het geheugen elke 5 minuten een beetje schoon om het klein te houden
        if (processedMemberIds.size > 100) {
            processedMemberIds.clear();
        }

    } catch (error) {
        console.error("Fout:", error.message);
    }

    isPolling = false;
}

app.get('/', (req, res) => res.send('Strict Time Filter Online.'));
app.listen(PORT, () => {
    console.log(`Polling gestart. Oude rommel wordt genegeerd.`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym();
});
