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

async function runRetentionCheck() {
    console.log("[RETENTIE] Start v10.0 (Cross-reference Check)...");
    const drieMaandenInMs = 90 * 24 * 60 * 60 * 1000;
    const grensTimestamp = Date.now() - drieMaandenInMs;

    try {
        // 1. Haal alle bezoeken op van de afgelopen 90 dagen
        console.log("[RETENTIE] Bezoeken van laatste 90 dagen ophalen...");
        const visitRes = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: grensTimestamp }
        });
        
        const recentVisitors = new Set((visitRes.data.result || []).map(v => v.member_id));
        console.log(`[RETENTIE] ${recentVisitors.size} unieke leden zijn onlangs langs geweest.`);

        // 2. Haal alle actieve contracten op (Instances)
        let allInstances = [];
        let fromId = 0;
        let hasMore = true;
        while (hasMore) {
            const res = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`, {
                params: { api_key: API_KEY, club_secret: CLUB_SECRET, from_id: fromId }
            });
            const results = res.data.result || [];
            allInstances = allInstances.concat(results);
            if (results.length < 100) hasMore = false;
            else fromId = results[results.length - 1].instance_id;
            if (allInstances.length > 5000) hasMore = false;
        }

        // 3. Filter op Focus/Complete & Niet aanwezig in recentVisitors
        const targetInstances = allInstances.filter(ins => {
            const name = (ins.membership_name || "").toLowerCase();
            const isTargetAbo = (name.includes("focus") || name.includes("complete")) && !name.includes("flex");
            return ins.active === true && isTargetAbo && !recentVisitors.has(ins.member_id);
        });

        console.log(`[RETENTIE] ${targetInstances.length} slapende Focus/Complete leden gevonden.`);

        // 4. Details ophalen en naar Make sturen
        let foundCount = 0;
        for (const ins of targetInstances) {
            try {
                const mRes = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member/${ins.member_id}`, {
                    params: { api_key: API_KEY, club_secret: CLUB_SECRET }
                });
                const m = mRes.data.result;
                if (!m || m.active !== 1) continue;

                let rawPhone = m.mobile || m.phone || "";
                let cleanPhone = rawPhone.replace(/\D/g, ''); 
                if (cleanPhone.startsWith('06')) cleanPhone = '31' + cleanPhone.substring(1);

                if (cleanPhone.length >= 10) {
                    foundCount++;
                    await axios.post(RETENTION_WEBHOOK_URL, {
                        event: "retention_90_days",
                        member_id: m.member_id,
                        firstname: m.firstname,
                        phone: cleanPhone,
                        membership: ins.membership_name,
                        last_visit_api: m.last_visit || "Onbekend"
                    });
                    console.log(`[RETENTIE] MATCH: ${m.firstname} (${ins.membership_name})`);
                }
                await new Promise(r => setTimeout(r, 150)); // Rate limit protection
            } catch (err) { continue; }
        }
        console.log(`[RETENTIE] Klaar. ${foundCount} naar Make.`);
    } catch (e) {
        console.error("[RETENTIE] Fout:", e.message);
    }
}

// --- ORIGINELE CHECK-IN LOGICA (ONGEWIJZIGD) ---
async function getEnhancedMemberData(memberId) {
    try {
        const res = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member/${memberId}`, { 
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
        return { name: fullName, codes: `${codes.B}${codes.N}` };
    } catch (e) { return { name: `Lid ${memberId}`, codes: "" }; }
}

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;
    try {
        const response = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp },
            timeout: 15000 
        });
        errorCount = 0; 
        virtuagymStatus.online = true;
        const visits = (response.data.result || [])
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of visits) {
            const memberInfo = await getEnhancedMemberData(visit.member_id);
            const time = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
            const tagValue = `${visit.status === "rejected" ? "[X]" : ""}${memberInfo.codes}${time} - ${memberInfo.name}`;
            if (HOMEY_INDIVIDUAL_URL) {
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
                console.log(`[RAILWAY] Scan: ${memberInfo.name}`);
            }
            latestCheckinTimestamp = visit.check_in_timestamp;
        }
    } catch (e) { console.error(`Poll fout: ${e.message}`); }
    isPolling = false;
}

let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 
let errorCount = 0;
let virtuagymStatus = { online: true, lastUpdate: new Date().toISOString() };

app.get('/test-retention', (req, res) => { runRetentionCheck(); res.send("Gestart!"); });
app.get('/', (req, res) => res.send('Online.'));

app.listen(PORT, () => {
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    schedule.scheduleJob('0 10 * * *', runRetentionCheck);
    pollVirtuagym();
});
