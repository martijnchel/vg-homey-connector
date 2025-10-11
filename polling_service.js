// Virtuagym Polling Service voor Homey Integratie
// Dit bestand luistert niet naar inkomende webhooks, maar vraagt periodiek (pollt)
// de Virtuagym API om nieuwe check-ins op te halen sinds de laatste controle.

const express = require('express');
const axios = require('axios');
const app = express();

// Gebruik de PORT die door de hostingomgeving (Railway) wordt geleverd
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 150000; // Poll individuele check-ins elke 2,5 minuten (150.000 ms)
const SCHEDULE_CHECK_INTERVAL_MS = 60000; // Controleer elke minuut of de scheduled tijd is bereikt

// Configuratie via Omgevingsvariabelen (MOETEN in Railway worden ingesteld!)
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;

// 1. URL voor INDIVIDUELE check-ins (gebruikt HOMEY_URL)
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 

// 2. URL voor DAGELIJKSE TOTALEN (Moet in Railway worden ingesteld!)
const HOMEY_DAILY_TOTAL_URL = process.env.HOMEY_DAILY_TOTAL_URL; 

// 3. NIEUWE URL voor DAGELIJKSE VERVAL RAPPORTAGE (Moet in Railway worden ingesteld!)
const HOMEY_DAILY_EXPIRING_REPORT_URL = process.env.HOMEY_DAILY_EXPIRING_REPORT_URL; 

// Base URL's voor de Virtuagym API's
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 
const VG_MEMBERSHIP_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`; 

// Constanten voor Contract Check
const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weken in milliseconden
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"]; // Uitsluitingen

// Planningstijden (Amsterdamse Tijd)
const DAILY_TOTAL_TIME = '23:59'; 
const DAILY_REPORT_TIME = '09:00'; // De nieuwe tijd voor het contractenrapport

// Statusvariabelen
let latestCheckinTimestamp = Date.now(); // Houdt de laatste verwerkte check-in tijd bij
let isPolling = false; 
let hasTotalBeenSentToday = false; // Vlag voor het dagtotaal (23:59)
let hasReportBeenSentToday = false; // NIEUWE Vlag voor het contractenrapport (09:00)

/**
 * Berekent de Unix-tijdstempel (in milliseconden) voor het begin van de huidige dag 
 * in de tijdzone 'Europe/Amsterdam', geconverteerd naar UTC-milliseconden.
 * @returns {number} Unix timestamp (in ms) voor 00:00:00 Amsterdamse tijd.
 */
function getStartOfTodayUtc() {
    const today = new Date();
    
    const amsDateString = today.toLocaleDateString('sv-SE', { 
        timeZone: 'Europe/Amsterdam', 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit' 
    }); 
    
    const localMidnightString = `${amsDateString}T00:00:00`;
    const startOfTodayUtcTime = new Date(localMidnightString).getTime();
    
    return startOfTodayUtcTime;
}

/**
 * Berekent de Unix-tijdstempel (in milliseconden) voor het begin van de vorige dag (gisteren) 
 * in de tijdzone 'Europe/Amsterdam'.
 * @returns {{start: number, end: number}} Start en eindtijdstempels voor gisteren.
 */
function getYesterdayTimeRange() {
    const startOfToday = getStartOfTodayUtc();
    const dayInMs = 24 * 60 * 60 * 1000;

    const startOfYesterday = startOfToday - dayInMs;
    // We gebruiken de start van vandaag als de sync_to parameter (exclusief)
    const endOfYesterday = startOfToday; 

    return { start: startOfYesterday, end: endOfYesterday };
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
        let tagValue = `Vandaag zijn er ${totalCount} leden ingecheckt.`;

        if (isTest) {
            tagValue = `[TEST] ${tagValue}`;
        }
        
        const url = `${baseUrlClean}?tag=${encodeURIComponent(tagValue)}`;
        
        console.log(`[DEBUG] Sending GET request to Homey (DAGELIJKS TOTAAL) met tag (tekst): ${tagValue}`);
        const response = await axios.get(url);
        
        console.log(`Homey Daily Total Webhook successful. Status: ${response.status}`);
        
        if (!isTest) {
            hasTotalBeenSentToday = true;
        }
        
    } catch (error) {
        console.error("Fout bij aanroepen Homey Dagelijkse Totalen Webhook:", error.message);
    }
}

/**
 * Functie om de Homey Webhook aan te roepen voor het dagelijkse contractrapport.
 * @param {string} reportText - Het samengevoegde rapport.
 * @param {boolean} isTest - Geeft aan of de oproep een test is.
 */
async function triggerHomeyDailyReportWebhook(reportText, isTest = false) {
    if (!HOMEY_DAILY_EXPIRING_REPORT_URL) {
        console.error("Fout: HOMEY_DAILY_EXPIRING_REPORT_URL omgevingsvariabele is niet ingesteld.");
        return;
    }

    try {
        const baseUrlClean = HOMEY_DAILY_EXPIRING_REPORT_URL.split('?')[0];
        let tagValue = reportText;
        
        if (isTest) {
             tagValue = `[TEST RAPPORT] ${reportText}`;
        }

        // De Homey tag wordt hier zo eenvoudig mogelijk verstuurd.
        const url = `${baseUrlClean}?tag=${encodeURIComponent(tagValue)}`;
        
        console.log(`[DEBUG] Sending GET request to Homey (DAGELIJKS RAPPORT) met bericht: "${tagValue}"`);
        
        const response = await axios.get(url);
        
        console.log(`Homey Daily Report Webhook successful. Status: ${response.status}`);
        
        if (!isTest) {
            hasReportBeenSentToday = true;
        }
    } catch (error) {
        console.error("Fout bij aanroepen Homey Dagelijks Rapport Webhook:", error.message);
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
            return fullName;
        } else {
            return `Lid ${memberId}`;
        }
    } catch (error) {
        console.error(`[FOUT] Kan naam niet ophalen voor Lid ID ${memberId}.`);
        return `Lid ${memberId}`;
    }
}

// =======================================================
// NIEUWE FUNCTIE VOOR AFLOPENDE CONTRACTEN CHECK (Retouneert gegevens)
// =======================================================

/**
 * Controleert de lidmaatschapsstatus van een lid en retourneert de vervaldatum indien van toepassing.
 * @param {number} memberId - Het ID van het lid.
 * @returns {Promise<string|null>} De contract_end_date (ISO string) of null.
 */
async function getExpiringContractDetails(memberId) {
    if (!CLUB_ID || !API_KEY || !CLUB_SECRET) {
        return null; 
    }

    try {
        const now = Date.now();
        const futureExpiryLimit = now + CONTRACT_EXPIRY_THRESHOLD_MS;

        const membershipUrl = `${VG_MEMBERSHIP_BASE_URL}`;
        
        const response = await axios.get(membershipUrl, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                member_id: memberId,
                sync_from: 0,
                limit: 10
            }
        });

        const memberships = response.data.result || [];
        
        // Zoek naar het contract dat bijna afloopt en aan de voorwaarden voldoet
        const expiringContract = memberships.find(membership => {
            
            if (!membership.contract_end_date) {
                return false;
            }
            
            const contractEndDateMs = new Date(membership.contract_end_date).getTime();
            
            const isExpiringSoon = contractEndDateMs > now && contractEndDateMs <= futureExpiryLimit;

            const isExcluded = EXCLUDED_MEMBERSHIP_NAMES.includes(membership.membership_name);
            
            return isExpiringSoon && !isExcluded;
        });

        return expiringContract ? expiringContract.contract_end_date : null;

    } catch (error) {
        console.error(`[FOUT] Kan lidmaatschapsstatus niet controleren voor Lid ID ${memberId}.`);
        return null;
    }
}


// =======================================================
// FUNCTIES VOOR DAGELIJKS RAPPORT (09:00)
// =======================================================

/**
 * Haalt alle unieke check-ins van gisteren op, controleert de contracten,
 * en verstuurt een samengevat rapport om 09:00.
 */
async function sendExpiringContractsReport(isTest = false) {
    console.log(`[DAGELIJKS RAPPORT] Start contractencheck voor alle check-ins van gisteren.`);
    
    try {
        const { start: yesterdayStart, end: yesterdayEnd } = getYesterdayTimeRange();
        
        // 1. Haal alle bezoeken van gisteren op
        const responseVisits = await axios.get(VG_VISITS_BASE_URL, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                sync_from: yesterdayStart, 
                sync_to: yesterdayEnd,
                limit: 1000 
            }
        });
        
        const visitsResult = responseVisits.data.result || [];
        
        if (visitsResult.length === 0) {
            console.log("[DAGELIJKS RAPPORT] Geen bezoeken gevonden voor gisteren. Rapport leeg.");
            await triggerHomeyDailyReportWebhook("Geen leden ingecheckt gisteren.", isTest);
            return;
        }

        // 2. Filter unieke leden
        const uniqueMemberIds = Array.from(new Set(visitsResult.map(visit => visit.member_id).filter(id => id)));
        console.log(`[DAGELIJKS RAPPORT] ${uniqueMemberIds.length} unieke leden gevonden om te controleren.`);

        const expiringMembers = [];

        // 3. Loop door unieke leden en controleer contracten
        for (const memberId of uniqueMemberIds) {
            const endDate = await getExpiringContractDetails(memberId);
            
            if (endDate) {
                const memberName = await getMemberName(memberId);
                // We slaan de datum nog op in het object, maar gebruiken hem niet in de Homey tag
                expiringMembers.push({ memberName, endDate }); 
            }
        }
        
        // 4. Genereer EENVOUDIG rapport en verstuur Homey Webhook
        let reportText;
        if (expiringMembers.length === 0) {
            reportText = "Contracten Rapport (Gisteren): Geen aflopende contracten gevonden (binnen 4 weken).";
        } else {
            const memberNames = expiringMembers.map(m => m.memberName);
            
            // Maak een nette lijst: "Naam A, Naam B en Naam C"
            let nameList;
            if (memberNames.length === 1) {
                nameList = memberNames[0];
            } else {
                const last = memberNames.pop();
                nameList = memberNames.join(', ') + ' en ' + last;
            }

            // Dit is de korte en duidelijke tag die naar Homey gaat
            reportText = `🔔 CONTRACTEN RAPPORT (Gisteren): ${expiringMembers.length} leden met aflopend contract. Betreft: ${nameList}.`;
        }
        
        console.log(`[DAGELIJKS RAPPORT] Rapport afgerond. Bericht: ${reportText}`);
        await triggerHomeyDailyReportWebhook(reportText, isTest);
        
    } catch (error) {
        console.error("!!! KRITISCHE FOUT BIJ DAGELIJKS RAPPORT AANROEP !!!");
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
        } else {
            console.error("Netwerk/Algemene Fout:", error.message);
        }
    }
}

/**
 * Haalt het totale aantal unieke check-ins op voor de huidige dag en triggert de Homey webhook.
 */
async function sendDailyTotal(isTest = false) {
    try {
        const startOfTodayUtc = getStartOfTodayUtc();
        const nowUtc = Date.now();
        
        const responseTotal = await axios.get(VG_VISITS_BASE_URL, {
            params: {
                api_key: API_KEY,
                club_secret: CLUB_SECRET,
                sync_from: startOfTodayUtc, 
                sync_to: nowUtc,
                limit: 1000
            }
        });
        
        const visitsResult = responseTotal.data.result || [];
        const uniqueMemberIds = Array.from(new Set(visitsResult.map(visit => visit.member_id).filter(id => id)));
        const totalCount = uniqueMemberIds.size;

        if (totalCount >= 0) { 
            console.log(`[DAILY TOTAL]: Totaal aantal UNIEKE check-ins vandaag: ${totalCount}`);
            await triggerHomeyDailyTotalWebhook(totalCount, isTest);
        } else {
             console.warn("[WAARSCHUWING] Onverwachte data structuur voor dagelijks totaal.");
        }

    } catch (error) {
         console.error("!!! KRITISCHE POLLING FOUT BIJ DAGELIJKS TOTAAL AANROEP !!!");
    }
}

/**
 * Controleert elke minuut of de geplande tijd is bereikt voor het dagelijkse totaal (23:59).
 */
function checkDailyTotalSchedule() {
    const amsTime = new Date().toLocaleTimeString('nl-NL', { 
        hour: '2-digit', 
        minute: '2-digit', 
        timeZone: 'Europe/Amsterdam' 
    });

    if (amsTime === DAILY_TOTAL_TIME && !hasTotalBeenSentToday) {
        console.log(`!!! Planning geactiveerd: Tijd om dagelijkse totalen te versturen (${DAILY_TOTAL_TIME}). !!!`);
        sendDailyTotal(false); 
    } 
    
    // Reset de vlag na middernacht
    if (amsTime === '00:01' && hasTotalBeenSentToday) {
        hasTotalBeenSentToday = false;
        console.log("Dagelijkse totaal vlag gereset. Klaar voor de nieuwe dag.");
    }
}

/**
 * Controleert elke minuut of de geplande tijd is bereikt voor het dagelijkse contractrapport (09:00).
 */
function checkMorningReportSchedule() {
    const amsTime = new Date().toLocaleTimeString('nl-NL', { 
        hour: '2-digit', 
        minute: '2-digit', 
        timeZone: 'Europe/Amsterdam' 
    });
    
    if (amsTime === DAILY_REPORT_TIME && !hasReportBeenSentToday) {
        console.log(`!!! Planning geactiveerd: Tijd om contractenrapport te versturen (${DAILY_REPORT_TIME}). !!!`);
        sendExpiringContractsReport(false); 
    } 
    
    // Reset de vlag na middernacht
    if (amsTime === '00:01' && hasReportBeenSentToday) {
        hasReportBeenSentToday = false;
        console.log("Dagelijks rapport vlag gereset. Klaar voor de nieuwe dag.");
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
            let maxTimestamp = latestCheckinTimestamp; 

            // Verwerk elke nieuwe check-in individueel
            for (const visit of newVisits) {
                const memberId = visit.member_id;
                const checkinTs = visit.checkin_time || visit.check_in_timestamp; 

                if (checkinTs > maxTimestamp) {
                    maxTimestamp = checkinTs;
                }

                const memberName = await getMemberName(memberId); 
                
                console.log(`[NIEUWE CHECK-IN VERWERKING]: User ${memberName} (${memberId}) at ${new Date(checkinTs).toISOString()}. Stuurt INDIVIDUELE Homey melding.`);
                
                // Trigger Homey voor individuele check-in
                await triggerHomeyIndividualWebhook(memberName, checkinTs); 
                
                // Korte pauze tegen rate-limits
                await new Promise(resolve => setTimeout(resolve, 50)); 
            }

            // Update de timestamp voor de volgende poll
            latestCheckinTimestamp = maxTimestamp;
            
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

// ENDPOINT VOOR HANDMATIG TESTEN VAN DAGELIJKS TOTAAL
app.get('/test-daily-total-send', async (req, res) => {
    const originalFlag = hasTotalBeenSentToday;
    
    console.log('--- TEST ACTIVERING DAGELIJKS TOTAAL ---');
    await sendDailyTotal(true); 
    
    hasTotalBeenSentToday = originalFlag; 

    res.status(200).send('Dagelijkse totaal-telling geactiveerd. Controleer de Homey logs voor een pushmelding met de tag [TEST].');
});

// NIEUW ENDPOINT VOOR HANDMATIG TESTEN VAN DAGELIJKS RAPPORT
app.get('/test-daily-report-send', async (req, res) => {
    const originalFlag = hasReportBeenSentToday;
    
    console.log('--- TEST ACTIVERING DAGELIJKS CONTRACT RAPPORT (Gebruikt bezoeken van gisteren) ---');
    await sendExpiringContractsReport(true); 
    
    hasReportBeenSentToday = originalFlag; 

    res.status(200).send('Dagelijks Contract Rapport geactiveerd. Controleer de Homey logs voor een pushmelding met de tag [TEST RAPPORT].');
});


// Start de server en de Polling Loops
app.listen(PORT, () => {
    if (!CLUB_ID || !API_KEY || !CLUB_SECRET) {
        console.error("\n!!! KRITISCHE FOUT: AUTHENTICATIEVARIABELEN ONTBREEKEN BIJ START !!!");
        console.error("Zorg ervoor dat CLUB_ID, API_KEY, CLUB_SECRET, HOMEY_URL, HOMEY_DAILY_TOTAL_URL en HOMEY_DAILY_EXPIRING_REPORT_URL zijn ingesteld in de Railway variabelen.");
        process.exit(1);
    }
    console.log(`Virtuagym Polling Service luistert op poort ${PORT}.`);
    
    // 1. Individuele check-in polling loop (elke 2,5 minuut)
    setInterval(pollVirtuagym, POLLING_INTERVAL_MS);
    pollVirtuagym(); // Eerste aanroep direct starten
    
    // 2. Dagelijks Totaal Scheduler (23:59)
    setInterval(checkDailyTotalSchedule, SCHEDULE_CHECK_INTERVAL_MS);
    checkDailyTotalSchedule(); // Eerste aanroep direct starten
    
    // 3. Contracten Rapport Scheduler (09:00)
    setInterval(checkMorningReportSchedule, SCHEDULE_CHECK_INTERVAL_MS);
    checkMorningReportSchedule(); // Eerste aanroep direct starten
    
    console.log(`Polling status: Individueel (${POLLING_INTERVAL_MS / 60000} min), Dagelijks Totaal (${DAILY_TOTAL_TIME}), Contracten Rapport (${DAILY_REPORT_TIME}).`);
});
