const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 120000; // Elke 2 minuten checken

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_BASE = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}`;
const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weken
const NEW_MEMBER_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 dagen

let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false;

// Functie om lid-details en contracten op te halen
async function getEnhancedMemberData(memberId) {
    try {
        // 1. Haal basis info op (voor verjaardag & registratie)
        const memberRes = await axios.get(`${VG_BASE}/member/${memberId}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        const member = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;

        // Korte pauze om API te ontlasten
        await new Promise(r => setTimeout(r, 1000));

        // 2. Haal contracten op (voor einddatum)
        const contractRes = await axios.get(`${VG_BASE}/membership/instance`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: memberId, sync_from: 0, limit: 1 } 
        });
        const contracts = contractRes.data.result || [];

        return { member, contracts };
    } catch (e) {
        console.error(`Fout bij ophalen data voor ${memberId}:`, e.message);
        return null;
    }
}

async function processCheckin(visit) {
    const data = await getEnhancedMemberData(visit.member_id);
    if (!data || !data.member) return;

    const { member, contracts } = data;
    const now = new Date();
    
    // --- 1. VERJAARDAG CHECK ---
    let isBirthday = false;
    if (member.birthdate) {
        const bday = new Date(member.birthdate);
        // Vergelijk dag en maand in NL tijd
        const todayStr = now.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Amsterdam' });
        const bdayStr = bday.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit' });
        isBirthday = (todayStr === bdayStr);
    }

    // --- 2. NIEUW LID CHECK ---
    let isNewMember = false;
    if (member.registration_date) {
        const regMs = new Date(member.registration_date).getTime();
        isNewMember = (Date.now() - regMs < NEW_MEMBER_THRESHOLD_MS);
    }

    // --- 3. CONTRACT CHECK ---
    let isExpiring = false;
    if (contracts.length > 0) {
        const contract = contracts[0];
        if (contract.contract_end_date) {
            const endMs = new Date(contract.contract_end_date).getTime();
            isExpiring = (endMs > Date.now() && endMs <= Date.now() + CONTRACT_EXPIRY_THRESHOLD_MS);
        }
    }

    // Status codes samenstellen
    let status = "";
    if (isBirthday) status += "[B]";
    if (isExpiring) status += "[E]";
    if (isNewMember) status += "[N]";

    // Tijd van inchecken
    const timeStr = new Date(visit.check_in_timestamp * 1000).toLocaleTimeString('nl-NL', { 
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
    });

    const tagValue = `${status}${timeStr} - ${member.firstname} ${member.lastname || ''}`;
    
    // Verstuur naar Homey
    await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${visit.check_in_timestamp}`);
    console.log(`[OK] ${tagValue}`);
}

async function poll() {
    if (isPolling) return;
    isPolling = true;
    try {
        const res = await axios.get(`${VG_BASE}/visits`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp } 
        });
        const visits = res.data.result || [];
        
        // Lawine-stop
        if (visits.length > 10) {
            latestCheckinTimestamp = visits[0].check_in_timestamp;
            isPolling = false;
            return;
        }

        const newVisits = visits.filter(v => v.check_in_timestamp > latestCheckinTimestamp);
        newVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);

        for (const visit of newVisits) {
            await processCheckin(visit);
            latestCheckinTimestamp = visit.check_in_timestamp;
            await new Promise(r => setTimeout(r, 2000)); // Rust tussen personen
        }
    } catch (e) {
        console.error("Poll fout:", e.message);
    }
    isPolling = false;
}

app.get('/', (req, res) => res.send('Full Service Actief'));
app.listen(PORT, () => setInterval(poll, POLLING_INTERVAL_MS));
