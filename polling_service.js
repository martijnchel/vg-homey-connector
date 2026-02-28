// Virtuagym Polling Service - FINAL [B][E][N] VERSION
const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; 

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 

const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000;
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];

let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 

/**
 * Haalt lidgegevens op inclusief memberships en bepaalt [B], [E] en [N]
 */
async function getEnhancedMemberData(memberId) {
    try {
        // We voegen ?with=active_memberships toe om direct contractinfo te krijgen
        const res = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { 
            params: { 
                api_key: API_KEY, 
                club_secret: CLUB_SECRET,
                with: 'active_memberships' 
            } 
        });
        
        let data = res.data.result;
        if (Array.isArray(data)) data = data[0];
        if (!data) return { name: `Lid ${memberId}`, codes: "" };

        let codes = { B: "", E: "", N: "" };
        const nu = new Date();
        const fullName = `${data.firstname} ${data.lastname || ''}`.trim();

        // --- [B] Verjaardag Check (birthday: YYYY-MM-DD) ---
        if (data.birthday) {
            const bday = new Date(data.birthday);
            if (bday.getDate() === nu.getDate() && bday.getMonth() === nu.getMonth()) {
                codes.B = "[B]";
            }
        }

        // --- [N] Nieuw Lid Check (member_since: YYYY-MM-DD of ms) ---
        if (data.member_since) {
            let regTime;
            if (typeof data.member_since === 'string') {
                regTime = new Date(data.member_since).getTime();
            } else {
                regTime = data.member_since; // Al in ms
            }
            
            const dertigDagenInMs = 30 * 24 * 60 * 60 * 1000;
            if (Date.now() - regTime < dertigDagenInMs) {
                codes.N = "[N]";
            }
        }

        // --- [E] Contract Check (via de 'with' parameter) ---
        if (data.memberships && Array.isArray(data.memberships)) {
            const expiring = data.memberships.find(m => {
                if (!m.contract_end_date || m.active === 0) return false;
                const endMs = new Date(m.contract_end_date).getTime();
                const now = Date.now();
                return endMs > now && endMs <= (now + CONTRACT_EXPIRY_THRESHOLD_MS) && 
                       !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name);
            });
            if (expiring) codes.E = "[E]";
        }

        // Combineer in volgorde voor Homey: [B][E][N]
        return { 
            name: fullName, 
            codes: `${codes.B}${codes.E}${codes.N}` 
        };
    } catch (e) {
        console.error(`Fout bij laden lid ${memberId}:`, e.message);
        return { name: `Lid ${memberId}`, codes: "" };
    }
}

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;

    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp }
        });

        const visits = response.data.result || [];
        const newVisits = visits
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

for (const visit of visits) {
    const memberInfo = await getEnhancedMemberData(visit.member_id);
    const time = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    
    // Check of de incheck geweigerd is (Virtuagym gebruikt vaak 'denied' of 'success: false')
    let errorPrefix = "";
    if (visit.access_allowed === false || visit.error_code) {
        errorPrefix = "[X]";
    }

    const tagValue = `${errorPrefix}${memberInfo.codes}${time} - ${memberInfo.name}`;
    // ... rest van de axios.get naar Homey
}

            if (HOMEY_INDIVIDUAL_URL) {
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
                console.log(`[RAILWAY] ${tagValue}`);
            }

            latestCheckinTimestamp = visit.check_in_timestamp;
        }
    } catch (error) {
        console.error("Poll fout:", error.message);
    }
    isPolling = false;
}

app.get('/', (req, res) => res.send('Virtuagym Connector Online.'));

app.listen(PORT, () => {
    console.log(`Polling gestart op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym(); 
});
