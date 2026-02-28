const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 180000; // Exact elke 3 minuten

// Configuratie via Omgevingsvariabelen
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_BASE = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}`;
const CONTRACT_EXPIRY_THRESHOLD_MS = 28 * 24 * 60 * 60 * 1000; // 4 weken
const NEW_MEMBER_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 dagen

// We starten met de tijd van NU om oude "lawines" te voorkomen
let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false;
let coolingDown = false; 

// =======================================================
// PROCES: ÉÉN LID VERWERKEN (INCLUSIEF ALLE CHECKS)
// =======================================================
async function processCheckin(visit) {
    try {
        console.log(`[DEBUG] Verwerken van lid ID: ${visit.member_id}`);

        // 1. Haal Lid-info op (Verjaardag & Registratie)
        const memberRes = await axios.get(`${VG_BASE}/member/${visit.member_id}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        const member = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        
        // 3 SECONDEN PAUZE tussen API calls om 429 te voorkomen
        await new Promise(r => setTimeout(r, 3000)); 

        // 2. Haal Contract-info op (Einde Contract)
        const contractRes = await axios.get(`${VG_BASE}/membership/instance`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: visit.member_id, limit: 1 } 
        });
        const contracts = contractRes.data.result || [];

        const now = new Date();
        const nowMs = now.getTime();
        let status = "";
        
        if (member) {
            // --- CHECK 1: VERJAARDAG (NL Tijdzone match) ---
            if (member.birthdate) {
                const bday = new Date(member.birthdate);
                if (now.getDate() === bday.getDate() && now.getMonth() === bday.getMonth()) {
                    status += "[B]";
                }
            }

            // --- CHECK 2: NIEUW LID (Binnen 30 dagen) ---
            if (member.registration_date) {
                const regMs = new Date(member.registration_date).getTime();
                if (nowMs - regMs < NEW_MEMBER_THRESHOLD_MS) {
                    status += "[N]";
                }
            }
        }

        // --- CHECK 3: EINDE CONTRACT (Binnen 28 dagen) ---
        if (contracts.length > 0) {
            const c = contracts[0];
            if (c.contract_end_date) {
                const endMs = new Date(c.contract_end_date).getTime();
                if (endMs > nowMs && endMs <= (nowMs + CONTRACT_EXPIRY_THRESHOLD_MS)) {
                    status += "[E]";
                }
            }
        }

        // Tijd van inchecken formatteren
        const timeStr = new Date(visit.check_in_timestamp * 1000).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        const memberName = member ? `${member.firstname} ${member.lastname || ''}` : "Onbekend Lid";
        const tagValue = `${status}${timeStr} - ${memberName}`;
        
        // Verstuur naar Homey
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${visit.check_in_timestamp}`);
        console.log(`[SUCCES] Webhook verzonden: ${tagValue}`);

    } catch (e) {
        console.error(`[FOUT] Lid ${visit.member_id} mislukt:`, e.message);
        if (e.response && e.response.status === 429) {
            console.warn("!!!! 429 ERROR: Virtuagym blokkeert ons. 10 min pauze. !!!!");
            coolingDown = true;
            setTimeout(() => { coolingDown = false; }, 600000); 
        }
    }
}

// =======================================================
// HOOFD-LOOP: ELKE 3 MINUTEN POLLEN
// =======================================================
async function poll() {
    if (isPolling || coolingDown) {
        const reden = coolingDown ? "Afkoelperiode (429)" : "Vorige poll loopt nog";
        console.log(`[DEBUG] Poll overgeslagen: ${reden}`);
        return;
    }
    
    isPolling = true;
    console.log(`[${new Date().toLocaleTimeString('nl-NL')}] Start check Virtuagym...`);

    try {
        const res = await axios.get(`${VG_BASE}/visits`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp } 
        });
        
        const visits = res.data.result || [];
        // Filter alleen de scans die ECHT na onze laatste scan zijn gedaan
        const newVisits = visits.filter(v => v.check_in_timestamp > latestCheckinTimestamp);
        
        console.log(`Totaal in API: ${visits.length} | Nieuw sinds vorige check: ${newVisits.length}`);

        if (newVisits.length > 0) {
            // Sorteer van OUD naar NIEUW
            newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

            for (const visit of newVisits) {
                await processCheckin(visit);
                // Update onze 'bladwijzer' direct na elke geslaagde scan
                latestCheckinTimestamp = visit.check_in_timestamp;
                
                // 3 SECONDEN PAUZE tussen leden
                await new Promise(r => setTimeout(r, 3000)); 
            }
        }
    } catch (e) {
        console.error("[POLL FOUT]:", e.message);
        if (e.response && e.response.status === 429) {
            coolingDown = true;
            setTimeout(() => { coolingDown = false; }, 600000);
        }
    }
    isPolling = false;
    console.log(`[${new Date().toLocaleTimeString('nl-NL')}] Poll afgerond.`);
}

// =======================================================
// SERVER START
// =======================================================
app.get('/', (req, res) => res.send('Virtuagym-Homey Service is online.'));

app.listen(PORT, () => {
    console.log(`Service gestart op poort ${PORT}`);
    // Start de interval
    setInterval(poll, POLLING_INTERVAL_MS);
    // Voer ook direct een eerste poll uit bij opstarten
    poll();
});
