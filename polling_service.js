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
 * * FIX: Gebruikt nu een robuustere methode om middernacht Amsterdam te bepalen.
 * @returns {number} Unix timestamp (in ms) voor 00:00:00 Amsterdamse tijd.
 */
function getStartOfTodayUtc() {
    const d = new Date();
    
    // Maak een string representatie van de datum in Amsterdamse tijd (bv. "2025-10-10")
    // Dit zorgt ervoor dat de basisdatum de lokale dag in Amsterdam is.
    const amsDateStr = d.toLocaleString('en-US', { 
        timeZone: 'Europe/Amsterdam', 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit' 
    }).split('/'); 

    // Herformateer naar YYYY-MM-DD
    const datePart = `${amsDateStr[2]}-${amsDateStr[0]}-${amsDateStr[1]}`; 
    
    // De toLocaleString zorgt ervoor dat we de juiste dag hebben. Door setHours(0,0,0,0) te gebruiken 
    // op een Date object dat met die string is aangemaakt, forceren we de UTC timestamp voor middernacht.
    // Dit is de meest betrouwbare methode op servers met onbekende tijdzones.
    const midnightAms = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Amsterdam"}).split('/').reverse().join('/')).setHours(0, 0, 0, 0);
    
    return midnightAms;
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
        
        // DE DEFINITIEVE OPLOSSING: Maak een simpele, leesbare tekst in plaats van JSON of aparte parameters.
        let tagValue = `Vandaag zijn er ${totalCount} leden ingecheckt.`;

        // Voeg een [TEST] prefix toe als het een testrun is. Dit maakt het onderscheid makkelijk in Homey.
        if (isTest) {
            tagValue = `[TEST] ${tagValue}`;
        }
        
        // Encodeer de simpele string en verstuur als 'tag', identiek aan de individuele check-in.
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
            // Dit zou nu de 400 Bad Request fout moeten oplossen
            console.error(`Homey Call Fout Status: ${error.response.status}. Zorg ervoor dat de HOMEY_DAILY_TOTAL_URL correct is ingesteld.`);
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
 * @param {boolean} isTest - Geeft aan of deze oproep afkomstig is van de test-endpoint.
 */
async function sendDailyTotal(isTest = false) {
    try {
        const startOfTodayUtc = getStartOfTodayUtc();
        const nowUtc = Date.now();
        
        // Log de tijdstempel correct in Amsterdamse tijd voor debuggen
        const amsTimeDebug = new Date(startOfTodayUtc).toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        console.log(`[DAILY TOTAL] Start ophalen van dagelijks totaal (vanaf 00:00:00 Amsterdam).`);

        // We vragen nu ALLE bezoeken van middernacht tot nu op
        const responseTotal = await axios.get(VG_VISITS_BASE_URL, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                sync_from: startOfTodayUtc, 
                sync_to: nowUtc,
                limit: 1000 
            }
        });
        
        // Tel de resultaten zelf
        const visitsResult = responseTotal.data.result;
        let totalCount = 0;
        if (Array.isArray(visitsResult)) {
            totalCount = visitsResult.length;
        }

        if (totalCount >= 0) { // Stuur de pushmelding altijd, ook bij 0
            console.log(`[DAILY TOTAL]: Totaal aantal check-ins vandaag: ${totalCount}`);
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
        // Oproep zonder isTest, dus de vlag wordt gezet en de 23:59 run is eenmalig
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
            const checkinTime = latestVisit.checkin_time; // Gebruik checkin_time in plaats van check_in_timestamp voor consistentie
            
            // Omdat de eerdere logica werkte met check_in_timestamp bij filter, houden we dat aan voor de tijdsvergelijking
            const latestCheckinTs = latestVisit.check_in_timestamp;

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
    
    // Zorg ervoor dat de vlag NIET gezet wordt door de test, zodat 23:59 niet wordt overgeslagen
    await sendDailyTotal(true); // Voer de totale telling uit met isTest=true
    
    // Herstel de oorspronkelijke vlag. 
    hasTotalBeenSentToday = originalFlag; 

    res.status(200).send('Dagelijkse totaal-telling geactiveerd. Controleer de Homey logs voor een bericht met de tag [TEST]. De vlag is hersteld om 23:59 niet te beïnvloeden.');
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
