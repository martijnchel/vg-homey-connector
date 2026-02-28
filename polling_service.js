const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; 

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_BASE = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}`;
const CONTRACT_EXPIRY_THRESHOLD_MS = 28 * 24 * 60 * 60 * 1000; // Exact 28 dagen
const NEW_MEMBER_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 dagen
const EXCLUDED_MEMBERSHIPS = ["Premium Flex", "Student Flex"]; // Namen van Flex-abos

let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false;

async function processCheckin(visit) {
    try {
        // 1. Haal Lid-info op (Verjaardag & Registratie)
        const memberRes = await axios.get(`${VG_BASE}/member/${visit.member_id}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        const member = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        
        await new Promise(r => setTimeout(r, 1500)); // Rustpauze voor API

        // 2. Haal Contract-info op (Einde Contract)
        const contractRes = await axios.get(`${VG_BASE}/membership/instance`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: visit.member_id, limit: 1 } 
        });
        const contracts = contractRes.data.result || [];

        const now = new Date();
        const nowMs = now.getTime();
        
        // --- CHECK 1: VERJAARDAG ---
        let isBirthday = false;
        if (member.birthdate) {
            const bday = new Date(member.birthdate);
            isBirthday = (now.getDate() === bday.getDate() && now.getMonth() === bday.getMonth());
        }

        // --- CHECK 2: NIEUW LID ---
        let isNewMember = false;
        if (member.registration_date) {
            const regMs = new Date(member.registration_date).getTime();
            isNewMember = (nowMs - regMs < NEW_MEMBER_THRESHOLD_MS);
        }

        // --- CHECK 3: EINDE CONTRACT ---
        let isExpiring = false;
        if (contracts.length > 0) {
            const c = contracts[0];
            if (c.contract_end_date && !EXCLUDED_MEMBERSHIPS.includes(c.membership_name)) {
                const endMs = new Date(c.contract_end_date).getTime();
                // Check of datum in de toekomst ligt EN binnen 28 dagen vanaf nu
                isExpiring = (endMs > nowMs && endMs <= (nowMs + CONTRACT_EXPIRY_THRESHOLD_MS));
            }
        }

        // Codes bouwen
        let status = "";
        if (isBirthday) status += "[B]";
        if (isExpiring) status += "[E]";
        if (isNewMember) status += "[N]";

        const timeStr = new Date(visit.check_in_timestamp * 1000).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        const tagValue = `${status}${timeStr} - ${member.firstname} ${member.lastname || ''}`;
        
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${visit.check_in_timestamp}`);
        console.log(`[VERSTUURD] ${tagValue} (Expiring: ${isExpiring})`);

    } catch (e) {
        console.error(`Fout bij verwerken lid ${visit.member_id}:`, e.message);
    }
}

async function poll() {
    if (isPolling) return;
    isPolling = true;
    try {
        const res = await axios.get(`${VG_BASE}/visits`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp } 
        });
        const visits = res.data.result || [];
        
        if (visits.length > 15) { // Iets ruimere lawine-stop
            latestCheckinTimestamp = visits[0].check_in_timestamp;
            isPolling = false;
            return;
        }

        const newVisits = visits.filter(v => v.check_in_timestamp > latestCheckinTimestamp);
        newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of newVisits) {
            await processCheckin(visit);
            latestCheckinTimestamp = visit.check_in_timestamp;
            await new Promise(r => setTimeout(r, 2000)); 
        }
    } catch (e) { console.error("Poll fout:", e.message); }
    isPolling = false;
}

app.get('/', (req, res) => res.send('Volledige Service Actief (B, E, N checks)'));
app.listen(PORT, () => setInterval(poll, POLLING_INTERVAL_MS));
