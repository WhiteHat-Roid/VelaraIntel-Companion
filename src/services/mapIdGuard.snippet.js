          console.log(`[SV] Run detected: ${latest.dungeonName} +${latest.keyLevel} (${latest.runId})`);

          // Guard: skip runs with invalid mapId — stale data from before addon fix
          if (!latest.mapId || latest.mapId === 0) {
            console.log(`[SV] Skipping run ${latest.runId} — mapId is 0 (stale/pre-fix data)`);
            return;
          }

          const payload = buildV12Payload(latest);