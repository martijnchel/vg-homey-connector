const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 180000; // PRECIES ELKE 3 MINUTEN

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_BASE = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}`;
const CONTRACT_EXPIRY_THRESHOLD_MS = 28 * 24 * 60 * 60 * 1000; 
const NEW_MEMBER_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false;
let coolingDown = false; 

async function processCheckin(visit) {
    try {
        // Stap 1: Lid info (Verjaardag & Registratie)
        const memberRes = await axios.get(`${VG_BASE}/member/${visit.member_id}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        const member = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        
        // PAUZE VAN 3 SECONDEN TUSSEN API CALLS
        await new Promise(r => setTimeout(r, 3000)); 

        // Stap 2: Contract info (Einde Contract)
        const contractRes = await axios.get(`${VG_BASE}/membership/instance`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: visit.member_id, limit: 1 } 
        });
        const contracts = contractRes.data.result || [];

        const now = new Date();
        let status = "";
        
        // Check 1: Verjaardag
        if (member && member.birthdate) {
            const bday = new Date(member.birthdate);
            if (now.getDate() === bday.getDate() && now.getMonth() === bday.getMonth()) status += "[B]";
        }

        // Check 2: Nieuw Lid
        if (member && member.registration_date) {
            if (Date.now() - new Date(member.registration_date).getTime() < NEW_MEMBER_THRESHOLD_MS) status += "[N]";
        }

        // Check 3: Einde Contract
        if (contracts.length > 0) {
            const c = contracts[0];
            if (c.contract_end_date) {
                const endMs = new Date(c.contract_end_date).getTime();
                if (endMs > Date.now() && endMs <= (Date.now() + CONTRACT_EXPIRY_THRESHOLD_MS)) status += "[E]";
            }
        }

        const timeStr = new Date(visit.check_in_timestamp * 1000).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        const tagValue = `${status}${timeStr} - ${member.firstname} ${member.lastname || ''}`;
        
        // Verstuur naar Homey
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${visit.check_in_timestamp}`);
        console.log(`[VERSTUURD] ${tagValue}`);

    } catch (e) {
        if (e.response && e.response.status === 429) {
            coolingDown = true;
            setTimeout(() => { coolingDown = false; }, 600000); // 10 min rust
        }
        console.error("Fout bij verwerken:", e.message);
    }
}

async function poll() {
    if (isPolling || coolingDown) return;
    isPolling = true;
    try {
        const res = await axios.get(`${VG_BASE}/visits`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp } 
        });
        const visits = res.data.result || [];
        
        // Lawine-stop
        if (visits.length > 15) {
            latestCheckinTimestamp = visits[0].check_in_timestamp;
            isPolling = false;
            return;
        }

        const newVisits = visits.filter(v => v.check_in_timestamp > latestCheckinTimestamp);
        newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of newVisits) {
            await processCheckin(visit);
            latestCheckinTimestamp = visit.check_in_timestamp;
            // 3 SECONDEN PAUZE TUSSEN LEDEN
            await new Promise(r => setTimeout(r, 3000)); 
        }
    } catch (e) {
        if (e.response && e.response.status === 429) coolingDown = true;
    }
    isPolling = false;
}

app.get('/', (req, res) => res.send('3-minuten Polling Actief'));
app.listen(PORT, () => setInterval(poll, POLLING_INTERVAL_MS));
