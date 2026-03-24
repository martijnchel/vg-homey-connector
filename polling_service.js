async function runRetentionCheck() {
    console.log("[RETENTIE] Start v11.0 - Diagnose Mode (Geen verzending naar Make)");
    const drieMaandenInMs = 90 * 24 * 60 * 60 * 1000;
    const grensTimestamp = Date.now() - drieMaandenInMs;

    try {
        // 1. Bezoeken ophalen
        const visitRes = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/visits`, {
            params: { api_key: API_KEY, club_secret: CLUB_SECRET, sync_from: grensTimestamp }
        });
        const recentVisitors = new Set((visitRes.data.result || []).map(v => v.member_id));

        // 2. Contracten ophalen
        let allInstances = [];
        let fromId = 0;
        let hasMore = true;
        while (hasMore) {
            const res = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/membership/instance`, {
                params: { api_key: API_KEY, club_secret: CLUB_SECRET, from_id: fromId }
            });
            const results = res.data.result || [];
            allInstances = allInstances.concat(results);
            if (results.length < 100) hasMore = false; else fromId = results[results.length - 1].instance_id;
        }

        // 3. Filteren op Focus/Complete en NIET in recentVisitors
        const sleepers = allInstances.filter(ins => {
            const name = (ins.membership_name || "").toLowerCase();
            const isTarget = (name.includes("focus") || name.includes("complete")) && !name.includes("flex");
            return ins.active === true && isTarget && !recentVisitors.has(ins.member_id);
        });

        console.log(`[RETENTIE] Analyse klaar: ${sleepers.length} potentiële slapers gevonden.`);
        console.log("--- START EERSTE 20 NAMEN TER CONTROLE ---");

        let checkCount = 0;
        for (const s of sleepers) {
            if (checkCount >= 20) break; // We stoppen na 20 namen voor de check

            try {
                const mRes = await axios.get(`https://api.virtuagym.com/api/v1/club/${CLUB_ID}/member/${s.member_id}`, {
                    params: { api_key: API_KEY, club_secret: CLUB_SECRET }
                });
                const m = mRes.data.result;
                
                // Extra check: Is de persoon in de algemene lijst ook echt actief?
                if (m && m.active === 1) {
                    console.log(`CHECK ${checkCount + 1}: ${m.firstname} ${m.lastname || ''} | Abo: ${s.membership_name} | Laatste bezoek volgens API: ${m.last_visit || 'Nooit'}`);
                    checkCount++;
                }
                await new Promise(r => setTimeout(r, 500)); // Voorkom 429 error
            } catch (e) { continue; }
        }

        console.log("--- EINDE CONTROLE LIJST ---");
        console.log("Als deze namen kloppen, zet ik de Webhook weer aan!");

    } catch (e) {
        console.error("[RETENTIE] Fout:", e.message);
    }
}
