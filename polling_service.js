const express = require('express');
const axios = require('axios');
const schedule = require('node-schedule');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 30000; 

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

// --- RETENTIE CONFIGURATIE ---
const RETENTION_WEBHOOK_URL = "JOUW_NIEUWE_MAKE_WEBHOOK_URL"; 

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

// --- NIEUWE RETENTIE LOGICA MET PAGING & WILDCARDS ---
async function runRetentionCheck() {
    console.log("[RETENTIE] Start grondige controle...");
    const drieMaandenInMs = 90 * 24 * 60 * 60 * 1000;
    const grensDatum = Date.now() - drieMaandenInMs;

    try {
        let allMembers = [];
        let page = 0;
        let hasMore = true;

        // 1. Haal ALLE leden op (Paging)
        while (hasMore) {
            console.log(`[RETENTIE] Ophalen pagina ${page}...`);
            const res = await axios.get(VG_MEMBER_BASE_URL, {
                params: { api_key: API_KEY, club_secret: CLUB_SECRET, with: 'active_memberships', page: page }
            });
            const results = res.data.result || [];
            allMembers = allMembers.concat(results);
            
            if (results.length < 500) hasMore = false;
            else page++;
            
            if (page > 10) hasMore = false; // Veiligheidsstop
        }

        console.log(`[RETENTIE] Totaal ${allMembers.length} leden geladen. Start analyse...`);
        let foundCount = 0;

        for (const m of allMembers) {
            if (m.active !== 1) continue;

            // Check datum
            let lastVisitTs = m.last_visit ? new Date(m.last_visit).getTime() : 0;
            const isInactief = (lastVisitTs === 0 || lastVisitTs < grensDatum);

            if (isInactief) {
                const memberships = m.memberships || [];
                
                // 2. Filter op woorden "Complete" of "Focus" (Wildcard)
                const isTarget = memberships.some(ms => {
                    if (ms.active !== 1) return false;
                    const name = (ms.membership_name || "").toLowerCase();
                    return (name.includes("complete") || name.includes("focus")) && !name.includes("flex");
                });

                if (isTarget) {
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
                            last_visit: m.last_visit || "Nooit"
                        }).catch(e => {});
                        console.log(`[RETENTIE] MATCH: ${m.firstname} | Tel: ${cleanPhone} | Lidmaatschap: ${memberships.map(x => x.membership_name).join(', ')}`);
                    }
                }
            }
        }
        console.log(`[RETENTIE] Klaar. ${foundCount} leden naar Make gestuurd.`);
    } catch (e) {
        console.error("[RETENTIE] Fout:", e.message);
    }
}

// --- REST VAN JE CODE (Check-ins, etc.) ---
// (Blijft exact hetzelfde als voorheen)

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
            const time = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
            let errorPrefix = visit.status === "rejected" ? "[X]" : "";
            const tagValue = `${errorPrefix}${memberInfo.codes}${time} - ${memberInfo.name}`;
            if (HOMEY_INDIVIDUAL_URL) {
                await new Promise(resolve => setTimeout(resolve, 500)); 
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
                console.log(`[RAILWAY] Scan: ${memberInfo.name}`);
            }
            latestCheckinTimestamp = visit.check_in_timestamp;
        }
    } catch (e) { 
        console.error(`Poll fout: ${e.message}`); 
    }
    isPolling = false;
}

app.get('/gate-status', (req, res) => res.json(virtuagymStatus));
app.get('/test-retention', async (req, res) => {
    runRetentionCheck();
    res.send("Retentie scan gestart. Check de logs!");
});
app.get('/', (req, res) => res.send('YVSPORT Connector is online.'));

app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    schedule.scheduleJob('0 10 * * *', runRetentionCheck);
    pollVirtuagym();
});
