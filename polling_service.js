// Virtuagym-Homey Connector - Volledige Versie met [B][E][N] en [X] Error handling
const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten

// Omgevingsvariabelen (Zorg dat deze in Railway gevuld zijn!)
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 

const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weken
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];

let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 

/**
 * Haalt uitgebreide lidgegevens op (Verjaardag, Contract, Registratie)
 */
async function getEnhancedMemberData(memberId) {
    try {
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

        // [B] Verjaardag Check
        if (data.birthday) {
            const bday = new Date(data.birthday);
            if (bday.getDate() === nu.getDate() && bday.getMonth() === nu.getMonth()) {
                codes.B = "[B]";
            }
        }

        // [N] Nieuw Lid Check (member_since)
        if (data.member_since) {
            let regTime = (typeof data.member_since === 'string') ? new Date(data.member_since).getTime() : data.member_since;
            const dertigDagenInMs = 30 * 24 * 60 * 60 * 1000;
            if (Date.now() - regTime < dertigDagenInMs) {
                codes.N = "[N]";
            }
        }

        // [E] Contract Check
        if (data.memberships && Array.isArray(data.memberships)) {
            const expiring = data.memberships.find(m => {
                if (!m.contract_end_date || m.active === 0) return false;
                const endMs = new Date(m.contract_end_date).getTime();
                return endMs > Date.now() && endMs <= (Date.now() + CONTRACT_EXPIRY_THRESHOLD_MS) && 
                       !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name);
            });
            if (expiring) codes.E = "[E]";
        }

        return { name: fullName, codes: `${codes.B}${codes.E}${codes.N}` };
    } catch (e) {
        return { name: `Lid ${memberId}`, codes: "" };
    }
}

/**
 * Hoofdfunctie voor het pollen van nieuwe inchecks
 */
async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;

    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { 
                api_key: API_KEY, 
                club_secret: CLUB_SECRET, 
                sync_from: latestCheckinTimestamp 
            }
        });

        const visits = response.data.result || [];
        const newVisits = visits
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of newVisits) {
            const memberInfo = await getEnhancedMemberData(visit.member_id);
            
            const formattedTime = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { 
                hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
            });

            // Check of de toegang geweigerd is (Error code [X])
            // Virtuagym geeft 'access_allowed: false' bij bijv. geen credits
            let errorPrefix = "";
            if (visit.access_allowed === false) {
                errorPrefix = "[X]";
            }

            // Samengestelde tag voor Homey: [X][B][E][N]12:00 - Naam
            const tagValue = `${errorPrefix}${memberInfo.codes}${formattedTime} - ${memberInfo.name}`;

            if (HOMEY_INDIVIDUAL_URL) {
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
                console.log(`[RAILWAY] Verzonden: ${tagValue}`);
            }

            latestCheckinTimestamp = visit.check_in_timestamp;
        }
    } catch (error) {
        console.error("Poll fout:", error.message);
    }
    isPolling = false;
}

// --- TEST ENDPOINTS ---

app.get('/test-homey', async (req, res) => {
    const type = req.query.type || 'ben';
    const time = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    let codes = "";
    
    if (type === 'x') codes = "[X]";
    else if (type === 'ben') codes = "[B][E][N]";
    else if (type === 'b') codes = "[B]";
    
    const tag = `${codes}${time} - Test Lid`;
    
    try {
        if (HOMEY_INDIVIDUAL_URL) {
            await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tag)}`);
            res.send(`Test verstuurd: ${tag}`);
        }
    } catch (e) {
        res.status(500).send("Fout: " + e.message);
    }
});

app.get('/', (req, res) => res.send('Virtuagym Connector Online.'));

app.listen(PORT, () => {
    console.log(`Polling gestart op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym(); 
});
