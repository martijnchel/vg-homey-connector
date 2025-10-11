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
let hasTotalBeenSentToday = false; // Vlag om te garanderen dat het totaal maar één keer wordt verstuurd

/**
 * Berekent de Unix-tijdstempel (in milliseconden) voor het begin van de huidige dag 
 * in de tijdzone 'Europe/Amsterdam', geconverteerd naar UTC-milliseconden.
 * * FIX: Gebruikt de 'sv-SE' locale om de datum in ISO-formaat (YYYY-MM-DD) op te halen
 * in de Amsterdamse tijdzone. Het aanmaken van een Date object met deze string 
 * + T00:00:00 is de meest betrouwbare manier om middernacht in een specifieke 
 * tijdzone te bepalen, ongeacht de server's lokale tijd.
 * * @returns {number} Unix timestamp (in ms) voor 00:00:00 Amsterdamse tijd.
 */
function getStartOfTodayUtc() {
    const today = new Date();
    
    // 1. Haal de datum in YYYY-MM-DD formaat op in Amsterdamse tijd
    const amsDateString = today.toLocaleDateString('sv-SE', { 
        timeZone: 'Europe/Amsterdam', 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit' 
    }); 
    
    // 2. Creëer de lokale middernachtstring (e.g., "2025-10-11T00:00:00")
    // Let op: JS interpreteert dit als lokale tijd, en de getTime() is dan de UTC-equivalent.
    const localMidnightString = `${amsDateString}T00:00:00`;
    
    // 3. Converteer naar UTC milliseconden
    const startOfTodayUtcTime = new Date(localMidnightString).getTime();
    
    console.log(`[DEBUG - TIJDZONE] Berekende Amsterdamse middernacht (${amsDateString}) als UTC timestamp: ${startOfTodayUtcTime}`);
    
    return startOfTodayUtcTime;
}

/**
 * Functie om de Homey Webhook aan te roepen voor de DAGELIJKSE TOTALEN.
 * @param {number} totalCount - Het totale aantal check-ins vandaag.
 * @param {boolean} isTest - Geeft aan of de oproep een test is (om de vlag niet te zetten).
 */
async function triggerHomeyDailyTotalWebhook(totalCount, isTest = false) {
    if (!HOMEY_DAILY_TOTAL_URL) {
        console.error("Fout: HOMEY_DAILY_TOTAL_URL omgevingsvariabele is niet ingesteld.");
        return; 
    }

    try {
        const baseUrlClean = HOMEY_DAILY_TOTAL_URL.split('?')[0];
        
        // Terug naar de leesbare Nederlandse zin, nu de Homey URL-configuratie correct is.
        let tagValue = `Vandaag zijn er ${totalCount} leden ingecheckt.`;

        // Voeg [TEST] prefix toe als het een testrun is.
        if (isTest) {
            tagValue = `[TEST] ${tagValue}`;
        }
        
        // Encodeer de leesbare string en verstuur als 'tag'.
        const url = `${baseUrlClean}?tag=${encodeURIComponent(tagValue)}`;
        
        console.log(`[DEBUG] Homey DAGELIJKS TOTAAL URL (Volledig): ${url}`);
        console.log(`Sending GET request to Homey (DAGELIJKS TOTAAL) met tag (tekst): ${tagValue}`);
        
        const response = await axios.get(url);
        
        console.log(`Homey Daily Total Webhook successful. Status: ${response.status}`);
        
        // Zet de vlag alleen als het GEEN test is
        if (!isTest) {
            hasTotalBeenSentToday = true;
        }
        
    } catch (error) {
        console.error("Fout bij aanroepen Homey Dagelijkse Totalen Webhook:", error.message);
        if (error.response) {
            console.error(`Homey Call Fout Status: ${error.response.status}. Zorg ervoor dat de HOMEY_DAILY_TOTAL_URL correct is ingesteld.`);
            
            // Debug instructie voor de gebruiker:
            console.error(`PROBEER DEZE URL HANDMATIG: Homey URL: ${HOMEY_DAILY_TOTAL_URL.split('?')[0]}?tag=${encodeURIComponent(tagValue)}`);
        }
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
 * Functie om de Homey Webhook aan te roepen voor INDIVIDUELE check-ins.
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

        // De oorspronkelijke, werkende implementatie met de lange tekst als 'tag'
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
 * Nu gefilterd op unieke leden (dubbele check-ins worden genegeerd).
 * @param {boolean} isTest - Geeft aan of deze oproep afkomstig is van de test-endpoint.
 */
async function sendDailyTotal(isTest = false) {
    try {
        const startOfTodayUtc = getStartOfTodayUtc();
        const nowUtc = Date.now();
        
        // Log de tijdstempel die naar Virtuagym gaat
        console.log(`[DAILY TOTAL] Start ophalen van dagelijks totaal (vanaf UTC timestamp: ${startOfTodayUtc}).`);

        const responseTotal = await axios.get(VG_VISITS_BASE_URL, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                sync_from: startOfTodayUtc, 
                sync_to: nowUtc,
                limit: 1000 // Zorg ervoor dat er voldoende limiet is om alle bezoeken op te halen
            }
        });
        
        const visitsResult = responseTotal.data.result;
        let totalCount = 0;

        if (Array.isArray(visitsResult) && visitsResult.length > 0) {
            const uniqueMemberIds = new Set();
            
            // Loop door alle bezoeken en voeg de member_id toe aan de Set
            visitsResult.forEach(visit => {
                // Alleen de member_id's gebruiken (dit is de filtering)
                if (visit.member_id) {
                    uniqueMemberIds.add(visit.member_id);
                }
            });

            // De grootte van de Set is het aantal unieke leden
            totalCount = uniqueMemberIds.size;
        }

        if (totalCount >= 0) { 
            console.log(`[DAILY TOTAL]: Totaal aantal UNIEKE check-ins vandaag (gevonden): ${totalCount}`);
            await triggerHomeyDailyTotalWebhook(totalCount, isTest);
        } else {
             console.warn("[WAARSCHUWING] Onverwachte data structuur voor dagelijks totaal.");
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
        sendDailyTotal(false); 
    } 
    
    // Reset de vlag vroeg in de ochtend, bijvoorbeeld tussen 00:00 en 00:01
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
                return current.check_in_timestamp > latest.checkin_time ? current : latest;
            }, newVisits[0]); 

            const memberId = latestVisit.member_id;
            const latestCheckinTs = latestVisit.checkin_time; // Gebruik de check_in_timestamp van de laatste bezoeker

            const memberName = await getMemberName(memberId); 
            
            console.log(`[LAATSTE NIEUWE CHECK-IN]: User ${memberName} (${memberId}) at ${new Date(latestCheckinTs).toISOString()}`);
            
            await triggerHomeyIndividualWebhook(memberName, latestCheckinTs); 
            
            latestCheckinTimestamp = latestCheckinTs;
            
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

// NIEUW ENDPOINT VOOR HANDMATIG TESTEN
app.get('/test-daily-total-send', async (req, res) => {
    const originalFlag = hasTotalBeenSentToday;
    
    console.log('--- TEST ACTIVERING DAGELIJKS TOTAAL ---');
    console.log(`Oorspronkelijke vlag state: ${originalFlag}`);
    
    // Voer de totale telling uit met isTest=true
    await sendDailyTotal(true); 
    
    // Herstel de oorspronkelijke vlag. 
    hasTotalBeenSentToday = originalFlag; 

    res.status(200).send('Dagelijkse totaal-telling geactiveerd. Controleer de Homey logs voor een pushmelding met de tag [TEST].');
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
    
    // Start de DAGELIJKS TOTALEN scheduler (elke 60 seconden om 23:59 te vangen)
    setInterval(checkDailySchedule, DAILY_CHECK_INTERVAL_MS);
    checkDailySchedule(); // Eerste aanroep direct starten
    
    console.log(`Individuele check-in poll interval: ${POLLING_INTERVAL_MS / 60000} minuten.`);
    console.log(`Dagelijks totaal wordt gecontroleerd: elke ${DAILY_CHECK_INTERVAL_MS / 1000} seconden, verstuurd om 23:59.`);
});
