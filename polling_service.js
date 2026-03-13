const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 30000;

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
let errorCount = 0;
const MAX_ERROR_THRESHOLD = 3; 

let virtuagymStatus = { 
    online: true, 
    lastUpdate: new Date().toISOString(),
    error: null 
};

async function getEnhancedMemberData(memberId) {
    try {
        // We voegen 'options' toe aan de 'with' parameter voor de zekerheid
        const res = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, with: 'active_memberships,options' } 
        });
        
        let data = res.data.result;
        if (Array.isArray(data)) data = data[0];
        if (!data) return { name: `Lid ${memberId}`, codes: "" };

        let codes = { B: "", E: "", N: "", BIO: "" };
        const nu = new Date();
        const fullName = `${data.firstname} ${data.lastname || ''}`.trim();

        if (data.birthday) {
            const bday = new Date(data.birthday);
            if (bday.getDate() === nu.getDate() && bday.getMonth() === nu.getMonth()) codes.B = "[B]";
        }
        if (data.member_since) {
            let regTime = (typeof data.member_since === 'string') ? new Date(data.member_since).getTime() : data.member_since;
            if (Date.now() - regTime < (30 * 24 * 60 * 60 * 1000)) codes.N = "[N]";
        }

        // Check memberships AND options (sommige add-ons staan in 'options')
        const allMemberships = [
            ...(data.memberships || []),
            ...(data.options || [])
        ];

        if (allMemberships.length > 0) {
            // 1. Check voor Expiring (E)
            const expiring = allMemberships.find(m => {
                if (!m.contract_end_date || m.active === 0) return false;
                const endMs = new Date(m.contract_end_date).getTime();
                return endMs > Date.now() && endMs <= (Date.now() + CONTRACT_EXPIRY_THRESHOLD_MS) && !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name);
            });
            if (expiring) codes.E = "[E]";

            // 2. Check voor Biocircuit (BIO)
            // We loggen de namen even naar de console zodat je in Railway kunt zien wat er binnenkomt
            const hasBiocircuit = allMemberships.some(m => {
                const name = (m.membership_name || m.name || "").toLowerCase();
                return m.active === 1 && name.includes("biocircuit");
            });
            
            if (hasBiocircuit) codes.BIO = "[BIO]";
        }
        
        return { name: fullName, codes: `${codes.B}${codes.E}${codes.N}${codes.BIO}` };
    } catch (e) { 
        return { name: `Lid ${memberId}`, codes: "" }; 
    }
}

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;
    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp },
            timeout: 15000 
        });

        errorCount = 0; 
        virtuagymStatus.online = true;
        virtuagymStatus.lastUpdate = new Date().toISOString();
        virtuagymStatus.error = null;

        const visits = (response.data.result || [])
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of visits) {
            const memberInfo = await getEnhancedMemberData(visit.member_id);
            const time = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { 
                hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
            });

            let errorPrefix = visit.status === "rejected" ? "[X]" : "";
            const tagValue = `${errorPrefix}${memberInfo.codes}${time} - ${memberInfo.name}`;

            if (HOMEY_INDIVIDUAL_URL) {
                await new Promise(resolve => setTimeout(resolve, 500)); 
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
                console.log(`[RAILWAY] Verzonden: ${tagValue}`);
            }
            latestCheckinTimestamp = visit.check_in_timestamp;
        }
    } catch (e) { 
        console.error(`Poll fout (${errorCount + 1}/${MAX_ERROR_THRESHOLD}):`, e.message); 
        if (!e.response || e.response.status >= 500 || e.code === 'ECONNABORTED' || e.code === 'ENOTFOUND') {
            errorCount++;
            if (errorCount >= MAX_ERROR_THRESHOLD) {
                virtuagymStatus.online = false;
                virtuagymStatus.lastUpdate = new Date().toISOString();
                virtuagymStatus.error = e.message;
            }
        }
    }
    isPolling = false;
}

app.get('/gate-status', (req, res) => res.json(virtuagymStatus));
app.get('/test-homey', async (req, res) => {
    const time = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    const tag = `[BIO]${time} - Test Lid`;
    if (HOMEY_INDIVIDUAL_URL) await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tag)}`);
    res.send("Test verstuurd: " + tag);
});
app.get('/', (req, res) => res.send('Virtuagym Connector is online.'));

app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym();
});
