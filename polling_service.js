// Virtuagym Polling Service voor Homey Integratie
// Dit bestand luistert niet naar inkomende webhooks, maar vraagt periodiek (pollt)
// de Virtuagym API om nieuwe check-ins op te halen sinds de laatste controle.

const express = require('express');
const axios = require('axios');
const app = express();

// Gebruik de PORT die door de hostingomgeving (Railway) wordt geleverd
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 150000; // Poll individuele check-ins elke 2,5 minuten (150.000 ms)
const DAILY_CHECK_INTERVAL_MS = 60000; // Controleer elke minuut op de planning voor het dagtotaal (23:59)

// Configuratie via Omgevingsvariabelen (MOETEN in Railway worden ingesteld!)
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;

// 1. URL voor INDIVIDUELE check-ins (gebruikt HOMEY_URL)
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

// 2. NIEUWE URL voor DAGELIJKSE TOTALEN (Moet in Railway worden ingesteld!)
const HOMEY_DAILY_TOTAL_URL = process.env.HOMEY_DAILY_TOTAL_URL; 

// Base URL's voor de Virtuagym API's
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 

// Statusvariabelen
let latestCheckinTimestamp = Date.now(); // Houdt de laatste verwerkte check-in tijd bij
let isPolling = false; 
let hasTotalBeenSentToday = false; // Nieuwe vlag om te garanderen dat het totaal maar één keer wordt verstuurd

/**
 * Berekent de Unix-tijdstempel (in milliseconden) voor het begin van de huidige dag 
 * in de tijdzone 'Europe/Amsterdam', geconverteerd naar UTC-milliseconden.
 * @returns {number} Unix timestamp (in ms) voor 00:00:00 Amsterdamse tijd.
 */
function getStartOfTodayUtc() {
    const d = new Date();
    // Creëer een string representatie van de datum in Amsterdamse tijd (bv. "10/25/2025")
    const amsDateStr = d.toLocaleString('en-US', { 
        timeZone: 'Europe/Amsterdam', 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit' 
    });
    
    // Converteer naar ISO-achtige string (2025-10-25) en zet de tijd op 00:00:00
    const parts = amsDateStr.split('/'); 
    const datePart = `${parts[2]}-${parts[0]}-${parts[1]}`; 
    
    // Maak een Date object dat dit punt (00:00:00) vertegenwoordigt. 
    // De getTime() is de UTC timestamp van Amsterdam middernacht.
    const startOfDayAms = new Date(`${datePart} 00:00:00`);
    
    return startOfDayAms.getTime();
}

/**
 * Functie om de Homey Webhook aan te roepen voor de DAGELIJKSE TOTALEN.
 * @param {number} totalCount - Het totale aantal check-ins vandaag.
 */
async function triggerHomeyDailyTotalWebhook(totalCount) {
    if (!HOMEY_DAILY_TOTAL_URL) {
        return; 
    }

    try {
        // Gebruik de Nederlandse tijdzone voor de weergave van de datum
        const dateString = new Date().toLocaleDateString('nl-NL', { 
            day: 'numeric', 
            month: 'long', 
            timeZone: 'Europe/Amsterdam' 
        });

        const tagValue = `Totaal vandaag (${dateString}): ${totalCount} check-ins`;
        const baseUrlClean = HOMEY_DAILY_TOTAL_URL.split('?')[0];
        const url = `${baseUrlClean}?tag=${encodeURIComponent(tagValue)}`;
        
        console.log(`Sending GET request to Homey (DAGELIJKS TOTAAL) met bericht: "${tagValue}"`);
        
        const response = await axios.get(url);
        
        console.log(`Homey Daily Total Webhook successful. Status: ${response.status}`);
        
        // Zodra succesvol verzonden, zetten we de vlag om meervoudig versturen te voorkomen
        hasTotalBeenSentToday = true;
        
    } catch (error) {
        console.error("Fout bij aanroepen Homey Dagelijkse Totalen Webhook:", error.message);
    }
}

/**
 * Haalt de volledige naam op van een lid op basis van de member_id.
 */
async function getMemberName(memberId) {
    if (!CLUB_ID || !API_KEY || !CLUB_SECRET) {
        return `Lid ${memberId}`; 
    }

    try {
        const memberUrl = `${VG_MEMBER_BASE_URL}/${memberId}`;
        
        const response = await axios.get(memberUrl, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET
            }
        });

        let memberData = response.data.result;
        if (Array.isArray(memberData) && memberData.length > 0) {
            memberData = memberData[0]; 
        }
        
        if (memberData && memberData.firstname) { 
            const fullName = `${memberData.firstname} ${memberData.lastname || ''}`.trim();
            console.log(`[DEBUG] Lid ID ${memberId} gevonden als: ${fullName}`);
            return fullName;
        } else {
            console.warn(`[DEBUG] Naam niet gevonden voor Lid ID ${memberId}. Gebruik fallback ID.`);
            return `Lid ${memberId}`;
        }
    } catch (error) {
        console.error(`[FOUT] Kan naam niet ophalen voor Lid ID ${memberId}.`);
        if (error.response) {
            console.error(`VG API Fout Status: ${error.response.status}`);
            console.error("VG API Fout Data:", error.response.data);
        } else {
            console.error("Netwerk/Algemene Fout:", error.message);
        }
        return `Lid ${memberId}`;
    }
}

/**
 * Functie om de Homey Webhook aan te roepen voor INDIVIDUELE check-ins. (Ongewijzigd)
 */
async function triggerHomeyIndividualWebhook(userName, checkinTime) {
    if (!HOMEY_INDIVIDUAL_URL) {
        console.error("Fout: HOMEY_URL omgevingsvariabele is niet ingesteld.");
        return;
    }

    try {
        const checkinDate = new Date(checkinTime);
        const timezoneOptions = { timeZone: 'Europe/Amsterdam' };
        
        const formattedDate = checkinDate.toLocaleDateString('nl-NL', { 
            day: 'numeric', 
            month: 'long', 
            ...timezoneOptions
        });

        const formattedTimeOnly = checkinDate.toLocaleTimeString('nl-NL', { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit',
            ...timezoneOptions
        });

        const tagValue = `${userName} checkte in op ${formattedDate}, om ${formattedTimeOnly}`;
        
        const baseUrlClean = HOMEY_INDIVIDUAL_URL.split('?')[0];
        const url = `${baseUrlClean}?tag=${encodeURIComponent(tagValue)}`;
        
        console.log(`Sending GET request to Homey (INDIVIDUEEL) met bericht: "${tagValue}"`);
        
        const response = await axios.get(url);
        
        console.log(`Homey Individual Webhook successful. Status: ${response.status}`);
    } catch (error) {
        console.error("Fout bij aanroepen Homey Individual Webhook:", error.message);
    }
}


// =======================================================
// NIEUWE FUNCTIES VOOR DAGELIJKS TOTAAL
// =======================================================

/**
 * Haalt het totale aantal check-ins op voor de huidige dag en triggert de Homey webhook.
 */
async function sendDailyTotal() {
    try {
        const startOfTodayUtc = getStartOfTodayUtc();
        const nowUtc = Date.now();
        
        console.log(`[DAILY TOTAL] Start ophalen van dagelijks totaal (vanaf ${new Date(startOfTodayUtc).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam' })}).`);

        const responseTotal = await axios.get(VG_VISITS_BASE_URL, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                sync_from: startOfTodayUtc, // Vanaf middernacht van vandaag
                sync_to: nowUtc 
            }
        });
        
        const totalCount = responseTotal.data.result_count;
        
        if (typeof totalCount === 'number') {
            console.log(`[DAILY TOTAL]: Totaal aantal check-ins vandaag: ${totalCount}`);
            await triggerHomeyDailyTotalWebhook(totalCount);
        } else {
             console.warn("[WAARSCHUWING] 'result_count' niet gevonden in response voor dagelijks totaal. Geen Homey push.");
        }

    } catch (error) {
         console.error("!!! KRITISCHE POLLING FOUT BIJ DAGELIJKS TOTAAL AANROEP !!!");
         if (error.response) {
            console.error(`Status: ${error.response.status}. URL: ${VG_VISITS_BASE_URL}`);
        } else {
            console.error("Netwerk/Algemene Fout:", error.message);
        }
    }
}

/**
 * Controleert elke minuut of het 23:59 is (Amsterdamse tijd) om het dagtotaal te versturen.
 * Reset de 'hasTotalBeenSentToday' vlag na middernacht.
 */
function checkDailySchedule() {
    // Gebruik de Amsterdamse tijd voor planning
    const amsTime = new Date().toLocaleTimeString('nl-NL', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        timeZone: 'Europe/Amsterdam' 
    });

    // Verstuur tussen 23:59:00 en 23:59:59
    if (amsTime.startsWith('23:59') && !hasTotalBeenSentToday) {
        console.log("!!! Planning geactiveerd: Tijd om dagelijkse totalen te versturen. !!!");
        sendDailyTotal();
    } 
    
    // Reset de vlag vroeg in de ochtend, bijvoorbeeld tussen 00:00 en 00:01
    // Dit zorgt ervoor dat de melding morgen weer gestuurd kan worden.
    if (amsTime.startsWith('00:00') && hasTotalBeenSentToday) {
        hasTotalBeenSentToday = false;
        console.log("Dagelijkse totaal vlag gereset. Klaar voor de nieuwe dag.");
    }
}


// =======================================================
// HOOFD POLLING FUNCTIE (Alleen voor individuele check-ins)
// =======================================================
async function pollVirtuagym() {
    if (!CLUB_ID || !API_KEY || !CLUB_SECRET) {
        console.error("Authenticatie variabelen ontbreken. Polling wordt overgeslagen.");
        return;
    }

    if (isPolling) return; 
    isPolling = true;

    console.log(`--- [POLL START] Polling Virtuagym op ${new Date().toLocaleTimeString()} ---`);
    
    // 1. INDIVIDUELE CHECK-IN LOGICA (gebaseerd op de laatste timestamp)
    try {
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                sync_from: latestCheckinTimestamp 
            }
        });

        const visits = response.data.result || [];
        
        const newVisits = visits
            .filter(visit => visit.check_in_timestamp > latestCheckinTimestamp && visit.check_in_timestamp > 0);

        if (newVisits.length > 0) {
            const latestVisit = newVisits.reduce((latest, current) => {
                return current.check_in_timestamp > latest.check_in_timestamp ? current : latest;
            }, newVisits[0]); 

            const memberId = latestVisit.member_id;
            const checkinTime = latestVisit.check_in_timestamp; 

            const memberName = await getMemberName(memberId); 
            
            console.log(`[LAATSTE NIEUWE CHECK-IN]: User ${memberName} (${memberId}) at ${new Date(checkinTime).toISOString()}`);
            
            await triggerHomeyIndividualWebhook(memberName, checkinTime); 
            
            latestCheckinTimestamp = checkinTime;
            
            console.log(`Individual Polling complete. Nieuwste tijdstempel: ${latestCheckinTimestamp}`);
            
        } else {
             console.log(`[DEBUG] Individual Polling complete. Geen nieuwe check-ins gevonden.`);
        }

    } catch (error) {
        console.error("!!! KRITISCHE POLLING FOUT BIJ INDIVIDUELE CHECK-IN AANROEP !!!");
        if (error.response) {
            console.error(`Status: ${error.response.status}. URL: ${VG_VISITS_BASE_URL}`);
        } else {
            console.error("Netwerk/Algemene Fout:", error.message);
        }
    }
    
    isPolling = false;
}

// Een simpel GET-endpoint voor het testen van de server connectie
app.get('/', (req, res) => {
    res.send('Virtuagym-Homey Polling Connector is running and polling every 2.5 minutes.');
});

// Start de server en de Polling Loops
app.listen(PORT, () => {
    if (!CLUB_ID || !API_KEY || !CLUB_SECRET) {
        console.error("\n!!! KRITISCHE FOUT: AUTHENTICATIEVARIABELEN ONTBREEKEN BIJ START !!!");
        console.error("Zorg ervoor dat CLUB_ID, API_KEY, CLUB_SECRET en HOMEY_URL zijn ingesteld in de Railway variabelen.");
        process.exit(1);
    }
    console.log(`Virtuagym Polling Service luistert op poort ${PORT}.`);
    
    // Start de INDIVIDUELE check-in polling loop (elke 2,5 minuut)
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym(); // Eerste aanroep direct starten
    
    // Start de DAGELIJKSE TOTALEN scheduler (elke 60 seconden om 23:59 te vangen)
    setInterval(checkDailySchedule, DAILY_CHECK_INTERVAL_MS);
    checkDailySchedule(); // Eerste aanroep direct starten
    
    console.log(`Individuele check-in poll interval: ${POLLING_INTERVAL_MS / 60000} minuten.`);
    console.log(`Dagelijks totaal wordt gecontroleerd: elke ${DAILY_CHECK_INTERVAL_MS / 1000} seconden, verstuurd om 23:59.`);
});
