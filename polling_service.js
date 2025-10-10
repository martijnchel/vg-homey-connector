// Virtuagym Polling Service voor Homey Integratie
// Dit bestand luistert niet naar inkomende webhooks, maar vraagt periodiek (pollt)
// de Virtuagym API om nieuwe check-ins op te halen sinds de laatste controle.

const express = require('express');
const axios = require('axios');
const app = express();

// Gebruik de PORT die door de hostingomgeving (Railway) wordt geleverd
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 300000; // Poll elke 5 minuten (300.000 ms)

// Configuratie via Omgevingsvariabelen (MOETEN in Railway worden ingesteld!)
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;
const HOMEY_WEBHOOK_BASE_URL = process.env.HOMEY_URL; 

// Base URL voor de Virtuagym Visits API, gebruikt de URL structuur van jouw voorbeeld
const VG_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;

// Statusvariabele om de laatste check-in tijd bij te houden
// OPMERKING: Bij een herstart van de server (bijvoorbeeld door Railway) wordt dit gereset!
// Voor productie zou je dit moeten opslaan in een database (bijv. Firestore of Redis).
let latestCheckinTimestamp = Date.now(); 
let isPolling = false; 

/**
 * Functie om de Homey Webhook aan te roepen
 */
async function triggerHomeyWebhook(userId, checkinTime) {
    if (!HOMEY_WEBHOOK_BASE_URL) {
        console.error("Fout: HOMEY_URL omgevingsvariabele is niet ingesteld.");
        return;
    }

    try {
        // De timestamp van Virtuagym is in milliseconden, dus delen door 1000 voor seconden
        const checkinTimeSeconds = Math.floor(checkinTime / 1000); 
        
        // Stuur de user ID en de timestamp mee naar Homey
        const url = `${HOMEY_WEBHOOK_BASE_URL}?uid=${userId}&timestamp=${checkinTimeSeconds}`;
        console.log(`Sending request to Homey: ${url}`);
        
        const response = await axios.get(url);
        
        console.log(`Homey Webhook successful. Status: ${response.status}`);
    } catch (error) {
        console.error("Fout bij aanroepen Homey Webhook:", error.message);
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
        // We vragen om de laatste 20 bezoeken, gesorteerd op check-in tijd (meest recent eerst).
        const response = await axios.get(VG_BASE_URL, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                sort_by: 'check_in_timestamp',
                sort_direction: 'desc',
                limit: 20 // Haal genoeg resultaten op om nieuwe check-ins te vangen
            }
        });
        
        // Controleer of de API wel data stuurt (dit vangt 401/403 op die 200 teruggeven)
        if (response.data.status && response.data.status.statuscode !== 200) {
             console.error(`Fout van Virtuagym API (geen 200 OK): ${response.data.status.statuscode}. Bericht: ${response.data.status.statusmessage}`);
             isPolling = false;
             return;
        }

        const visits = response.data.result || [];
        let newLatestTimestamp = latestCheckinTimestamp;
        let newCheckinsFound = 0;

        // Loop door de resultaten om nieuwe check-ins te vinden
        const newVisits = visits
            .filter(visit => visit.check_in_timestamp > latestCheckinTimestamp && visit.check_in_timestamp > 0)
            .sort((a, b) => a.check_in_timestamp - b.check_in_timestamp); 

        for (const visit of newVisits) {
            console.log(`[NIEUWE CHECK-IN]: User ${visit.member_id} at ${new Date(visit.check_in_timestamp).toISOString()}`);
            await triggerHomeyWebhook(visit.member_id, visit.check_in_timestamp);
            newLatestTimestamp = Math.max(newLatestTimestamp, visit.check_in_timestamp);
            newCheckinsFound++;
        }

        if (newCheckinsFound > 0) {
             // Werk de globale tijdstempel bij nadat alle nieuwe bezoeken zijn verwerkt
            latestCheckinTimestamp = newLatestTimestamp;
            console.log(`Polling complete. ${newCheckinsFound} nieuwe check-ins verwerkt. Nieuwste tijdstempel: ${latestCheckinTimestamp}`);
        } else {
             // AANGEPAST: Log het debug bericht duidelijker
             console.log(`[DEBUG] Polling complete. Geen nieuwe check-ins gevonden boven tijdstempel ${new Date(latestCheckinTimestamp).toLocaleTimeString()}.`);
        }


    } catch (error) {
        // Meer gedetailleerde foutafhandeling
        console.error("!!! KRITISCHE POLLING FOUT BIJ AANROEP VIRTUAGYM API !!!");
        if (error.response) {
            console.error(`Status: ${error.response.status}. URL: ${VG_BASE_URL}`);
            console.error("Data:", error.response.data);
        } else {
            console.error("Netwerk/Algemene Fout:", error.message);
        }
    }

    isPolling = false;
}

// Een simpel GET-endpoint voor het testen van de server connectie
app.get('/', (req, res) => {
    res.send('Virtuagym-Homey Polling Connector is running and polling every 5 minutes.');
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
    
    // Start de polling loop onmiddellijk en herhaal elke 5 minuten
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym(); // Eerste aanroep direct starten
});
