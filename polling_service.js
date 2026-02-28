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

const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; 
const NEW_MEMBER_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];

// Start op de huidige tijd
let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 

async function getExpiringContractDetails(memberId) {
    try {
        const response = await axios.get(VG_MEMBERSHIP_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, sync_from: 0, limit: 1 }
        });
        const memberships = response.data.result || [];
        const now = Date.now();
        const expiring = memberships.find(m => {
            if (!m.contract_end_date) return false;
            const endMs = new Date(m.contract_end_date).getTime();
            return (endMs > now && endMs <= now + CONTRACT_EXPIRY_THRESHOLD_MS && !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name));
        });
        return expiring ? expiring.contract_end_date : null;
    } catch (e) { return null; }
}

async function triggerHomeyIndividualWebhook(memberId, checkinTime) {
    if (!HOMEY_INDIVIDUAL_URL) return;
    try {
        const [memberRes, expiringDate] = await Promise.all([
            axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { params: { api_key: API_KEY, club_secret: CLUB_SECRET } }),
            getExpiringContractDetails(memberId)
        ]);

        const memberData = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        if (!memberData) return;

        const memberName = `${memberData.firstname} ${memberData.lastname || ''}`.trim();
        const now = new Date();
        
        // Tijdweergave (Railway stuurt ts mee naar Homey)
        const amsTimeStr = new Date(checkinTime).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        // 1. Verjaardag Check (Dag & Maand vergelijking)
        let isBirthday = false;
        if (memberData.birthdate) {
            const birthDate = new Date(memberData.birthdate);
            isBirthday = (now.getDate() === birthDate.getDate() && now.getMonth() === birthDate.getMonth());
        }

        // 2. Nieuw Lid Check (30 dagen)
        let isNewMember = false;
        if (memberData.registration_date) {
            const regMs = new Date(memberData.registration_date).getTime();
            isNewMember = (Date.now() - regMs < NEW_MEMBER_THRESHOLD_MS);
        }

        // 3. Status Codes opbouwen
        let statusCodes = "";
        if (isBirthday) statusCodes += "[B]";
        if (expiringDate) statusCodes += "[E]";
        if (isNewMember) statusCodes += "[N]";

        const tagValue = `${statusCodes}${amsTimeStr} - ${memberData.firstname} ${memberData.lastname || ''}`;
        
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${checkinTime}`);
        console.log(`[VERSTUURD] ${tagValue} (Nieuw: ${isNewMember}, Jarig: ${isBirthday})`);

    } catch (error) { console.error("Fout bij lid:", error.message); }
}

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;
    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp }
        });
        const visits = response.data.result || [];

        // LAWINE-STOP: Als er ineens meer dan 10 mensen komen, reset de tijd naar 'nu' zonder te sturen.
        if (visits.length > 10) {
            console.warn(`Lawine-stop: ${visits.length} oude check-ins genegeerd. Systeem gesynchroniseerd.`);
            latestCheckinTimestamp = visits[0].check_in_timestamp;
            isPolling = false;
            return;
        }

        const newVisits = visits.filter(v => v.check_in_timestamp > latestCheckinTimestamp);

        if (newVisits.length > 0) {
            newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);
            for (const visit of newVisits) {
                await triggerHomeyIndividualWebhook(visit.member_id, visit.check_in_timestamp);
                latestCheckinTimestamp = visit.check_in_timestamp;
                await new Promise(r => setTimeout(r, 1000)); // 1 sec rust tussen webhooks
            }
        }
    } catch (e) { console.error("Polling error:", e.message); }
    isPolling = false;
}

app.get('/', (req, res) => res.send('Virtuagym-Homey Service Actief.'));
app.listen(PORT, () => {
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
});
