// Virtuagym Polling Service - MILLISECONDS FIX
const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; 
const SCHEDULE_CHECK_INTERVAL_MS = 60000;

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 
const HOMEY_DAILY_TOTAL_URL = process.env.HOMEY_DAILY_TOTAL_URL; 
const HOMEY_DAILY_EXPIRING_REPORT_URL = process.env.HOMEY_DAILY_EXPIRING_REPORT_URL; 

const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 
const VG_MEMBERSHIP_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`; 

const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000;
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let reportedMembersCache = {}; 
const DAILY_TOTAL_TIME = '23:59'; 
const DAILY_REPORT_TIME = '09:00'; 

// CRUCIAL: We starten met de tijd van NU in MILLISECONDEN
let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 
let hasTotalBeenSentToday = false; 
let hasReportBeenSentToday = false; 

// --- HELPERS ---
function getStartOfTodayUtc() {
    const today = new Date();
    const amsDateString = today.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); 
    return new Date(`${amsDateString}T00:00:00`).getTime();
}

async function getMemberName(memberId) {
    try {
        const res = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { params: { api_key: API_KEY, club_secret: CLUB_SECRET } });
        const data = Array.isArray(res.data.result) ? res.data.result[0] : res.data.result;
        return data ? `${data.firstname} ${data.lastname || ''}`.trim() : `Lid ${memberId}`;
    } catch (e) { return `Lid ${memberId}`; }
}

// --- DE HOOFD POLLING (AANGEPAST) ---
async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;

    console.log(`--- [POLL] Check sinds ms: ${latestCheckinTimestamp} (${new Date(latestCheckinTimestamp).toLocaleTimeString()}) ---`);

    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { 
                api_key: API_KEY, 
                club_secret: CLUB_SECRET, 
                sync_from: latestCheckinTimestamp // Nu correct in ms
            }
        });

        const visits = response.data.result || [];
        
        // Filter op nieuwe bezoeken en sorteer van OUD naar NIEUW
        const newVisits = visits
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        if (newVisits.length > 0) {
            console.log(`[LOG] ${newVisits.length} nieuwe check-ins gevonden.`);
            
            for (const visit of newVisits) {
                const memberName = await getMemberName(visit.member_id);
                const formattedTime = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { 
                    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
                });

                const tagValue = `${memberName} is nu ingecheckt om ${formattedTime}.`;
                
                // Verstuur naar Homey
                if (HOMEY_INDIVIDUAL_URL) {
                    await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${visit.check_in_timestamp}`);
                    console.log(`[HOME-SEND] ${tagValue}`);
                }

                // Update de timestamp steeds naar de laatst verwerkte scan
                latestCheckinTimestamp = visit.check_in_timestamp;
            }
        }
    } catch (error) {
        console.error("Poll fout:", error.message);
    }

    isPolling = false;
}

// --- OVERIGE FUNCTIES (DAGELIJKS/RAPPORT) ---
// (Houd deze gelijk aan je werkende code, maar let op dat sync_from daar ook ms verwacht)

app.get('/', (req, res) => res.send('Virtuagym MS-Polling Connector Actief.'));

app.listen(PORT, () => {
    console.log(`Server gestart op poort ${PORT}. Polling interval: ${POLLING_INTERVAL_MS}ms`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym(); 
});
