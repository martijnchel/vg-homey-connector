// Node.js Webhook Receiver met Express
// Dit bestand MOET gehost worden op een publieke URL (bijv. op een VPS of dienst als Railway)
// Zodat Virtuagym het kan bereiken en data naartoe kan sturen.

// Dependencies: Installeer Express en Axios via: npm install express axios
const express = require('express');
const axios = require('axios'); // Nodig om de Homey Webhook aan te roepen
const app = express();
// Gebruik de PORT die door de hostingomgeving (Railway) wordt geleverd
const PORT = process.env.PORT || 3000; 

// Middleware om JSON-body's te parsen
app.use(express.json());

// Configuratie
// We halen de Homey URL op uit de omgevingsvariabele (die je instelt in Railway)
const HOMEY_WEBHOOK_BASE_URL = process.env.HOMEY_URL; 

// Functie om de Homey Webhook aan te roepen
async function triggerHomeyWebhook(userId, checkinTime) {
    // We gebruiken de 'vg_checkin' event ID in de URL, zoals geconfigureerd in de Homey flow.
    // De URL moet al je Homey ID bevatten, bijvoorbeeld: https://webhook.homey.app/<JOUW_HOME_ID>/vg_checkin
    if (!HOMEY_WEBHOOK_BASE_URL) {
        console.error("Fout: HOMEY_URL omgevingsvariabele is niet ingesteld. Homey wordt niet getriggerd.");
        return;
    }

    try {
        // We sturen de user ID en de timestamp mee als query parameters
        // De timestamp is nuttig voor logging of geavanceerde flows in Homey
        const url = `${HOMEY_WEBHOOK_BASE_URL}?uid=${userId}&timestamp=${checkinTime}`;
        console.log(`Sending request to Homey: ${url}`);
        
        // Stuur een GET-verzoek (of POST, afhankelijk van Homey configuratie, maar GET is gebruikelijk voor simpele triggers)
        const response = await axios.get(url);
        
        // Log de status van de Homey call
        console.log(`Homey Webhook successful. Status: ${response.status}`);
    } catch (error) {
        console.error("Fout bij aanroepen Homey Webhook:", error.message);
    }
}

// Het endpoint dat Virtuagym zal aanroepen
app.post('/virtuagym-webhook-endpoint', async (req, res) => {
    console.log('--- Inkomende Virtuagym Webhook ontvangen ---');

    // 1. Log de volledige payload voor debugging
    const payload = req.body;
    
    // Optioneel: Controleer op een geheime sleutel als Virtuagym die ondersteunt voor validatie
    // const secret = req.headers['x-virtuagym-secret']; 
    // if (secret !== 'JOUW_GEHEIME_SLEUTEL') { return res.status(403).send('Forbidden'); }

    // 2. Controleer of het het juiste type event is
    if (payload.event_type === 'checkin.created') {
        const userId = payload.data.user_id;
        const terminalId = payload.data.terminal_id;
        const checkinTime = payload.data.checkin_time; // De tijdstempel is hier beschikbaar
        
        console.log(`Event: checkin.created. User ID: ${userId}, Terminal: ${terminalId}, Time: ${checkinTime}`);

        // 3. Roep de Homey Webhook aan en stuur de userId en checkinTime mee
        if (userId) {
            await triggerHomeyWebhook(userId, checkinTime);
        } else {
            console.warn("Geen user_id gevonden in de payload, Homey wordt niet getriggerd.");
        }

        // 4. Stuur een succesvolle HTTP 200/204 respons terug naar Virtuagym
        // Dit is CRUCIAAL. Virtuagym verwacht deze bevestiging.
        res.status(200).json({ status: 'ok', message: 'Webhook verwerkt en Homey getriggerd' });

    } else {
        // 5. Stuur een 200 OK terug, zelfs als we het event negeren, om Virtuagym te vertellen dat we het hebben ontvangen.
        console.log(`Onbekend of niet-verwerkt event_type: ${payload.event_type}. Negeren.`);
        res.status(200).json({ status: 'ignored', message: 'Event type genegeerd' });
    }
});

// Een simpel GET-endpoint voor het testen van de server connectie
app.get('/', (req, res) => {
    res.send('Virtuagym-Homey Webhook Connector is running.');
});

// Start de server
app.listen(PORT, () => {
    console.log(`Virtuagym Webhook Receiver luistert op poort ${PORT}. Publieke URL is gereed.`);
});

