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
const VG_MEMBERSHIP_DEF_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/definition`;

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

// --- RETENTIE FUNCTIE (v7.0 - BREDE SCAN) ---
async function runRetentionCheck() {
    console.log("[RETENTIE] Start brede controle op inactieve leden...");
    const drieMaandenInMs = 90 * 24 * 60 * 60 * 1000;
    const grensDatum = Date.now() - drieMaandenInMs;

    try {
        // 1. Haal ALLE lidmaatschapdefinities op (ook gearchiveerde)
        console.log("[RETENTIE] Definities ophalen (status: all)...");
        const defRes = await axios.get(VG_MEMBERSHIP_DEF_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, status: 'all' }
        });

        const targetIds = (defRes.data.result || [])
            .filter(d => {
                const name = (d.membership_name || "").toLowerCase();
                // Filter op trefwoorden, negeer Flex
                return (name.includes("focus") || name.includes("complete")) && !name.includes("flex");
            })
            .map(d => d.membership_id);

        console.log(`[RETENTIE] ${targetIds.length} Target ID's gevonden: ${targetIds.join(', ')}`);

        if (targetIds.length === 0) {
            console.log("[RETENTIE] Geen abonnementen gevonden met 'Focus' of 'Complete'. Scan gestopt.");
            return;
        }

        // 2. Haal alle leden op (Paging voor > 500 leden)
        let allMembers = [];
        let page = 0;
        let hasMore = true;

        while (hasMore) {
            console.log(`[RETENTIE] Leden ophalen pagina ${page}...`);
            const res = await axios.get(VG_MEMBER_BASE_URL, {
                params: { api_key: API_KEY, club_secret: CLUB_SECRET, with: 'active_memberships', page: page }
            });
            const results = res.data.result || [];
            allMembers = allMembers.concat(results);
            
            if (results.length < 500) hasMore = false;
            else page++;
            if (page > 15) hasMore = false; // Veiligheidsstop voor zeer grote databases
        }

        console.log(`[RETENTIE] Analyse van ${allMembers.length} leden gestart...`);
        let foundCount = 0;

        for (const m of allMembers) {
            // Alleen actieve leden bekijken
            if (m.active !== 1) continue;

            const lastVisitTs = m.last_visit ? new Date(m.last_visit).getTime() : 0;
            
            // Is het lid 90 dagen niet geweest (of nooit)?
            if (lastVisitTs === 0 || lastVisitTs < grensDatum) {
                
                const memberships = m.memberships || [];
                // Check of een van de lidmaatschappen van dit lid voorkomt in onze target-lijst
                const hasMatch = memberships.some(ms => ms.active === 1 && targetIds.includes(ms.membership_id));

                if (hasMatch) {
                    // Telefoonnummer opschonen
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
                        }).catch(() => {});
                        console.log(`[RETENTIE] MATCH: ${m.firstname} (Lid-ID: ${m.member_id}) -> Make`);
                    }
                }
            }
        }
        console.log(`[RETENTIE] Scan voltooid. ${foundCount} leden naar Make gestuurd.`);
    } catch (e) {
        console.error("[RETENTIE] Kritieke fout:", e.message);
    }
}

// --- ORIGINELE CHECK-IN LOGICA (ONGEWIJZIGD) ---
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
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    schedule.scheduleJob('0 10 * * *', runRetentionCheck);
    pollVirtuagym();
});
