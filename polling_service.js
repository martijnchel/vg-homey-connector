// Virtuagym Polling Service - MILLISECONDS FIX + [B][E][N] Logic
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

let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 

// --- HELPERS ---

/**
 * Haalt lidgegevens op en bepaalt de [B] en [N] status
 */
async function getMemberData(memberId) {
    try {
        const res = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { params: { api_key: API_KEY, club_secret: CLUB_SECRET } });
        const data = Array.isArray(res.data.result) ? res.data.result[0] : res.data.result;
        if (!data) return { name: `Lid ${memberId}`, codes: "" };

        let codes = "";
        const nu = new Date();
        const fullName = `${data.firstname} ${data.lastname || ''}`.trim();

        // [B] Check: Verjaardag (vandaag)
        if (data.birthdate) {
            const bday = new Date(data.birthdate);
            if (bday.getDate() === nu.getDate() && bday.getMonth() === nu.getMonth()) {
                codes += "[B]";
            }
        }

        // [N] Check: Nieuw lid (laatste 30 dagen)
        if (data.timestamp_registration) {
            const regDate = new Date(data.timestamp_registration); // API geeft ms of string
            const dertigDagenGeleden = Date.now() - (30 * 24 * 60 * 60 * 1000);
            if (regDate.getTime() > dertigDagenGeleden) {
                codes += "[N]";
            }
        }

        return { name: fullName, codes: codes };
    } catch (e) {
        return { name: `Lid ${memberId}`, codes: "" };
    }
}

/**
 * Checkt contract voor de [E] status
 */
async function getContractStatus(memberId) {
    try {
        const res = await axios.get(VG_MEMBERSHIP_BASE_URL, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, sync_from: 0, limit: 5 } 
        });
        const memberships = res.data.result || [];
        const nu = Date.now();
        
        const isExpiring = memberships.some(m => {
            if (!m.contract_end_date) return false;
            const endMs = new Date(m.contract_end_date).getTime();
            return endMs > nu && endMs <= (nu + CONTRACT_EXPIRY_THRESHOLD_MS) && !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name);
        });

        return isExpiring ? "[E]" : "";
    } catch (e) {
        return "";
    }
}

// --- DE HOOFD POLLING ---
async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;

    console.log(`--- [POLL] Check sinds ms: ${latestCheckinTimestamp} ---`);

    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp }
        });

        const visits = response.data.result || [];
        const newVisits = visits
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        if (newVisits.length > 0) {
            for (const visit of newVisits) {
                // 1. Haal Naam, [B] en [N] op
                const memberInfo = await getMemberData(visit.member_id);
                
                // 2. Haal [E] op
                const eCode = await getContractStatus(visit.member_id);
                
                // 3. Combineer codes: [B][E][N] (volgorde maakt voor jouw script niet uit)
                const combinedCodes = memberInfo.codes + eCode;

                const formattedTime = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { 
                    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
                });

                // 4. Stel de tag samen voor jouw Homey Script
                // Formaat wordt bijv: "[B][N]12:05 - Jan Jansen"
                const tagValue = `${combinedCodes}${formattedTime} - ${memberInfo.name}`;

                if (HOMEY_INDIVIDUAL_URL) {
                    await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${visit.check_in_timestamp}`);
                    console.log(`[HOME-SEND] ${tagValue}`);
                }

                latestCheckinTimestamp = visit.check_in_timestamp;
            }
        }
    } catch (error) {
        console.error("Poll fout:", error.message);
    }

    isPolling = false;
}

app.get('/', (req, res) => res.send('Virtuagym MS-Polling [B][E][N] Connector Actief.'));

app.listen(PORT, () => {
    console.log(`Server gestart op poort ${PORT}.`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym(); 
});
