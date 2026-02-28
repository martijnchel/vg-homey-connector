// Virtuagym Polling Service voor Homey Integratie
const express = require('express');
const axios = require('axios');
const app = express();

// Gebruik de PORT die door Railway wordt geleverd
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten
const SCHEDULE_CHECK_INTERVAL_MS = 60000; // Controleer elke minuut voor rapportages

// Configuratie via Omgevingsvariabelen
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;

// Homey URL's
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 
const HOMEY_DAILY_TOTAL_URL = process.env.HOMEY_DAILY_TOTAL_URL; 
const HOMEY_DAILY_EXPIRING_REPORT_URL = process.env.HOMEY_DAILY_EXPIRING_REPORT_URL; 

// Virtuagym Base URL's
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 
const VG_MEMBERSHIP_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`; 

// Constanten
const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weken
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Statusvariabelen
let reportedMembersCache = {}; 
let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 
let hasTotalBeenSentToday = false; 
let hasReportBeenSentToday = false; 

const DAILY_TOTAL_TIME = '23:59'; 
const DAILY_REPORT_TIME = '09:00'; 

// =======================================================
// ONDERSTEUNENDE FUNCTIES
// =======================================================

async function getMemberName(memberId) {
    try {
        const response = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET }
        });
        const data = Array.isArray(response.data.result) ? response.data.result[0] : response.data.result;
        return data && data.firstname ? `${data.firstname} ${data.lastname || ''}`.trim() : `Lid ${memberId}`;
    } catch (e) { return `Lid ${memberId}`; }
}

async function checkIsBirthday(memberId) {
    try {
        const response = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET }
        });
        const data = Array.isArray(response.data.result) ? response.data.result[0] : response.data.result;
        if (data && data.birthdate) {
            const today = new Date().toLocaleString("nl-NL", {timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit"});
            const birthday = new Date(data.birthdate).toLocaleString("nl-NL", {day: "2-digit", month: "2-digit"});
            return today === birthday;
        }
    } catch (e) { console.error(`Fout bij verjaardagcheck lid ${memberId}`); }
    return false;
}

async function getExpiringContractDetails(memberId) {
    try {
        const now = Date.now();
        const response = await axios.get(VG_MEMBERSHIP_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, sync_from: 0, limit: 10 }
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

function getStartOfTodayUtc() {
    const amsDate = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); 
    return new Date(`${amsDate}T00:00:00`).getTime();
}

// =======================================================
// WEBHOOK TRIGGERS
// =======================================================

async function triggerHomeyIndividualWebhook(memberName, checkinTime, memberId) {
    if (!HOMEY_INDIVIDUAL_URL) return;
    try {
        // Voer checks parallel uit voor snelheid
        const [isExpiring, isBirthday] = await Promise.all([
            getExpiringContractDetails(memberId),
            checkIsBirthday(memberId)
        ]);

        const formattedTime = new Date(checkinTime).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        let statusPrefix = "";
        if (isBirthday) statusPrefix += "[B]";
        if (isExpiring) statusPrefix += "[E]";

        const tagValue = `${statusPrefix}${formattedTime} - ${memberName}`;
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${checkinTime}`);
        console.log(`[INDIVIDUEEL] Melding verstuurd: ${tagValue}`);
    } catch (error) { console.error("Fout bij Homey Individuele Webhook:", error.message); }
}

async function triggerHomeyDailyTotalWebhook(totalCount, isTest = false) {
    if (!HOMEY_DAILY_TOTAL_URL) return;
    try {
        const tagValue = (isTest ? "[TEST] " : "") + `Vandaag zijn er ${totalCount} leden ingecheckt.`;
        await axios.get(`${HOMEY_DAILY_TOTAL_URL.split('?')[0]}?tag=${encodeURIComponent(tagValue)}`);
        if (!isTest) hasTotalBeenSentToday = true;
    } catch (e) { console.error("Fout bij Totaal Webhook"); }
}

async function triggerHomeyDailyReportWebhook(reportText, isTest = false) {
    if (!HOMEY_DAILY_EXPIRING_REPORT_URL) return;
    try {
        const tagValue = (isTest ? "[TEST RAPPORT] " : "") + reportText;
        await axios.get(`${HOMEY_DAILY_EXPIRING_REPORT_URL.split('?')[0]}?tag=${encodeURIComponent(tagValue)}`);
        if (!isTest) hasReportBeenSentToday = true;
    } catch (e) { console.error("Fout bij Rapport Webhook"); }
}

// =======================================================
// SCHEDULERS & POLLING
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
            newVisits.sort((a, b) => b.check_in_timestamp - a.check_in_timestamp);
            const latestVisit = newVisits[0];
            const memberName = await getMemberName(latestVisit.member_id);
            await triggerHomeyIndividualWebhook(memberName, latestVisit.check_in_timestamp, latestVisit.member_id);
            latestCheckinTimestamp = latestVisit.check_in_timestamp;
        }
    } catch (e) { console.error("Polling error:", e.message); }
    isPolling = false;
}

// ... De overige functies zoals sendExpiringContractsReport, sendDailyTotal en de timers 
// blijven functioneel zoals in je originele code, maar roepen de triggers hierboven aan.

// (Ik heb hieronder de server-start en basisfuncties behouden voor een werkend bestand)

app.get('/', (req, res) => res.send('Virtuagym-Homey Service is online.'));

app.listen(PORT, () => {
    console.log(`Service draait op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    // Voeg hier ook de checkDailyTotalSchedule en checkMorningReportSchedule intervallen toe zoals in je oude code
});
