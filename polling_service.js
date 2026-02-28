// Virtuagym Polling Service voor Homey Integratie - BASIS VERSIE (Vanmorgen)
const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // 2 minuten
const SCHEDULE_CHECK_INTERVAL_MS = 60000; // 1 minuut

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
const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000;
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// In-memory cache
let reportedMembersCache = {}; 
const DAILY_TOTAL_TIME = '23:59'; 
const DAILY_REPORT_TIME = '09:00'; 

// Status
let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false; 
let hasTotalBeenSentToday = false; 
let hasReportBeenSentToday = false; 

// --- HULPFUNCTIES ---

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

async function triggerHomeyIndividualWebhook(memberName, checkinTime) {
    if (!HOMEY_INDIVIDUAL_URL) return;
    try {
        const formattedTime = new Date(checkinTime * 1000).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
        const tagValue = `${memberName} is nu ingecheckt om ${formattedTime}.`;
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${checkinTime}`);
    } catch (e) { console.error("Fout Individueel:", e.message); }
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
        const res = await axios.get(VG_MEMBERSHIP_BASE_URL, { params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, limit: 10 } });
        const memberships = res.data.result || [];
        const expiring = memberships.find(m => {
            if (!m.contract_end_date) return false;
            const endMs = new Date(m.contract_end_date).getTime();
            return endMs > Date.now() && endMs <= (Date.now() + CONTRACT_EXPIRY_THRESHOLD_MS) && !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name);
        });
        return expiring ? expiring.contract_end_date : null;
    } catch (e) { return null; }
}

// --- SCHEDULERS ---

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
        let text = toReport.length === 0 ? "Geen nieuwe aflopende contracten gevonden." : `🔔 CONTRACTEN RAPPORT: ${toReport.join(', ')}.`;
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

// --- MAIN POLLING ---

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;
    try {
        const res = await axios.get(VG_VISITS_BASE_URL, { params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp } });
        const visits = (res.data.result || []).filter(v => v.check_in_timestamp > latestCheckinTimestamp);
        if (visits.length > 0) {
            visits.sort((a, b) => b.check_in_timestamp - a.check_in_timestamp);
            const latest = visits[0];
            const name = await getMemberName(latest.member_id);
            await triggerHomeyIndividualWebhook(name, latest.check_in_timestamp);
            latestCheckinTimestamp = latest.check_in_timestamp;
        }
    } catch (e) { console.error("Poll fout:", e.message); }
    isPolling = false;
}

// --- SERVER START ---

app.get('/', (req, res) => res.send('Service is ONLINE (Basis Versie)'));

app.listen(PORT, () => {
    console.log(`Herstart op poort ${PORT}`);
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    setInterval(() => {
        const amsTime = new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
        if (amsTime === DAILY_TOTAL_TIME && !hasTotalBeenSentToday) sendDailyTotal();
        if (amsTime === DAILY_REPORT_TIME && !hasReportBeenSentToday) sendExpiringContractsReport();
        if (amsTime === '00:01') { hasTotalBeenSentToday = false; hasReportBeenSentToday = false; }
    }, SCHEDULE_CHECK_INTERVAL_MS);
    pollVirtuagym();
});
