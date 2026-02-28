const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; 
const SCHEDULE_CHECK_INTERVAL_MS = 60000;

// Configuratie via Railway Variables
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 
const HOMEY_DAILY_TOTAL_URL = process.env.HOMEY_DAILY_TOTAL_URL; 
const HOMEY_DAILY_EXPIRING_REPORT_URL = process.env.HOMEY_DAILY_EXPIRING_REPORT_URL; 

// Virtuagym API Endpoints
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 
const VG_MEMBERSHIP_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`; 

const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weken
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"];
let reportedMembersCache = {}; // Voor het contractenrapport (7-dagen filter)

const DAILY_TOTAL_TIME = '23:59'; 
const DAILY_REPORT_TIME = '09:00'; 

let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 
let hasTotalBeenSentToday = false; 
let hasReportBeenSentToday = false; 

// --- 1. MEMBER DETAILS & CONTRACT LOGICA ---

async function getMemberDetails(memberId) {
    try {
        const res = await axios.get(`${VG_MEMBER_BASE_URL}/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        const data = Array.isArray(res.data.result) ? res.data.result[0] : res.data.result;
        if (!data) return null;
        return {
            fullName: `${data.firstname} ${data.lastname || ''}`.trim(),
            registrationDate: data.timestamp_registration, 
            birthday: data.birthdate, // YYYY-MM-DD
            memberId: memberId
        };
    } catch (e) { return null; }
}

async function getExpiringContractEndDate(memberId) {
    try {
        const res = await axios.get(VG_MEMBERSHIP_BASE_URL, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, sync_from: 0, limit: 10 } 
        });
        const memberships = res.data.result || [];
        const expiring = memberships.find(m => {
            if (!m.contract_end_date) return false;
            const endMs = new Date(m.contract_end_date).getTime();
            const now = Date.now();
            return endMs > now && endMs <= (now + CONTRACT_EXPIRY_THRESHOLD_MS) && !EXCLUDED_MEMBERSHIP_NAMES.includes(m.membership_name);
        });
        return expiring ? expiring.contract_end_date : null;
    } catch (e) { return null; }
}

// --- 2. DE [B][E][N] CODE GENERATOR ---

function generateStatusCodes(details, contractEndDate) {
    let codes = "";
    const nu = new Date();
    
    // [B] Birthday
    if (details.birthday) {
        const bday = new Date(details.birthday);
        if (bday.getMonth() === nu.getMonth() && bday.getDate() === nu.getDate()) {
            codes += "[B]";
        }
    }

    // [E] Expiry/Contract
    if (contractEndDate) {
        codes += "[E]";
    }

    // [N] New Member (laatste 30 dagen)
    if (details.registrationDate) {
        const regDate = new Date(details.registrationDate);
        const dertigDagenGeleden = new Date();
        dertigDagenGeleden.setDate(nu.getDate() - 30);
        if (regDate > dertigDagenGeleden) {
            codes += "[N]";
        }
    }
    return codes;
}

// --- 3. DE HOOFD POLLING LOOP ---

async function pollVirtuagym() {
    if (isPolling) return;
    isPolling = true;

    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp }
        });

        const visits = response.data.result || [];
        const newVisits = visits
            .filter(v => v.check_in_timestamp > latestCheckinTimestamp)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of newVisits) {
            const details = await getMemberDetails(visit.member_id);
            if (details) {
                const contractEndDate = await getExpiringContractEndDate(visit.member_id);
                const statusCodes = generateStatusCodes(details, contractEndDate);
                
                const formattedTime = new Date(visit.check_in_timestamp).toLocaleTimeString('nl-NL', { 
                    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
                });

                // Formaat: [B][N]HH:mm - Naam
                const displayEntry = `${statusCodes}${formattedTime} - ${details.fullName}`;

                if (HOMEY_INDIVIDUAL_URL) {
                    await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(displayEntry)}`);
                    console.log(`[VERSTUURD] ${displayEntry}`);
                }
            }
            latestCheckinTimestamp = visit.check_in_timestamp;
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (error) {
        console.error("Poll Fout:", error.message);
    }
    isPolling = false;
}

// --- 4. DAGELIJKS TOTAAL & RAPPORTAGE ---

async function sendDailyTotal() {
    try {
        const todayMs = new Date().setHours(0,0,0,0);
        const res = await axios.get(VG_VISITS_BASE_URL, { params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: todayMs, limit: 1000 } });
        const uniqueIds = new Set((res.data.result || []).map(v => v.member_id));
        const tagValue = `Vandaag zijn er ${uniqueIds.size} leden ingecheckt.`;
        if (HOMEY_DAILY_TOTAL_URL) await axios.get(`${HOMEY_DAILY_TOTAL_URL.split('?')[0]}?tag=${encodeURIComponent(tagValue)}`);
        hasTotalBeenSentToday = true;
    } catch (e) { console.error("Dagtotaal fout:", e.message); }
}

// --- 5. SERVER START & SCHEDULER ---

app.get('/', (req, res) => res.send('
