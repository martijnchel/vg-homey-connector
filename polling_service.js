const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten (Origineel)

// Configuratie via Omgevingsvariabelen
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

// Virtuagym API URL's
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 
const VG_MEMBERSHIP_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`; 

// Constanten voor checks
const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; 
const NEW_MEMBER_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];

// FIX: Start in seconden (Virtuagym formaat) vanaf NU om 429 errors te voorkomen
let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false; 

// =======================================================
// ONDERSTEUNENDE FUNCTIE: CONTRACT CHECK
// =======================================================
async function getExpiringContractDetails(memberId) {
    try {
        const now = Date.now();
        const response = await axios.get(VG_MEMBERSHIP_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, sync_from: 0, limit: 5 }
        });
        const memberships = response.data.result || [];
        const expiring = memberships.find(m => {
            if (!m.contract_end_date) return false;
            const endMs = new Date(m.contract_end_date).getTime();
            return (endMs > now && endMs <= now + CONTRACT_EXPIRY_THRESHOLD_MS && !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name));
        });
        return expiring ? expiring.contract_end_date : null;
    } catch (e) { return null; }
}

// =======================================================
// HOOFD WEBHOOK TRIGGER
// =======================================================
async function triggerHomeyIndividualWebhook(memberId, checkinTime) {
    if (!HOMEY_INDIVIDUAL_URL) return;
    try {
        // Haal lid-gegevens en contract-status parallel op
        const [memberRes, expiringDate] = await Promise.all([
            axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { params: { api_key: API_KEY, club_secret: CLUB_SECRET } }),
            getExpiringContractDetails(memberId)
        ]);

        const memberData = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        if (!memberData) return;

        const memberName = `${memberData.firstname} ${memberData.lastname || ''}`.trim();
        const now = new Date();
        
        // Gebruik de tijdnotatie zoals die voorheen werkte (checkinTime is in seconden)
        const amsTimeStr = new Date(checkinTime * 1000).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        // 1. Verjaardag Check
        let isBirthday = false;
        if (memberData.birthdate) {
            const todayStr = now.toLocaleString("nl-NL", {timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit"});
            const birthStr = new Date(memberData.birthdate).toLocaleString("nl-NL", {day: "2-digit", month: "2-digit"});
            isBirthday = (todayStr === birthStr);
        }

        // 2. Nieuw Lid Check
        let isNewMember = false;
        if (memberData.registration_date) {
            const regMs = new Date(memberData.registration_date).getTime();
            isNewMember = (Date.now() - regMs < NEW_MEMBER_THRESHOLD_MS);
        }

        // 3. Status Codes
        let statusCodes = "";
        if (isBirthday) statusCodes += "[B]";
        if (expiringDate) statusCodes += "[E]";
        if (isNewMember) statusCodes += "[N]";

        const tagValue = `${statusCodes}${amsTimeStr} - ${memberName}`;
        
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}`);
        console.log(`[VERSTUURD] ${tagValue}`);

    } catch (error) {
        console.error(`[FOUT] Webhook mislukt:`, error.message);
    }
}

// =======================================================
// POLLING LOGICA
// =======================================================
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
            // Sorteer van nieuw naar oud en pak de laatste (Originele logica)
            newVisits.sort((a, b) => b.check_in_timestamp - a.check_in_timestamp);
            const latestVisit = newVisits[0];
            
            await triggerHomeyIndividualWebhook(latestVisit.member_id, latestVisit.check_in_timestamp);
            latestCheckinTimestamp = latestVisit.check_in_timestamp;
        }
    } catch (e) { 
        if (e.response && e.response.status === 429) {
            console.error("429 Error: Te veel verzoeken. Virtuagym blokkeert ons tijdelijk.");
        } else {
            console.error("Polling error:", e.message); 
        }
    }
    isPolling = false;
}

// =======================================================
// SERVER START
// =======================================================
app.get('/', (req, res) => res.send('Virtuagym Polling Service Actief.'));

app.listen(PORT, () => {
    console.log(`Service gestart op poort ${PORT}`);
    console.log(`Start-timestamp: ${latestCheckinTimestamp}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
});
