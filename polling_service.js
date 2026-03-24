const express = require('express');
const axios = require('axios');
const schedule = require('node-schedule');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 30000; 

// Omgevingsvariabelen vanuit Railway
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

// Vul hier je nieuwe Make Webhook in als je klaar bent voor de echte verzending
const RETENTION_WEBHOOK_URL = "JOUW_MAKE_WEBHOOK_URL"; 

let latestCheckinTimestamp = Date.now(); 
let isPolling = false;

// --- RETENTIE LOGICA v12.0 (Lichtgewicht & Directe Logging) ---
async function runRetentionCheck() {
    console.log("[RETENTIE] Start Lichtgewicht Diagnose v12.0...");
    const drieMaandenInMs = 90 * 24 * 60 * 60 * 1000;
    const grensTimestamp = Date.now() - drieMaandenInMs;

    try {
        // 1. Haal bezoeken op (wie was er wél?)
        const visitRes = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: grensTimestamp }
        });
        const recentVisitors = new Set((visitRes.data.result || []).map(v => v.member_id));
        console.log(`[RETENTIE] ${recentVisitors.size} unieke bezoekers gevonden in de laatste 90 dagen.`);

        // 2. Scan contracten stap voor stap (paging)
        let fromId = 0;
        let hasMore = true;
        let matchCount = 0;

        while (hasMore && matchCount < 20) {
            const res = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`, {
                params: { api_key: API_KEY, club_secret: CLUB_SECRET, from_id: fromId }
            });
            
            const instances = res.data.result || [];
            if (instances.length === 0) { hasMore = false; break; }

            for (const ins of instances) {
                const name = (ins.membership_name || "").toLowerCase();
                const isTargetAbo = (name.includes("focus") || name.includes("complete")) && !name.includes("flex");

                // Check: Actief contract, juiste type, en NIET onlangs gescand
                if (ins.active === true && isTargetAbo && !recentVisitors.has(ins.member_id)) {
                    
                    try {
                        // Haal nu pas lid-details op voor de naam/status
                        const mRes = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member/${ins.member_id}`, {
                            params: { api_key: API_KEY, club_secret: CLUB_SECRET }
                        });
                        const m = mRes.data.result;
                        
                        if (m && m.active === 1) {
                            matchCount++;
                            console.log(`[MATCH ${matchCount}] ${m.firstname} ${m.lastname || ''} | Abo: ${ins.membership_name} | Laatste bezoek: ${m.last_visit || 'Nooit'}`);
                            
                            // OPTIONEEL: Zet dit aan als de namen in de logs kloppen:
                            /*
                            await axios.post(RETENTION_WEBHOOK_URL, {
                                member_id: m.member_id,
                                firstname: m.firstname,
                                phone: (m.mobile || m.phone || "").replace(/\D/g, ''),
                                membership: ins.membership_name
                            }).catch(() => {});
                            */
                        }
                    } catch (err) { /* overslaan bij fout */ }
                }
                if (matchCount >= 20) break; 
                await new Promise(r => setTimeout(r, 100)); // Kleine adempauze
            }

            fromId = instances[instances.length - 1].instance_id;
            if (instances.length < 100) hasMore = false;
        }

        console.log("[RETENTIE] Diagnose voltooid. Zie lijst hierboven.");
    } catch (e) {
        console.error("[RETENTIE] Kritieke fout:", e.message);
    }
}

// --- CHECK-IN LOGICA (Voor Homey/Meldingen) ---
async function getEnhancedMemberData(memberId) {
    try {
        const res = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        let data = res.data.result;
        if (Array.isArray(data)) data = data[0];
        if (!data) return { name: `Lid ${memberId}`, codes: "" };

        const nu = new Date();
        let codes = "";
        if (data.birthday) {
            const bday = new Date(data.birthday);
            if (bday.getDate() === nu.getDate() && bday.getMonth() === nu.getMonth()) codes += "[B]";
        }
        return { name: `${data.firstname} ${data.lastname || ''}`.trim(), codes };
    } catch (e) { return { name: `Lid ${memberId}`, codes: "" }; }
}

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;
    try {
        const response = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp }
        });

        const visits = (response.data.result || [])
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of visits) {
            const memberInfo = await getEnhancedMemberData(visit.member_id);
            const time = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
            const msg = `${visit.status === "rejected" ? "[X]" : ""}${memberInfo.codes}${time} - ${memberInfo.name}`;
            
            if (HOMEY_INDIVIDUAL_URL) {
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(msg)}`);
            }
            console.log(`[SCAN] ${msg}`);
            latestCheckinTimestamp = visit.check_in_timestamp;
        }
    } catch (e) { console.error("Poll error:", e.message); }
    isPolling = false;
}

// --- ROUTES ---
app.get('/', (req, res) => res.send('Connector is Online.'));

app.get('/test-retention', (req, res) => {
    runRetentionCheck(); // Start op de achtergrond
    res.send('Retentie check gestart! Bekijk de Railway Logs voor de resultaten.');
});

// --- STARTUP ---
app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    schedule.scheduleJob('0 10 * * *', runRetentionCheck); // Elke ochtend om 10:00
});
