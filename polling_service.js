// Virtuagym Polling Service voor Homey Integratie
// Dit bestand luistert niet naar inkomende webhooks, maar vraagt periodiek (pollt)
// de Virtuagym API om nieuwe check-ins op te halen sinds de laatste controle.

const express = require('express');
const axios = require('axios');
const app = express();

// Gebruik de PORT die door de hostingomgeving (Railway) wordt geleverd
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 150000; // Poll elke 2,5 minuten (150.000 ms)

// Configuratie via Omgevingsvariabelen (MOETEN in Railway worden ingesteld!)
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_WEBHOOK_BASE_URL = process.env.HOMEY_URL; 

// Base URL's voor de Virtuagym API's
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
// DEFINITIEVE CORRECTIE: Gebruik de enkelvoudsvorm '/member' zoals aangegeven in de documentatie voor detail-lookup.
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 

// Statusvariabele om de laatste check-in tijd bij te houden
let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 

/**
 * Functie om de Homey Webhook aan te roepen.
 * @param {string} userName - De volledige naam van het ingecheckte lid (of ID als fallback).
 * @param {number} checkinTime - De timestamp van de check-in in milliseconden.
 */
async function triggerHomeyWebhook(userName, checkinTime) {
    if (!HOMEY_WEBHOOK_BASE_URL) {
        console.error("Fout: HOMEY_URL omgevingsvariabele is niet ingesteld.");
        return;
    }

    try {
        // --- AANGEPAST VOOR HOMEY TAGS: Datum en tijd gesplitst en nieuwe zinsnede gebruikt ---
        
        const checkinDate = new Date(checkinTime);
        
        // 1a. Formatteer de datum (bijv. "10 oktober")
        const formattedDate = checkinDate.toLocaleDateString('nl-NL', { 
            day: 'numeric', 
            month: 'long' // Gebruik lange maandnaam
        });

        // 1b. Formatteer alleen de tijd (bijv. "22:37:00")
        const formattedTimeOnly = checkinDate.toLocaleTimeString('nl-NL', { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });

        // 2. Combineer de Naam, datum en tijd tot één enkele bericht-string
        // Voorbeeld: "Jan Jansen checkte in op 10 oktober, om 22:37:00"
        const tagValue = `${userName} checkte in op ${formattedDate}, om ${formattedTimeOnly}`;
        
        // Zorg ervoor dat de Homey URL geen query-parameters bevat.
        const baseUrlClean = HOMEY_WEBHOOK_BASE_URL.split('?')[0];

        // 3. Bouw de uiteindelijke GET URL en encode de tag-waarde
        const url = `${baseUrlClean}?tag=${encodeURIComponent(tagValue)}`;
        
        console.log(`Sending GET request to Homey (LAATSTE CHECK-IN) met bericht: "${tagValue}"`);
        
        const response = await axios.get(url);
        
        console.log(`Homey Webhook successful. Status: ${response.status}`);
    } catch (error) {
        console.error("Fout bij aanroepen Homey Webhook:", error.message);
    }
}

/**
 * Haalt de volledige naam op van een lid op basis van de member_id.
 * @param {number} memberId - De ID van het lid.
 * @returns {Promise<string>} - De volledige naam (of de ID als fallback).
 */
async function getMemberName(memberId) {
    if (!CLUB_ID || !API_KEY || !CLUB_SECRET) {
        // Als de auth-variabelen ontbreken, stoppen we met zoeken
        return `Lid ${memberId}`; 
    }

    try {
        // Dit genereert nu de CORRECTE URL: .../member/{memberId}
        const memberUrl = `${VG_MEMBER_BASE_URL}/${memberId}`;
        
        const response = await axios.get(memberUrl, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET
            }
        });

        // *** AANPASSING HIER ***
        // Controleer of het resultaat een array is (typisch als de API de lijst-structuur gebruikt, zelfs voor één lid)
        let memberData = response.data.result;
        if (Array.isArray(memberData) && memberData.length > 0) {
            memberData = memberData[0]; // Pak het eerste element uit de array
        }
        
        // Controleert op 'firstname' en 'lastname' (kleine letter, geen underscore)
        if (memberData && memberData.firstname) { 
            // Combineer voornaam en achternaam, en trim eventuele extra spaties.
            const fullName = `${memberData.firstname} ${memberData.lastname || ''}`.trim();
            console.log(`[DEBUG] Lid ID ${memberId} gevonden als: ${fullName}`);
            return fullName;
        } else {
            // Als de API de data stuurt maar de naam mist, val terug op de ID.
            console.warn(`[DEBUG] Naam niet gevonden voor Lid ID ${memberId}. Gebruik fallback ID.`);
            return `Lid ${memberId}`;
        }
    } catch (error) {
        // Verbeterde foutafhandeling: Log de API-respons voor debugging
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
 * De hoofd polling functie die de Virtuagym API bevraagt
 */
async function pollVirtuagym() {
    if (!CLUB_ID || !API_KEY || !CLUB_SECRET) {
        console.error("Authenticatie variabelen ontbreken. Polling wordt overgeslagen.");
        return;
    }

    if (isPolling) return; // Voorkom dat er meerdere polls tegelijkertijd lopen
    isPolling = true;

    // Nieuwe debug log om te bevestigen dat de poll start
    console.log(`--- [POLL START] Polling Virtuagym op ${new Date().toLocaleTimeString()} ---`);
    console.log(`[DEBUG] Zoekt check-ins nieuwer dan: ${new Date(latestCheckinTimestamp).toLocaleString()}`); 

    try {
        // We gebruiken de sync_from parameter om ALLE nieuwe bezoeken op te halen
        const response = await axios.get(VG_VISITS_BASE_URL, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                sync_from: latestCheckinTimestamp // Haal ALLE bezoeken op nieuwer dan deze tijdstempel
            }
        });
        
        // Controleer of de API wel data stuurt (dit vangt 401/403 op die 200 teruggeven)
        if (response.data.status && response.data.status.statuscode !== 200) {
             console.error(`Fout van Virtuagym API (geen 200 OK): ${response.data.status.statuscode}. Bericht: ${response.data.status.statusmessage}`);
             isPolling = false;
             return;
        }

        const visits = response.data.result || [];
        
        // 1. Filter om alle NIEUWE bezoeken te vinden (nieuwere timestamp dan de laatste verwerkte)
        const newVisits = visits
            .filter(visit => visit.check_in_timestamp > latestCheckinTimestamp && visit.check_in_timestamp > 0);

        if (newVisits.length > 0) {
            // 2. Vind de ECHTE meest recente check-in (de laatste van de batch)
            const latestVisit = newVisits.reduce((latest, current) => {
                return current.check_in_timestamp > latest.check_in_timestamp ? current : latest;
            }, newVisits[0]); // Zoek de check-in met de hoogste timestamp

            const memberId = latestVisit.member_id;
            const checkinTime = latestVisit.check_in_timestamp;

            // *** NIEUW: Haal de volledige naam op ***
            const memberName = await getMemberName(memberId); 
            
            // 3. Verwerk ALLEEN de meest recente check-in
            console.log(`[LAATSTE NIEUWE CHECK-IN]: User ${memberName} (${memberId}) at ${new Date(checkinTime).toISOString()}`);
            
            // Gebruik de naam om de webhook te triggeren
            await triggerHomeyWebhook(memberName, checkinTime); 
            
            // 4. Update de globale tijdstempel naar de tijd van deze laatste check-in.
            latestCheckinTimestamp = checkinTime;
            
            console.log(`Polling complete. De LAATSTE check-in verwerkt. Nieuwste tijdstempel: ${latestCheckinTimestamp}`);
            
        } else {
             // Log het debug bericht duidelijker
             console.log(`[DEBUG] Polling complete. Geen nieuwe check-ins gevonden boven tijdstempel ${new Date(latestCheckinTimestamp).toLocaleTimeString()}.`);
        }


    } catch (error) {
        // Meer gedetailleerde foutafhandeling
        console.error("!!! KRITISCHE POLLING FOUT BIJ AANROEP VIRTUAGYM API !!!");
        if (error.response) {
            console.error(`Status: ${error.response.status}. URL: ${VG_VISITS_BASE_URL}`);
            console.error("Data:", error.response.data);
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

// Start de server en de Polling Loop
app.listen(PORT, () => {
    if (!CLUB_ID || !API_KEY || !CLUB_SECRET || !HOMEY_WEBHOOK_BASE_URL) {
        console.error("\n!!! KRITISCHE FOUT: AUTHENTICATIEVARIABELEN ONTBREEKEN BIJ START !!!");
        console.error("Zorg ervoor dat CLUB_ID, API_KEY, CLUB_SECRET en HOMEY_URL zijn ingesteld in de Railway variabelen.");
        // Beëindig het proces om een crash te forceren als de basisgegevens ontbreken
        process.exit(1);
    }
    console.log(`Virtuagym Polling Service luistert op poort ${PORT}. Polling interval: ${POLLING_INTERVAL_MS / 60000} minuten.`);
    
    // Start de polling loop onmiddellijk en herhaal elke 2,5 minuten
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym(); // Eerste aanroep direct starten
});
