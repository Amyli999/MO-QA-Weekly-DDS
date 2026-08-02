(function () {
    function getRuntimeDiagStore() {
        if (!window.__ddsRuntimeDiag || typeof window.__ddsRuntimeDiag !== 'object') {
            window.__ddsRuntimeDiag = {};
        }
        return window.__ddsRuntimeDiag;
    }

    function recordConflictWinner(details) {
        const diag = getRuntimeDiagStore();
        diag.lastConflictResolutionWinner = details;
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function parseTimestamp(value) {
        const ms = Date.parse(String(value || ''));
        return Number.isFinite(ms) ? ms : null;
    }

    function buildStateKey(workspaceId, key) {
        return `${String(workspaceId || 'cn-mo-qa-default')}:${String(key || '')}`;
    }

    function readLocalCache(storageKey, fallback) {
        try {
            const raw = localStorage.getItem(storageKey);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_error) {
            return fallback;
        }
    }

    function writeLocalCache(storageKey, value) {
        localStorage.setItem(storageKey, JSON.stringify(value));
    }

    function getAuthHeader(config, accessToken) {
        const token = String(accessToken || '').trim();
        if (token) {
            return `Bearer ${token}`;
        }
        return String(config?.anonKey || '');
    }

    function buildHeaders(config, accessToken) {
        return {
            apikey: String(config?.anonKey || ''),
            Authorization: getAuthHeader(config, accessToken),
            'Content-Type': 'application/json'
        };
    }

    function canUseCloud(config) {
        return Boolean(config && config.enabled && config.baseUrl && config.anonKey);
    }

    function getCloudTimestamp(row) {
        if (!row || typeof row !== 'object') return null;
        return row.last_updated || row.updated_at || row?.payload?.lastUpdated || null;
    }

    function getLocalTimestamp(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        return value.lastUpdated || null;
    }

    function withLastUpdated(value, lastUpdated) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return value;
        }
        return {
            ...value,
            lastUpdated
        };
    }

    async function loadFromSupabase(options) {
        const {
            key,
            fallback,
            storageKey = key,
            config = {},
            workspaceId = config.workspaceId || 'cn-mo-qa-default',
            accessToken = '',
            useWorkspaceColumn = Boolean(config.useWorkspaceColumn),
            tableName = String(config.tableName || 'dds_state'),
            onCacheUpdate,
            onOffline,
            localTimestamp
        } = options || {};

        console.log('[DDS] Loading from Supabase', { key });

        if (!canUseCloud(config)) {
            const cached = readLocalCache(storageKey, fallback);
            console.warn('[DDS] Offline mode using localStorage', { key, reason: 'cloud-disabled' });
            onOffline?.({ key, reason: 'cloud-disabled' });
            return cached;
        }

        const baseUrl = String(config.baseUrl || '').replace(/\/$/, '');
        const scopedKey = buildStateKey(workspaceId, key);
        const url = useWorkspaceColumn
            ? `${baseUrl}/rest/v1/${tableName}?workspace_id=eq.${encodeURIComponent(workspaceId)}&state_key=eq.${encodeURIComponent(scopedKey)}&select=payload,last_updated,updated_at,version`
            : `${baseUrl}/rest/v1/${tableName}?state_key=eq.${encodeURIComponent(scopedKey)}&select=payload,last_updated,updated_at,version`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    apikey: String(config.anonKey || ''),
                    Authorization: getAuthHeader(config, accessToken)
                }
            });

            if (!response.ok) {
                throw new Error(`Cloud load failed: ${response.status} ${await response.text()}`);
            }

            const rows = await response.json();
            if (Array.isArray(rows) && rows.length && Object.prototype.hasOwnProperty.call(rows[0], 'payload')) {
                const row = rows[0];
                const localCached = readLocalCache(storageKey, fallback);
                const cloudTimestamp = getCloudTimestamp(row);
                const localTimestampValue = localTimestamp || getLocalTimestamp(localCached);
                const cloudMs = parseTimestamp(cloudTimestamp);
                const localMs = parseTimestamp(localTimestampValue);

                console.log('[DDS] Cloud timestamp', { key, timestamp: cloudTimestamp || null });
                console.log('[DDS] Local timestamp', { key, timestamp: localTimestampValue || null });

                if (cloudMs !== null && localMs !== null && localMs > cloudMs) {
                    console.warn('[DDS] Conflict detected', {
                        key,
                        conflict: 'local-newer-than-cloud-on-load'
                    });
                    console.log('[DDS] Using newest version', { key, source: 'local' });
                    if (key === 'weeklyDDSGeneralState') {
                        recordConflictWinner({
                            key,
                            stage: 'loadFromSupabase',
                            conflict: 'local-newer-than-cloud-on-load',
                            winner: 'local',
                            cloudRecord: cloneJson(row),
                            localRecord: cloneJson(localCached),
                            finalRecord: cloneJson(localCached),
                            resultingNotes: localCached?.notes ?? null,
                            resultingWeekKey: localCached?.weekKey ?? null
                        });
                    }
                    return localCached;
                }

                const payload = row.payload;
                if (key === 'weeklyDDSGeneralState') {
                    getRuntimeDiagStore().supabaseGeneralRecord = cloneJson(row);
                    console.log('[DDS DIAG] exact Supabase record for weeklyDDSGeneralState', {
                        key,
                        row: cloneJson(row),
                        payload: cloneJson(payload),
                        localCached: cloneJson(localCached),
                        cloudTimestamp: cloudTimestamp || null,
                        localTimestamp: localTimestampValue || null
                    });
                    recordConflictWinner({
                        key,
                        stage: 'loadFromSupabase',
                        conflict: null,
                        winner: 'cloud',
                        cloudRecord: cloneJson(row),
                        localRecord: cloneJson(localCached),
                        finalRecord: cloneJson(payload),
                        resultingNotes: payload?.notes ?? null,
                        resultingWeekKey: payload?.weekKey ?? null
                    });
                }
                console.log('[DDS] Using newest version', { key, source: 'cloud' });
                console.log('[DDS] Updating localStorage cache', { key });
                writeLocalCache(storageKey, payload);
                onCacheUpdate?.(cloneJson(payload), row);
                return payload;
            }

            const cached = readLocalCache(storageKey, fallback);
            console.warn('[DDS] Offline mode using localStorage', { key, reason: 'cloud-empty' });
            onOffline?.({ key, reason: 'cloud-empty' });
            return cached;
        } catch (error) {
            const cached = readLocalCache(storageKey, fallback);
            console.warn('[DDS] Offline mode using localStorage', {
                key,
                reason: error?.message || String(error || '')
            });
            onOffline?.({ key, reason: error?.message || String(error || '') });
            return cached;
        }
    }

    async function saveToSupabase(options) {
        const {
            key,
            value,
            storageKey = key,
            config = {},
            workspaceId = config.workspaceId || 'cn-mo-qa-default',
            accessToken = '',
            useWorkspaceColumn = Boolean(config.useWorkspaceColumn),
            tableName = String(config.tableName || 'dds_state'),
            onCacheUpdate,
            onOffline,
            localTimestamp
        } = options || {};

        console.log('[DDS] Saving to Supabase', { key });

        if (!canUseCloud(config)) {
            console.warn('[DDS] Offline mode using localStorage', { key, reason: 'cloud-disabled' });
            onOffline?.({ key, reason: 'cloud-disabled' });
            return false;
        }

        const baseUrl = String(config.baseUrl || '').replace(/\/$/, '');
        const scopedKey = buildStateKey(workspaceId, key);
        const nowIso = new Date().toISOString();
        const payloadWithTimestamp = withLastUpdated(value, nowIso);
        const cachedLocal = readLocalCache(storageKey, null);
        const localTimestampValue = localTimestamp || getLocalTimestamp(value) || getLocalTimestamp(cachedLocal) || null;
        const localMs = parseTimestamp(localTimestampValue);

        const preflightUrl = useWorkspaceColumn
            ? `${baseUrl}/rest/v1/${tableName}?workspace_id=eq.${encodeURIComponent(workspaceId)}&state_key=eq.${encodeURIComponent(scopedKey)}&select=payload,last_updated,updated_at`
            : `${baseUrl}/rest/v1/${tableName}?state_key=eq.${encodeURIComponent(scopedKey)}&select=payload,last_updated,updated_at`;

        let existingRow = null;
        try {
            const preflightResponse = await fetch(preflightUrl, {
                method: 'GET',
                headers: {
                    apikey: String(config.anonKey || ''),
                    Authorization: getAuthHeader(config, accessToken)
                }
            });

            if (preflightResponse.ok) {
                const preflightRows = await preflightResponse.json();
                existingRow = Array.isArray(preflightRows) && preflightRows.length ? preflightRows[0] : null;
            }
        } catch (_error) {
            existingRow = null;
        }

        const cloudTimestamp = getCloudTimestamp(existingRow);
        const cloudMs = parseTimestamp(cloudTimestamp);

        console.log('[DDS] Cloud timestamp', { key, timestamp: cloudTimestamp || null });
        console.log('[DDS] Local timestamp', { key, timestamp: localTimestampValue || null });

        if (cloudMs !== null && (localMs === null || cloudMs > localMs)) {
            console.warn('[DDS] Conflict detected', {
                key,
                conflict: 'cloud-newer-than-local-on-save'
            });
            console.log('[DDS] Using newest version', { key, source: 'cloud' });

            if (existingRow && Object.prototype.hasOwnProperty.call(existingRow, 'payload')) {
                console.log('[DDS] Updating localStorage cache', { key });
                writeLocalCache(storageKey, existingRow.payload);
                onCacheUpdate?.(cloneJson(existingRow.payload), existingRow);
                if (key === 'weeklyDDSGeneralState') {
                    recordConflictWinner({
                        key,
                        stage: 'saveToSupabase',
                        conflict: 'cloud-newer-than-local-on-save',
                        winner: 'cloud',
                        cloudRecord: cloneJson(existingRow),
                        localRecord: cloneJson(value),
                        finalRecord: cloneJson(existingRow.payload),
                        resultingNotes: existingRow?.payload?.notes ?? null,
                        resultingWeekKey: existingRow?.payload?.weekKey ?? null
                    });
                }
            }
            return false;
        }

        const row = {
            state_key: scopedKey,
            payload: payloadWithTimestamp,
            last_updated: nowIso,
            updated_at: nowIso
        };

        if (useWorkspaceColumn) {
            row.workspace_id = workspaceId;
        }

        try {
            const response = await fetch(`${baseUrl}/rest/v1/${tableName}?on_conflict=state_key`, {
                method: 'POST',
                headers: {
                    ...buildHeaders(config, accessToken),
                    Prefer: 'resolution=merge-duplicates,return=minimal'
                },
                body: JSON.stringify([row])
            });

            if (!response.ok) {
                throw new Error(`Cloud save failed: ${response.status} ${await response.text()}`);
            }

            console.log('[DDS] Using newest version', { key, source: 'local' });
            console.log('[DDS] Updating localStorage cache', { key });
            writeLocalCache(storageKey, payloadWithTimestamp);
            onCacheUpdate?.(cloneJson(payloadWithTimestamp), {
                last_updated: nowIso,
                updated_at: nowIso
            });
            if (key === 'weeklyDDSGeneralState') {
                recordConflictWinner({
                    key,
                    stage: 'saveToSupabase',
                    conflict: null,
                    winner: 'local',
                    cloudRecord: cloneJson(existingRow),
                    localRecord: cloneJson(value),
                    finalRecord: cloneJson(payloadWithTimestamp),
                    resultingNotes: payloadWithTimestamp?.notes ?? null,
                    resultingWeekKey: payloadWithTimestamp?.weekKey ?? null
                });
            }
            return true;
        } catch (error) {
            console.warn('[DDS] Offline mode using localStorage', {
                key,
                reason: error?.message || String(error || '')
            });
            onOffline?.({ key, reason: error?.message || String(error || '') });
            return false;
        }
    }

    window.DDSStorageSync = {
        buildStateKey,
        loadFromSupabase,
        saveToSupabase,
        readLocalCache,
        writeLocalCache
    };
})();