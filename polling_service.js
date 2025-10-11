// Virtuagym Polling Service voor Homey Integratie
// Dit bestand luistert niet naar inkomende webhooks, maar vraagt periodiek (pollt)
// de Virtuagym API om nieuwe check-ins op te halen sinds de laatste controle.

const express = require('express');
const axios = require('axios');
// Importeer Node.js Crypto voor anonieme ID's
const crypto = require('crypto');

// Firebase Imports voor Node.js (Gebruik makend van de Canvas Globals)
const { initializeApp } = require("firebase/app");
const { getAuth, signInAnonymously, signInWithCustomToken } = require("firebase/auth");
const { getFirestore, doc, setDoc, getDoc, setLogLevel } = require("firebase/firestore");

const app = express();

// Gebruik de PORT die door de hostingomgeving (Railway) wordt geleverd
const PORT = process.env.PORT || 3000;
const POLLING_INTERVAL_MS = 150000; // Poll individuele check-ins elke 2,5 minuten (150.000 ms)
const SCHEDULE_CHECK_INTERVAL_MS = 60000; // Controleer elke minuut of de scheduled tijd is bereikt

// Configuratie via Omgevingsvariabelen (MOETEN in Railway worden ingesteld!)
const CLUB_ID = process.env.CLUB_ID;
const API_KEY = process.env.API_KEY;
const CLUB_SECRET = process.env.CLUB_SECRET;

// Homey URL's
const HOMEY_INDIVIDUAL_URL = process.env.HOMEY_URL; 
const HOMEY_DAILY_TOTAL_URL = process.env.HOMEY_DAILY_TOTAL_URL; 
const HOMEY_DAILY_EXPIRING_REPORT_URL = process.env.HOMEY_DAILY_EXPIRING_REPORT_URL; 

// Virtuagym Base URL's
const VG_VISITS_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`;
const VG_MEMBER_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member`; 
const VG_MEMBERSHIP_BASE_URL = `https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`; 

// Constanten voor Contract Check
const CONTRACT_EXPIRY_THRESHOLD_MS = 4 * 7 * 24 * 60 * 60 * 1000; // 4 weken in milliseconden
const EXCLUDED_MEMBERSHIP_NAMES = ["Premium Flex", "Student Flex"]; // Uitsluitingen

// Constanten voor Wekelijkse Rapportering (7 dagen)
const TRACKING_COLLECTION_NAME = 'member_report_tracking';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Planningstijden (Amsterdamse Tijd)
const DAILY_TOTAL_TIME = '23:59'; 
const DAILY_REPORT_TIME = '09:00'; 

// Statusvariabelen
let latestCheckinTimestamp = Date.now(); // Houdt de laatste verwerkte check-in tijd bij
let isPolling = false; 
let hasTotalBeenSentToday = false; 
let hasReportBeenSentToday = false; 

// Firebase Globale variabelen (gebruikt door de Canvas omgeving)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'vg-homey-default';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};

let db;
let auth;
let userId = null; // Wordt ingesteld na authenticatie

/**
 * Initialiseert Firebase en de Firestore/Auth services.
 * Gebruikt de Canvas Global variabelen.
 */
async function initializeFirebaseAndAuth() {
    console.log("Starte Firebase initialisatie...");
    try {
        if (Object.keys(firebaseConfig).length === 0) {
            console.error("Firebase Config ontbreekt. Kan tracking niet inschakelen.");
            return;
        }

        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        auth = getAuth(firebaseApp);
        setLogLevel('Debug');

        const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

        if (initialAuthToken) {
            await signInWithCustomToken(auth, initialAuthToken);
        } else {
            // Als er geen token is, meld anoniem aan
            await signInAnonymously(auth);
        }

        userId = auth.currentUser?.uid || crypto.randomUUID();
        console.log(`Firebase geïnitialiseerd. Gebruikers ID: ${userId} (App ID: ${appId})`);

    } catch (error) {
        console.error("Fout bij Firebase Auth/Init:", error.message);
    }
}

/**
 * Firestore Functie: Controleert of een lid in de afgelopen 7 dagen is gemeld en update de status.
 * @param {number} memberId - Het ID van het lid.
 * @returns {Promise<boolean>} True als het lid mag worden gerapporteerd (en de status is bijgewerkt).
 */
async function checkAndRecordReportedStatus(memberId) {
    if (!db || !userId) {
        // Als Firebase niet is geinitialiseerd, rapporteren we altijd (geen tracking)
        console.warn("Firebase niet klaar. Rapporteren zonder 7-dagen limiet.");
        return true; 
    }

    try {
        const docPath = `/artifacts/${appId}/public/data/${TRACKING_COLLECTION_NAME}/${memberId}`;
        const trackingRef = doc(db, docPath);

        const docSnap = await getDoc(trackingRef);
        const now = Date.now();
        
        // 1. Controleer de status
        if (docSnap.exists()) {
            const data = docSnap.data();
            const lastReported = data.lastReported || 0;
            
            if (now - lastReported < ONE_WEEK_MS) {
                // Minder dan 7 dagen geleden gemeld: NIET rapporteren
                return false; 
            }
        }
        
        // 2. Mag gerapporteerd worden. Update de status direct.
        await setDoc(trackingRef, {
            memberId: memberId,
            lastReported: now,
            updateDate: new Date().toISOString()
        }, { merge: true });

        return true; // Rapporteren is toegestaan en de status is bijgewerkt

    } catch (error) {
        console.error(`Fout bij trackingstatus check/update voor lid ${memberId}:`, error.message);
        return true; // Bij fouten rapporteren we voor de zekerheid toch
    }
}

/**
 * Berekent de Unix-tijdstempel (in milliseconden) voor het begin van de huidige dag 
 * in de tijdzone 'Europe/Amsterdam', geconverteerd naar UTC-milliseconden.
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
 * Functie om de Homey Webhook aan te roepen voor een INDIVIDUELE check-in.
 */
async function triggerHomeyIndividualWebhook(memberName, checkinTime) {
    if (!HOMEY_INDIVIDUAL_URL) {
        console.error("Fout: HOMEY_INDIVIDUAL_URL omgevingsvariabele is niet ingesteld. Individuele Homey melding wordt overgeslagen.");
        return; 
    }

    try {
        const tagValue = `${memberName} is nu ingecheckt.`;
        const url = `${HOMEY_INDIVIDUAL_URL}?tag=${encodeURIComponent(tagValue)}&ts=${checkinTime}`;
        
        console.log(`[DEBUG] Sending GET request to Homey (INDIVIDUEEL) met tag: "${tagValue}"`);
        const response = await axios.get(url);
        
        console.log(`Homey Individual Webhook successful. Status: ${response.status}`);
    } catch (error) {
        console.error("Fout bij aanroepen Homey Individuele Webhook:", error.message);
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

/**
 * Controleert de lidmaatschapsstatus van een lid en retourneert de vervaldatum indien van toepassing.
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
            // We sturen toch een 'alles is ok' bericht.
            await triggerHomeyDailyReportWebhook("Contracten Rapport: Geen bezoeken gevonden gisteren, dus geen leden gecontroleerd.", isTest);
            return;
        }

        // 2. Filter unieke leden
        const uniqueMemberIds = Array.from(new Set(visitsResult.map(visit => visit.member_id).filter(id => id)));
        console.log(`[DAGELIJKS RAPPORT] ${uniqueMemberIds.length} unieke leden gevonden om te controleren.`);

        const membersToReport = [];

        // 3. Loop door unieke leden, controleer contracten EN rapportagestatus (7 dagen limiet)
        for (const memberId of uniqueMemberIds) {
            const endDate = await getExpiringContractDetails(memberId);
            
            if (endDate) {
                // Contract loopt af: nu de wekelijkse check uitvoeren
                const canReport = await checkAndRecordReportedStatus(memberId);
                
                if (canReport) {
                    const memberName = await getMemberName(memberId);
                    membersToReport.push({ memberName, endDate }); 
                    console.log(`[RAPPORT INCLUSIEF] Lid ${memberName} wordt gerapporteerd (was > 7 dagen geleden of is nieuw).`);
                } else {
                    console.log(`[RAPPORT UITSLUITING] Lid ${memberId} is in de afgelopen 7 dagen gemeld. Overgeslagen.`);
                }
            }
        }
        
        // 4. Genereer EENVOUDIG rapport en verstuur Homey Webhook
        let reportText;
        if (membersToReport.length === 0) {
            reportText = "Contracten Rapport (Gisteren): Geen *nieuwe* aflopende contracten gevonden (binnen 4 weken) die in de afgelopen 7 dagen *niet* zijn gemeld.";
        } else {
            const memberNames = membersToReport.map(m => m.memberName);
            
            // Maak een nette lijst: "Naam A, Naam B en Naam C"
            let nameList;
            if (memberNames.length === 1) {
                nameList = memberNames[0];
            } else {
                const last = memberNames.pop();
                nameList = memberNames.join(', ') + ' en ' + last;
            }

            // Dit is de korte en duidelijke tag die naar Homey gaat
            reportText = `🔔 CONTRACTEN RAPPORT (Gisteren): ${membersToReport.length} leden met aflopend contract die in de afgelopen week nog niet zijn gemeld. Betreft: ${nameList}.`;
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
        const totalCount = uniqueMemberIds.length; // Gebruik .length op de array

        if (totalCount >= 0) { 
            console.log(`[DAILY TOTAL]: Totaal aantal UNIEKE check-ins vandaag: ${totalCount}`);
            await triggerHomeyDailyTotalWebhook(totalCount, isTest);
        } else {
             console.warn("[WAARSCHUWING] Onverwachte data structuur voor dagelijks totaal.");
        }

    } catch (error) {
         console.error("!!! KRITISCHE POLLING FOUT BIJ DAGELIJKS TOTAAL AANROEP !!!");
         if (error.response) {
            console.error(`Status: ${error.response.status}`);
        } else {
            console.error("Netwerk/Algemene Fout:", error.message);
        }
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
    res.send('Virtuagym-Homey Polling Connector is running and polling every 2.5 minutes. Firebase is ' + (db ? 'geïnitialiseerd' : 'niet klaar') + '.');
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
    
    // We kunnen hier optioneel de tracking negeren voor een complete test, maar laten we de logica testen:
    await sendExpiringContractsReport(true); 
    
    hasReportBeenSentToday = originalFlag; 

    res.status(200).send('Dagelijks Contract Rapport geactiveerd. Controleer de Homey logs voor een pushmelding met de tag [TEST RAPPORT].');
});


// Start de server, Firebase, en de Polling Loops
async function startServer() {
    // Start Firebase en Auth EERST
    await initializeFirebaseAndAuth();

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
}

startServer();
