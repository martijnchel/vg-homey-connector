const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL;

const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`;
const VG_MEMBERSHIP_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`;

let latestCheckinTimestamp = Date.now();
let isPolling = false;

// --- Helper: Check contract ---
async function getExpiringContractDetails(memberId) {
    try {
        const now = Date.now();
        const res = await axios.get(VG_MEMBERSHIP_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, sync_from: 0, limit: 5 }
        });
        const memberships = res.data.result || [];
        const expiring = memberships.find(m => {
            if (!m.contract_end_date) return false;
            const endMs = new Date(m.contract_end_date).getTime();
            return (endMs > now && endMs <= now + (4 * 7 * 24 * 60 * 60 * 1000));
        });
        return expiring ? expiring.contract_end_date : null;
    } catch (e) { return null; }
}

// --- Helper: Verwerk 1 lid en bouw de status-regel ---
async function processMemberStatus(memberId, checkinTime) {
    try {
        const [memberRes, expiringDate] = await Promise.all([
            axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { params: { api_key: API_KEY, club_secret: CLUB_SECRET } }),
            getExpiringContractDetails(memberId)
        ]);

        const memberData = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        if (!memberData) return null;

        const name = `${memberData.firstname} ${memberData.lastname || ''}`.trim();
        const amsTimeStr = new Date(checkinTime * 1000).toLocaleTimeString('nl-NL', { 
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
});

        let codes = "";
        // Verjaardag
        if (memberData.birthdate) {
            const today = new Date().toLocaleString("nl-NL", {timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit"});
            const birth = new Date(memberData.birthdate).toLocaleString("nl-NL", {day: "2-digit", month: "2-digit"});
            if (today === birth) codes += "[B]";
        }
        // Nieuw lid (30 dagen)
        if (memberData.registration_date) {
            if (Date.now() - new Date(memberData.registration_date).getTime() < (30 * 24 * 60 * 60 * 1000)) codes += "[N]";
        }
        // Contract
        if (expiringDate) codes += "[E]";

        return `${codes}${timeStr} - ${name}`;
    } catch (e) { return null; }
}

// --- De Polling Logica die alles verzamelt ---
async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;
    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp }
        });

        const visits = response.data.result || [];
        const newVisits = visits.filter(v => v.check_in_timestamp > latestCheckinTimestamp);

        if (newVisits.length > 0) {
            // Sorteer van oud naar nieuw voor de lijst
            newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

            // Verwerk alle leden parallel
            const statusPromises = newVisits.map(v => processMemberStatus(v.member_id, v.check_in_timestamp));
            const statusLines = (await Promise.all(statusPromises)).filter(line => line !== null);

            if (statusLines.length > 0) {
                // Voeg alle regels samen met een "newline" (\n)
                const payload = statusLines.join("\n");
                await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(payload)}`);
                console.log(`[VERSTUURD NAAR HOMEY]\n${payload}`);
            }
            
            latestCheckinTimestamp = Math.max(...newVisits.map(v => v.check_in_timestamp));
        }
    } catch (e) { console.error("Polling error:", e.message); }
    isPolling = false;
}

app.get('/', (req, res) => res.send('Virtuagym-Homey verzamel-service is actief.'));
app.listen(PORT, () => {
    console.log(`Service draait op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
});
