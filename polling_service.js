const express = require('express');
const axios = require('axios');
const schedule = require('node-schedule'); // VERGEET NIET: toevoegen aan package.json
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 30000; 

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

// --- NIEUWE CONFIGURATIE VOOR RETENTIE ---
const RETENTION_WEBHOOK_URL = "JOUW_NIEUWE_MAKE_WEBHOOK_URL"; 
const TARGET_MEMBERSHIPS = ["Focus", "Premium"]; 

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

// --- RETENTIE LOGICA FUNCTIE ---
async function runRetentionCheck() {
    console.log("[RETENTIE] Start dagelijkse controle op inactieve leden...");
    const drieMaandenGeleden = Date.now() - (90 * 24 * 60 * 60 * 1000);

    try {
        const res = await axios.get(VG_MEMBER_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, with: 'active_memberships' }
        });

        const members = res.data.result || [];
        let foundCount = 0;

        for (const m of members) {
            if (m.active !== 1) continue;

            const lastVisit = m.last_visit ? new Date(m.last_visit).getTime() : 0;
            // Check: Heeft ooit bezocht, maar langer dan 90 dagen geleden
            if (lastVisit === 0 || lastVisit > drieMaandenGeleden) continue;

            const isTarget = m.memberships?.some(ms => 
                ms.active === 1 && 
                TARGET_MEMBERSHIPS.some(t => ms.membership_name.includes(t)) &&
                !ms.membership_name.toLowerCase().includes("flex")
            );

            if (isTarget) {
                // Telefoonnummer opschonen naar 316...
                let rawPhone = m.mobile || m.phone || "";
                let cleanPhone = rawPhone.replace(/\D/g, ''); 
                if (cleanPhone.startsWith('06')) cleanPhone = '31' + cleanPhone.substring(1);
                else if (cleanPhone.startsWith('00316')) cleanPhone = cleanPhone.substring(2);
                else if (cleanPhone.startsWith('3106')) cleanPhone = '316' + cleanPhone.substring(4);

                if (cleanPhone.length >= 10) {
                    foundCount++;
                    await axios.post(RETENTION_WEBHOOK_URL, {
                        event: "retention_90_days",
                        member_id: m.member_id,
                        firstname: m.firstname,
                        phone: cleanPhone,
                        last_visit: m.last_visit
                    }).catch(err => console.error(`Webhook error voor ${m.firstname}:`, err.message));
                }
            }
        }
        console.log(`[RETENTIE] Controle voltooid. ${foundCount} leden doorgegeven aan Make.`);
    } catch (e) {
        console.error("[RETENTIE] Kritieke fout bij scan:", e.message);
    }
}

// --- BESTAANDE CHECK-IN LOGICA ---
async function getEnhancedMemberData(memberId) {
    try {
        const res = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, with: 'active_memberships' } 
        });
        let data = res.data.result;
        if (Array.isArray(data)) data = data[0];
        if (!data) return { name: `Lid ${memberId}`, codes: "" };

        let codes = { B: "", E: "", N: "" };
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
        if (data.memberships && Array.isArray(data.memberships)) {
            const expiring = data.memberships.find(m => {
                if (!m.contract_end_date || m.active === 0) return false;
                const endMs = new Date(m.contract_end_date).getTime();
                return endMs > Date.now() && endMs <= (Date.now() + CONTRACT_EXPIRY_THRESHOLD_MS) && !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name);
            });
            if (expiring) codes.E = "[E]";
        }
        return { name: fullName, codes: `${codes.B}${codes.E}${codes.N}` };
    } catch (e) { return { name: `Lid ${memberId}`, codes: "" }; }
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
                console.log(`[RAILWAY] Scan: ${memberInfo.name} | Status: ${visit.status}`);
            }
            latestCheckinTimestamp = visit.check_in_timestamp;
        }
    } catch (e) { 
        console.error(`Poll fout: ${e.message}`); 
        if (!e.response || e.response.status >= 500) {
            errorCount++;
            if (errorCount >= MAX_ERROR_THRESHOLD) virtuagymStatus.online = false;
        }
    }
    isPolling = false;
}

// --- ENDPOINTS ---
app.get('/gate-status', (req, res) => res.json(virtuagymStatus));

app.get('/test-retention', async (req, res) => {
    runRetentionCheck();
    res.send("Retentie scan handmatig gestart. Check de Railway logs!");
});

app.get('/', (req, res) => res.send('YVSPORT Connector is online.'));

app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
    
    // Check-in interval (elke 30 sec)
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    
    // Retentie interval (elke dag om 10:00 uur)
    schedule.scheduleJob('0 10 * * *', runRetentionCheck);
    
    pollVirtuagym();
});
