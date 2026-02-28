async function poll() {
    if (isPolling || coolingDown) return;
    isPolling = true;

    console.log(`--- Poll gestart op ${new Date().toLocaleTimeString()} ---`);

    try {
        const res = await axios.get(`${VG_BASE}/visits`, { 
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: latestCheckinTimestamp } 
        });
        
        const visits = res.data.result || [];
        
        // DEBUG: Laat de eerste timestamp zien om te zien of het seconden of milliseconden zijn
        if (visits.length > 0) {
            console.log(`[DEBUG] Eerste timestamp van API: ${visits[0].check_in_timestamp}`);
            console.log(`[DEBUG] Huidige tijd server (sec): ${Math.floor(Date.now() / 1000)}`);
        }

        const nuMs = Date.now();
        const vierMinutenInMs = 4 * 60 * 1000;

        const filteredVisits = visits.filter(v => {
            // We checken of de timestamp in seconden of milliseconden is
            const vTime = v.check_in_timestamp > 1000000000000 ? v.check_in_timestamp : v.check_in_timestamp * 1000;
            
            // Alleen verwerken als:
            // 1. Het na onze laatste verwerkte timestamp is
            // 2. Het niet ouder is dan 4 minuten vanaf NU
            return vTime > (latestCheckinTimestamp * 1000) && (nuMs - vTime) < vierMinutenInMs;
        });

        console.log(`API gaf ${visits.length} scans. Na filter blijven er ${filteredVisits.length} over.`);

        if (filteredVisits.length > 0) {
            // Sorteer van oud naar nieuw
            filteredVisits.sort((a, b) => a.check_in_timestamp - b.check_in_timestamp);
            
            // Pak er maximaal 3 tegelijk om NOOIT meer die 429 te krijgen
            const safeBatch = filteredVisits.slice(0, 3);

            for (const visit of safeBatch) {
                await processCheckin(visit);
                // Update timestamp (zorg dat we altijd in seconden opslaan)
                latestCheckinTimestamp = visit.check_in_timestamp > 1000000000000 ? Math.floor(visit.check_in_timestamp / 1000) : visit.check_in_timestamp;
                await new Promise(r => setTimeout(r, 4000)); // Ruime pauze
            }
        } else {
            // Geen nieuwe scans? Zet de teller op NU (in seconden)
            latestCheckinTimestamp = Math.floor(Date.now() / 1000);
            console.log("Geen actuele scans gevonden.");
        }
    } catch (e) {
        console.error("Fout in poll:", e.message);
        if (e.response && e.response.status === 429) {
            coolingDown = true;
            setTimeout(() => { coolingDown = false; }, 600000);
        }
    }
    isPolling = false;
}
