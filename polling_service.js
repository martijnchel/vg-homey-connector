// Virtuagym Polling Service voor Homey Integratie
const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; 
const SCHEDULE_CHECK_INTERVAL_MS = 60000;

// Configuratie
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

const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000;
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let reportedMembersCache = {}; 
const DAILY_TOTAL_TIME = '23:59'; 
const DAILY_REPORT_TIME = '09:00'; 

// Statusvariabelen - We starten met 'nu' om oude rommel te voorkomen
let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false; 
let hasTotalBeenSentToday = false; 
let hasReportBeenSentToday = false; 

// --- HULPFUNCTIES (ONGEWIJZIGD) ---

function checkAndRecordReportedStatus(memberId) {
    const now = Date.now();
    const lastReported = reportedMembersCache[memberId] || 0;
    if (now - lastReported < ONE_WEEK_MS) return false;
    reportedMembersCache[memberId] = now;
    return true;
}

function getStartOfTodayUtc() {
    const today = new Date();
    const amsDateString = today.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); 
    return new Date(`${amsDateString}T00:00:00`).getTime();
}

function getYesterdayTimeRange() {
    const startOfToday = getStartOfTodayUtc();
    return { start: startOfToday - (24 * 60 * 60 * 1000), end: startOfToday };
}

// --- WEBHOOK TRIGGERS ---

async function triggerHomeyIndividualWebhook(memberName, checkinTime) {
    if (!HOMEY_INDIVIDUAL_URL) return;
    try {
        const checkinDate = new Date(checkinTime * 1000);
        const formattedTime = checkinDate.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
        const tagValue = `${memberName} is nu ingecheckt om ${formattedTime}.`;
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${checkinTime}`);
        console.log(`[VERSTUURD] ${tagValue}`);
    } catch (error) { console.error("Fout Homey Individual:", error.message); }
}

async function triggerHomeyDailyTotalWebhook(totalCount, isTest = false) {
    if (!HOMEY_DAILY_TOTAL_URL) return;
    try {
        const tagValue = (isTest ? "[TEST] " : "") + `Vandaag zijn er ${totalCount} leden ingecheckt.`;
        await axios.get(`${HOMEY_DAILY_TOTAL_URL.split('?')[0]}?tag=${encodeURIComponent(tagValue)}`);
        if (!isTest) hasTotalBeenSentToday = true;
    } catch (e) { console.error("Fout Daily Total:", e.message); }
}

async function triggerHomeyDailyReportWebhook(reportText, isTest = false) {
    if (!HOMEY_DAILY_EXPIRING_REPORT_URL) return;
    try {
        const tagValue = (isTest ? "[TEST RAPPORT] " : "") + reportText;
        await axios.get(`${HOMEY_DAILY_EXPIRING_REPORT_URL.split('?')[0]}?tag=${encodeURIComponent(tagValue)}`);
        if (!isTest) hasReportBeenSentToday = true;
    } catch (e) { console.error("Fout Daily Report:", e.message); }
}

// --- API FETCHERS ---

async function getMemberName(memberId) {
    try {
        const res = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { params: { api_key: API_KEY, club_secret: CLUB_SECRET } });
        const data = Array.isArray(res.data.result) ? res.data.result[0] : res.data.result;
        return data ? `${data.firstname} ${data.lastname || ''}`.trim() : `Lid ${memberId}`;
    } catch (e) { return `Lid ${memberId}`; }
}

async function getExpiringContractDetails(memberId) {
    try {
        const res = await axios.get(VG_MEMBERSHIP_BASE_URL, { params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, sync_from: 0, limit: 10 } });
        const memberships = res.data.result || [];
        const expiring = memberships.find(m => {
            if (!m.contract_end_date) return false;
            const endMs = new Date(m.contract_end_date).getTime();
            return endMs > Date.now() && endMs <= (Date.now() + CONTRACT_EXPIRY_THRESHOLD_MS) && !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name);
        });
        return expiring ? expiring.contract_end_date : null;
    } catch (e) { return null; }
}

// --- POLLING LOGICA (AANGEPAST VOOR MEERDERE CHECK-INS) ---

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;

    console.log(`--- [POLL] Check op ${new Date().toLocaleTimeString()} ---`);

    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp }
        });

        const visits = response.data.result || [];
        const nuSeconds = Math.floor(Date.now() / 1000);

        // Filter: 1. Moet nieuwer zijn dan laatste check. 2. MAG NIET OUDER DAN 5 MINUTEN ZIJN.
        const newVisits = visits.filter(v => 
            v.check_in_timestamp > latestCheckinTimestamp && 
            (nuSeconds - v.check_in_timestamp) < 300
        );

        if (newVisits.length > 0) {
            // Sorteer van oud naar nieuw voor de juiste volgorde in Homey
            newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

            for (const visit of newVisits) {
                const name = await getMemberName(visit.member_id);
                await triggerHomeyIndividualWebhook(name, visit.check_in_timestamp);
                
                // Update de timestamp per verwerkt lid
                latestCheckinTimestamp = visit.check_in_timestamp;
                
                // Kleine pauze tussen meldingen om API en Homey rust te geven
                await new Promise(r => setTimeout(r, 1000));
            }
        } else {
            // Geen actuele scans? We schuiven de grens op naar NU om ophoping te voorkomen
            latestCheckinTimestamp = nuSeconds;
            console.log("Geen actuele nieuwe check-ins.");
        }
    } catch (error) {
        console.error("Poll fout:", error.message);
    }

    isPolling = false;
}

// --- SCHEDULER FUNCTIES (ONGEWIJZIGD) ---

async function sendExpiringContractsReport(isTest = false) {
    try {
        const { start, end } = getYesterdayTimeRange();
        const res = await axios.get(VG_VISITS_BASE_URL, { params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: Math.floor(start/1000), sync_to: Math.floor(end/1000), limit: 1000 } });
        const visits = res.data.result || [];
        const uniqueIds = Array.from(new Set(visits.map(v => v.member_id).filter(id => id)));
        const toReport = [];
        for (const id of uniqueIds) {
            const endDate = await getExpiringContractDetails(id);
            if (endDate && checkAndRecordReportedStatus(id)) {
                const name = await getMemberName(id);
                toReport.push(name);
            }
            await new Promise(r => setTimeout(r, 500));
        }
        let text = toReport.length === 0 ? "Geen nieuwe aflopende contracten gevonden gisteren." : `🔔 CONTRACTEN: ${toReport.join(', ')}.`;
        await triggerHomeyDailyReportWebhook(text, isTest);
    } catch (e) { console.error("Rapportage fout:", e.message); }
}

async function sendDailyTotal(isTest = false) {
    try {
        const start = getStartOfTodayUtc();
        const res = await axios.get(VG_VISITS_BASE_URL, { params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: Math.floor(start/1000), limit: 1000 } });
        const uniqueIds = new Set((res.data.result || []).map(v => v.member_id));
        await triggerHomeyDailyTotalWebhook(uniqueIds.size, isTest);
    } catch (e) { console.error("Dagtotaal fout:", e.message); }
}

// --- SERVER START ---

app.get('/', (req, res) => res.send('Virtuagym-Homey Connector: Actief & Gefilterd.'));

app.listen(PORT, () => {
    console.log(`Server gestart op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    setInterval(() => {
        const amsTime = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
        if (amsTime === DAILY_TOTAL_TIME && !hasTotalBeenSentToday) sendDailyTotal();
        if (amsTime === DAILY_REPORT_TIME && !hasReportBeenSentToday) sendExpiringContractsReport();
        if (amsTime === '00:01') { hasTotalBeenSentToday = false; hasReportBeenSentToday = false; }
    }, SCHEDULE_CHECK_INTERVAL_MS);
    pollVirtuagym();
});
