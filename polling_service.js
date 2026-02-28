const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 180000; // 3 minuten

const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

const VG_BASE = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}`;
const CONTRACT_EXPIRY_THRESHOLD_MS = 28 * 24 * 60 * 60 * 1000; 
const NEW_MEMBER_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

let latestCheckinTimestamp = Math.floor(Date.now() / 1000); 
let isPolling = false;
let coolingDown = false;

async function processCheckin(visit) {
    try {
        // INFO OPHALEN
        const memberRes = await axios.get(`${VG_BASE}/member/${visit.member_id}`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET } 
        });
        const member = Array.isArray(memberRes.data.result) ? memberRes.data.result[0] : memberRes.data.result;
        
        await new Promise(r => setTimeout(r, 3000)); // Rust tussen calls

        const contractRes = await axios.get(`${VG_BASE}/membership/instance`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, member_id: visit.member_id, limit: 1 } 
        });
        const contracts = contractRes.data.result || [];

        const now = new Date();
        let status = "";
        
        if (member) {
            if (member.birthdate) {
                const bday = new Date(member.birthdate);
                if (now.getDate() === bday.getDate() && now.getMonth() === bday.getMonth()) status += "[B]";
            }
            if (member.registration_date) {
                if (Date.now() - new Date(member.registration_date).getTime() < NEW_MEMBER_THRESHOLD_MS) status += "[N]";
            }
        }

        if (contracts.length > 0 && contracts[0].contract_end_date) {
            const endMs = new Date(contracts[0].contract_end_date).getTime();
            if (endMs > Date.now() && endMs <= (Date.now() + CONTRACT_EXPIRY_THRESHOLD_MS)) status += "[E]";
        }

        const timeStr = new Date(visit.check_in_timestamp * 1000).toLocaleTimeString('nl-NL', { 
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' 
        });

        const tagValue = `${status}${timeStr} - ${member ? member.firstname + ' ' + (member.lastname || '') : 'Onbekend'}`;
        
        await axios.get(`${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${visit.check_in_timestamp}`);
        console.log(`[VERSTUURD] ${tagValue}`);

    } catch (e) {
        if (e.response && e.response.status === 429) coolingDown = true;
    }
}

async function poll() {
    if (isPolling || coolingDown) return;
    isPolling = true;

    console.log(`--- Poll gestart op ${new Date().toLocaleTimeString()} ---`);

    try {
        const res = await axios.get(`${VG_BASE}/visits`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp } 
        });
        
        const visits = res.data.result || [];
        
        // DE HARDE MUUR: We accepteren alleen scans van de LAATSTE 4 MINUTEN
        const fourMinutesAgo = Math.floor(Date.now() / 1000) - 240;

        const filteredVisits = visits.filter(v => 
            v.check_in_timestamp > latestCheckinTimestamp && 
            v.check_in_timestamp > fourMinutesAgo
        );

        console.log(`API gaf ${visits.length} scans. Na filter blijven er ${filteredVisits.length} over.`);

        if (filteredVisits.length > 0) {
            // Sorteer en verwerk
            filteredVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);
            
            for (const visit of filteredVisits) {
                await processCheckin(visit);
                latestCheckinTimestamp = visit.check_in_timestamp;
                await new Promise(r => setTimeout(r, 3000));
            }
        } else {
            // Als er niks nieuws was, zet de timestamp op NU om niet te blijven hangen in het verleden
            latestCheckinTimestamp = Math.floor(Date.now() / 1000);
            console.log("Geen actuele scans gevonden.");
        }
    } catch (e) {
        if (e.response && e.response.status === 429) {
            console.warn("429 gedetecteerd. 10 min pauze.");
            coolingDown = true;
            setTimeout(() => { coolingDown = false; }, 600000);
        }
    }
    isPolling = false;
}

app.get('/', (req, res) => res.send('Strict Time Filter Active'));
app.listen(PORT, () => {
    setInterval(poll, POLLING_INTERVAL_MS);
    poll();
});
