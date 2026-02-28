// Virtuagym Polling Service voor Homey Integratie met Status Checks
const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten
const SCHEDULE_CHECK_INTERVAL_MS = 60000; 

// Configuratie via Omgevingsvariabelen
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 
const HOMEY_DAILY_TOTAL_URL = process.env.HOMEY_DAILY_TOTAL_URL; 
const HOMEY_DAILY_EXPIRING_REPORT_URL = process.env.HOMEY_DAILY_EXPIRING_REPORT_URL; 

// Virtuagym Base URL's
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 
const VG_MEMBERSHIP_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`; 

// Constanten
const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weken
const NEW_MEMBER_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 dagen
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];

// Statusvariabelen - Start op NU (in seconden)
let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false; 
let hasTotalBeenSentToday = false; 
let hasReportBeenSentToday = false; 

// =======================================================
// ONDERSTEUNENDE FUNCTIES (API CALLS)
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
// HOOFD WEBHOOK TRIGGER (Individueel)
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
        
        // Tijdweergave fix (checkinTime * 1000 voor milliseconden)
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

        // 2. Nieuw Lid Check (30 dagen)
        let isNewMember = false;
        if (memberData.registration_date) {
            const regMs = new Date(memberData.registration_date).getTime();
            isNewMember = (Date.now() - regMs < NEW_MEMBER_THRESHOLD_MS);
        }

        // 3. Status Codes bouwen
        let statusCodes = "";
        if (isBirthday) statusCodes += "[B]";
        if (expiringDate) statusCodes += "[E]";
        if (isNewMember) statusCodes += "[N]";

        const tagValue = `${statusCodes}${amsTimeStr} - ${memberName}`;
        
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${checkinTime}`);
        console.log(`[VERSTUURD] ${tagValue}`);

    } catch (error) {
        console.error(`[FOUT] Webhook voor lid ${memberId} mislukt:`, error.message);
    }
}

// =======================================================
// POLLING LOGICA (AANGEPAST VOOR ALLE CHECK-INS)
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
            // Sorteer van oud naar nieuw (voor juiste volgorde in Homey)
            newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

            // Verwerk ELKE nieuwe check-in
            for (const visit of newVisits) {
                await triggerHomeyIndividualWebhook(visit.member_id, visit.check_in_timestamp);
                
                // Update timestamp na elke verwerking
                latestCheckinTimestamp = visit.check_in_timestamp;

                // Wacht 1 seconde tussen personen om de API te ontlasten
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    } catch (e) { 
        console.error("Polling error:", e.message); 
    }
    isPolling = false;
}

// =======================================================
// SERVER START
// =======================================================

app.get('/', (req, res) => res.send('Virtuagym Polling Service Actief (Alle check-ins).'));

app.listen(PORT, () => {
    console.log(`Service gestart op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    console.log("Polling actief...");
});
