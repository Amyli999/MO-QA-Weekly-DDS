const DEFAULT_REMINDER_ITEMS = [
    { key: 'project-kickoff', label: 'Any project kick off or SOS' },
    { key: 'leadership-visit', label: 'Any leadership/external visit in +/- 1 week' },
    { key: 'vacation-plan', label: 'Coming onsite/vacation plan' },
    { key: 'shipment-trend', label: 'Monthly shipment trend (last week)' }
];

const DEFAULT_TRIGGER_ROWS = [
    'Any QI/QA happen in last week?',
    'Any open QIs?',
    'Any product on hold which initiated by DC (> 50cs)?',
    'Any DC trigger CCS and require validation?',
    'Any 3PL vendor change or 3PL QA change?',
    'Any MO related global SOP/Policy plan to change?'
];

const WORKSPACE_CONFIG_STORAGE_KEY = 'weeklyDDSWorkspaceConfigState';
const LOCAL_STATE_FRESHNESS_META_KEY = '__dds_local_state_freshness_v1';
const LOCAL_TO_CLOUD_SYNC_KEYS = [
    'weeklyDDSGeneralState',
    'weeklyDDSTriggersDateState',
    'weeklyDDSTriggersState',
    'weeklyDDSTriggerDetailsState',
    'weeklyDDSFollowUpsState',
    'weeklyDDSHistoryArchive',
    WORKSPACE_CONFIG_STORAGE_KEY
];

const teamMembers = ['Amy', 'Ben', 'Cathy', 'Diana', 'Ethan', 'Frank'];
const followupBucketOrder = ['DDS FU', 'Command Center', 'Quality System Related', 'Others'];
let followupAddLocked = false;
let handlersAttached = false;
const followupAddCooldownMs = 450;

const cloudSyncState = {
    enabled: false,
    supabaseSyncEnabled: false,
    baseUrl: '',
    anonKey: '',
    tableName: 'dds_state',
    workspaceId: 'cn-mo-qa-default',
    requireAuth: false,
    useWorkspaceColumn: false,
    accessToken: '',
    currentUserEmail: '',
    currentUserRole: '',
    authClient: null,
    identityOnlyMode: false,
    pendingSaves: new Map(),
    rollbackSnapshots: [],
    flushTimer: null,
    activeRequests: 0
};

const DUAL_WRITE_LOG_PREFIX = '[DDS DualWrite]';
const runtimeStateCache = new Map();

function isMobileAuthDevice() {
    if (typeof navigator === 'undefined') {
        return false;
    }

    const ua = String(navigator.userAgent || '');
    if (/Android|iPhone|iPad|iPod/i.test(ua)) {
        return true;
    }

    return Boolean(navigator.userAgentData && navigator.userAgentData.mobile);
}

function getMobileAuthRedirectUrl() {
    return new URL('auth/callback.html', window.location.href).toString();
}

function parseIsoTime(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function loadLocalFreshnessMetaMap() {
    try {
        const raw = window.DDSStorageSync?.readLocalCache(LOCAL_STATE_FRESHNESS_META_KEY, null);
        const parsed = raw && typeof raw === 'object' ? raw : (raw ? JSON.parse(raw) : {});
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
        return {};
    }
}

function saveLocalFreshnessMetaMap(map) {
    if (window.DDSStorageSync) {
        window.DDSStorageSync.writeLocalCache(LOCAL_STATE_FRESHNESS_META_KEY, map);
        return;
    }
    localStorage.setItem(LOCAL_STATE_FRESHNESS_META_KEY, JSON.stringify(map));
}

function getLocalFreshnessMeta(key) {
    const map = loadLocalFreshnessMetaMap();
    const entry = map?.[key];
    return entry && typeof entry === 'object' ? entry : null;
}

function updateLocalFreshnessMeta(key, updates = {}) {
    const map = loadLocalFreshnessMetaMap();
    const existing = map?.[key] && typeof map[key] === 'object' ? map[key] : {};
    const existingVersion = toFiniteNumber(existing.version) || 0;
    const incomingVersion = toFiniteNumber(updates.version);
    const nextVersion = incomingVersion !== null ? incomingVersion : existingVersion + 1;

    map[key] = {
        version: nextVersion,
        updatedAt: String(updates.updatedAt || new Date().toISOString()),
        source: String(updates.source || existing.source || 'local')
    };

    saveLocalFreshnessMetaMap(map);
    return map[key];
}

function setRuntimeState(key, value) {
    runtimeStateCache.set(String(key), JSON.parse(JSON.stringify(value)));
    if (String(key) === 'weeklyDDSGeneralState') {
        window.weeklyDDSGeneralState = JSON.parse(JSON.stringify(value));
        const diag = ensureRuntimeDiagStore();
        diag.lastGeneralStateSource = 'runtime memory (state)';
        if (!diag.firstTest999Appearance && JSON.stringify(value).includes('TEST999')) {
            diag.firstTest999Appearance = {
                tag: 'setRuntimeState',
                location: 'runtime memory (state)',
                value: JSON.parse(JSON.stringify(value))
            };
        }
    }
}

function getRuntimeState(key) {
    return runtimeStateCache.has(String(key)) ? JSON.parse(JSON.stringify(runtimeStateCache.get(String(key)))) : null;
}

function logGeneralStateDiagnostic(stage, details = {}) {
    console.log('[DDS Diagnostic]', stage, details);
}

function ensureRuntimeDiagStore() {
    if (!window.__ddsRuntimeDiag || typeof window.__ddsRuntimeDiag !== 'object') {
        window.__ddsRuntimeDiag = {};
    }
    return window.__ddsRuntimeDiag;
}

function captureRuntimeSnapshot(tag) {
    const diag = ensureRuntimeDiagStore();
    const stateFromLoadState = loadState('weeklyDDSGeneralState', { weekKey: '', notes: {} });
    const requestedNotesElement = document.getElementById('generalNotes');
    const actualNotesElement = document.getElementById('general-notes-input');
    const actualNotesValue = actualNotesElement ? String(actualNotesElement.value || '') : '';

    if (!diag.firstTest999Appearance && actualNotesValue.includes('TEST999')) {
        diag.firstTest999Appearance = {
            tag,
            location: 'textarea#general-notes-input',
            value: actualNotesValue
        };
    }

    console.log('[DDS DIAG] JSON.stringify(window.weeklyDDSGeneralState) =', JSON.stringify(window.weeklyDDSGeneralState));
    console.log('[DDS DIAG] JSON.stringify(loadState(\'weeklyDDSGeneralState\')) =', JSON.stringify(stateFromLoadState));
    console.log('[DDS DIAG] Supabase record returned by loadFromSupabase(\'weeklyDDSGeneralState\') =', JSON.stringify(diag.supabaseGeneralRecord || null));
    console.log('[DDS DIAG] document.getElementById(\'generalNotes\').value =', requestedNotesElement ? requestedNotesElement.value : null);
    console.log('[DDS DIAG] Current weekKey =', getWeekKey(new Date()));
    console.log('[DDS DIAG] Current user identity =', JSON.stringify({
        email: cloudSyncState.currentUserEmail || '',
        role: cloudSyncState.currentUserRole || '',
        identityOnlyMode: Boolean(cloudSyncState.identityOnlyMode)
    }));
    console.log('[DDS DIAG] Current conflict resolution winner =', JSON.stringify(diag.lastConflictResolutionWinner || null));
    console.log('[DDS DIAG] DESKTOP CURRENT NOTES VALUE =', actualNotesValue);
}

function decideBootstrapOverwrite(localKey, cloudRow) {
    const localRaw = window.DDSStorageSync
        ? window.DDSStorageSync.readLocalCache(localKey, null)
        : localStorage.getItem(localKey);
    if (localRaw === null) {
        return { overwrite: true, reason: 'no-local-state' };
    }

    const localMeta = getLocalFreshnessMeta(localKey);
    const cloudVersion = toFiniteNumber(cloudRow?.version);
    const cloudUpdatedAt = parseIsoTime(cloudRow?.updated_at);

    if (!localMeta) {
        return { overwrite: false, reason: 'ambiguous-missing-local-meta', warn: true };
    }

    const localVersion = toFiniteNumber(localMeta.version);
    const localUpdatedAt = parseIsoTime(localMeta.updatedAt);

    if (localVersion !== null && cloudVersion !== null && localUpdatedAt !== null && cloudUpdatedAt !== null) {
        const versionSaysCloudNewer = cloudVersion > localVersion;
        const timeSaysCloudNewer = cloudUpdatedAt > localUpdatedAt;
        const versionSaysLocalNewer = cloudVersion < localVersion;
        const timeSaysLocalNewer = cloudUpdatedAt < localUpdatedAt;

        if ((versionSaysCloudNewer && timeSaysLocalNewer) || (versionSaysLocalNewer && timeSaysCloudNewer)) {
            return {
                overwrite: false,
                reason: 'conflict-version-timestamp-mismatch',
                warn: true,
                localVersion,
                cloudVersion,
                localUpdatedAt: localMeta.updatedAt,
                cloudUpdatedAt: cloudRow?.updated_at || ''
            };
        }
    }

    if (localVersion !== null && cloudVersion !== null) {
        if (cloudVersion > localVersion) {
            return { overwrite: true, reason: 'cloud-version-newer' };
        }
        if (cloudVersion < localVersion) {
            return {
                overwrite: false,
                reason: 'local-version-newer',
                localVersion,
                cloudVersion
            };
        }
    }

    if (localUpdatedAt !== null && cloudUpdatedAt !== null) {
        if (cloudUpdatedAt > localUpdatedAt) {
            return { overwrite: true, reason: 'cloud-timestamp-newer' };
        }
        if (cloudUpdatedAt < localUpdatedAt) {
            return {
                overwrite: false,
                reason: 'local-timestamp-newer',
                localUpdatedAt: localMeta.updatedAt,
                cloudUpdatedAt: cloudRow?.updated_at || ''
            };
        }
        return { overwrite: false, reason: 'equal-freshness' };
    }

    return {
        overwrite: false,
        reason: 'ambiguous-insufficient-freshness-data',
        warn: true,
        localVersion,
        cloudVersion,
        localUpdatedAt: localMeta.updatedAt,
        cloudUpdatedAt: cloudRow?.updated_at || ''
    };
}

async function fetchBootstrapRows(scopedPrefix) {
    const withVersionQuery = cloudSyncState.useWorkspaceColumn
        ? `/rest/v1/${cloudSyncState.tableName}?select=state_key,payload,updated_at,version&workspace_id=eq.${encodeURIComponent(cloudSyncState.workspaceId)}`
        : `/rest/v1/${cloudSyncState.tableName}?select=state_key,payload,updated_at,version&state_key=like.${encodeURIComponent(`${scopedPrefix}*`)}`;

    const withoutVersionQuery = cloudSyncState.useWorkspaceColumn
        ? `/rest/v1/${cloudSyncState.tableName}?select=state_key,payload,updated_at&workspace_id=eq.${encodeURIComponent(cloudSyncState.workspaceId)}`
        : `/rest/v1/${cloudSyncState.tableName}?select=state_key,payload,updated_at&state_key=like.${encodeURIComponent(`${scopedPrefix}*`)}`;

    try {
        return await cloudFetch(
            withVersionQuery,
            {
                method: 'GET',
                headers: buildCloudHeaders()
            }
        );
    } catch (error) {
        const message = String(error?.message || error || '').toLowerCase();
        if (!message.includes('version')) {
            throw error;
        }
        console.warn(`${DUAL_WRITE_LOG_PREFIX} conflict`, {
            context: 'bootstrapFromCloud',
            workspaceId: cloudSyncState.workspaceId,
            reason: 'version-column-unavailable-fallback-to-updated_at'
        });
        return cloudFetch(
            withoutVersionQuery,
            {
                method: 'GET',
                headers: buildCloudHeaders()
            }
        );
    }
}

function isSupabaseSyncEnabled() {
    const config = window.DDS_CLOUD_CONFIG || {};
    return Boolean(config.ENABLE_SUPABASE_SYNC === true);
}

function classifyCloudWriteFailure(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (message.includes('409') || message.includes('412') || message.includes('conflict') || message.includes('duplicate key')) {
        return 'conflict';
    }
    return 'fail';
}

function logDualWriteResult(status, context, meta = {}) {
    const details = {
        context,
        workspaceId: cloudSyncState.workspaceId,
        ...meta
    };

    if (status === 'success') {
        console.log(`${DUAL_WRITE_LOG_PREFIX} success`, details);
        return;
    }

    if (status === 'conflict') {
        console.warn(`${DUAL_WRITE_LOG_PREFIX} conflict`, details);
        return;
    }

    console.warn(`${DUAL_WRITE_LOG_PREFIX} fail`, details);
}

function snapshotPendingSaves(entries) {
    return entries.map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]);
}

function registerRollbackSnapshot(context, entries) {
    const snapshot = {
        context,
        at: new Date().toISOString(),
        entries: snapshotPendingSaves(entries)
    };
    cloudSyncState.rollbackSnapshots.push(snapshot);
    if (cloudSyncState.rollbackSnapshots.length > 30) {
        cloudSyncState.rollbackSnapshots.shift();
    }
    return snapshot;
}

function rollbackPendingSavesFromSnapshot(snapshot, error) {
    if (!snapshot || !Array.isArray(snapshot.entries)) return;
    snapshot.entries.forEach(([key, value]) => {
        if (!cloudSyncState.pendingSaves.has(key)) {
            cloudSyncState.pendingSaves.set(key, value);
        }
    });
    const status = classifyCloudWriteFailure(error);
    logDualWriteResult(status, `${snapshot.context}:rollback`, {
        pendingKeys: snapshot.entries.map(([key]) => key),
        reason: error?.message || String(error || '')
    });
}

function setAuthMessage(message, isError = false) {
    const authMessage = document.getElementById('auth-message');
    if (!authMessage) return;
    authMessage.textContent = message || '';
    authMessage.style.color = isError ? '#ffd9d6' : '#ffe9a5';
}

function updateAdminNavAccess() {
    const historyLink = document.getElementById('history-nav-link');
    if (!historyLink) return;

    let allowHistory = false;

    if (!cloudSyncState.enabled) {
        allowHistory = false;
    } else if (!cloudSyncState.requireAuth) {
        allowHistory = true;
    } else {
        allowHistory = cloudSyncState.currentUserRole === 'admin' || cloudSyncState.currentUserRole === 'editor';
    }

    [
        { link: historyLink, allowed: allowHistory }
    ].forEach(({ link, allowed }) => {
        if (!link) return;
        if (allowed) {
            link.classList.remove('nav-disabled');
            link.dataset.locked = 'false';
        } else {
            link.classList.add('nav-disabled');
            link.dataset.locked = 'true';
        }
    });
}

function getMemberAccessSnapshot() {
    const config = window.DDS_CLOUD_CONFIG || {};
    const merged = new Map();

    const addEntry = (email, role) => {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        const normalizedRole = String(role || '').trim().toLowerCase();
        if (!normalizedEmail || !normalizedRole) return;
        merged.set(normalizedEmail, { email: normalizedEmail, role: normalizedRole });
    };

    if (Array.isArray(config.memberAccess)) {
        config.memberAccess.forEach((item) => addEntry(item?.email, item?.role));
    }

    return Array.from(merged.values());
}

function resolveMemberRoleForEmail(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return '';
    return getMemberAccessSnapshot().find((item) => item.email === normalizedEmail)?.role || '';
}

function activateIdentityOnlySession(email, role) {
    cloudSyncState.accessToken = '';
    cloudSyncState.currentUserEmail = String(email || '').trim().toLowerCase();
    cloudSyncState.currentUserRole = String(role || '').trim().toLowerCase();
    cloudSyncState.identityOnlyMode = true;
    updateAuthUi();
    updateAdminNavAccess();
}

function updateAuthUi() {
    ensureLocalSyncButton();

    const authInput = document.getElementById('auth-email-input');
    const loginButton = document.getElementById('auth-login-btn');
    const logoutButton = document.getElementById('auth-logout-btn');
    const userLabel = document.getElementById('auth-user-label');

    const signedIn = Boolean(cloudSyncState.currentUserEmail);
    if (userLabel) {
        if (!signedIn) {
            userLabel.textContent = 'Not signed in';
        } else if (cloudSyncState.currentUserRole) {
            userLabel.textContent = `Signed in: ${cloudSyncState.currentUserEmail} (${cloudSyncState.currentUserRole})`;
        } else {
            userLabel.textContent = `Signed in: ${cloudSyncState.currentUserEmail}`;
        }
    }
    if (logoutButton) {
        logoutButton.disabled = !signedIn;
    }
    if (loginButton) {
        loginButton.disabled = cloudSyncState.enabled && !cloudSyncState.authClient;
    }
    if (authInput) {
        authInput.value = signedIn ? cloudSyncState.currentUserEmail : '';
    }

    updateLocalSyncButtonState();
}

function updateLocalSyncButtonState() {
    const syncButton = document.getElementById('sync-local-to-cloud-btn');
    if (!syncButton) return;

    const canSync = Boolean(cloudSyncState.enabled && hasWritePermission());
    syncButton.disabled = !canSync;
}

function hasWritePermission() {
    if (!cloudSyncState.enabled) return false;
    if (!cloudSyncState.requireAuth) return true;
    return cloudSyncState.currentUserRole === 'admin' || cloudSyncState.currentUserRole === 'editor';
}

function canManageWorkspaceContent() {
    if (!cloudSyncState.enabled) return false;
    if (!cloudSyncState.requireAuth) return true;
    return cloudSyncState.currentUserRole === 'admin';
}

function applyPermissionMode() {
    const readOnly = !hasWritePermission();
    const banner = document.getElementById('permission-banner');
    if (banner) {
        if (cloudSyncState.identityOnlyMode && cloudSyncState.currentUserRole) {
            banner.textContent = `Identity verified: ${cloudSyncState.currentUserRole}.`;
        } else {
            banner.textContent = readOnly ? 'Read-only mode: viewer access for this email.' : '';
        }
    }

    document.querySelectorAll('main input, main textarea, main select, main button').forEach((el) => {
        el.disabled = readOnly;
    });

    // Keep admin-only controls locked for non-admin users even when editor write mode is enabled.
    const canManage = canManageWorkspaceContent();
    const triggerStartDate = document.getElementById('trigger-start-date');
    const addTriggerButton = document.getElementById('add-trigger-row-btn');
    if (triggerStartDate) {
        triggerStartDate.disabled = !canManage;
        triggerStartDate.readOnly = !canManage;
    }
    if (addTriggerButton) {
        addTriggerButton.disabled = !canManage;
    }

    updateLocalSyncButtonState();
}

function applyAuthSession(session) {
    cloudSyncState.accessToken = session?.access_token || '';
    cloudSyncState.currentUserEmail = session?.user?.email || '';
    cloudSyncState.currentUserRole = '';
    cloudSyncState.identityOnlyMode = false;
    if (cloudSyncState.accessToken) {
        console.log('[DDS] Access token acquired');
    }
    updateAuthUi();
    updateAdminNavAccess();
}

function isLocalhostMode() {
    const host = String(window.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
}

function showWaitingForSessionState() {
    console.log('[DDS] Waiting for session');
    setSyncIndicator('local', 'Waiting for login');
    setAuthMessage('Sign in with your email to load DDS data.');

    const banner = document.getElementById('permission-banner');
    if (banner) {
        banner.textContent = 'Waiting for sign in before loading dashboard data.';
    }

    applyPermissionMode();
}

async function runAuthenticatedBootstrap() {
    const allowIdentityMode = cloudSyncState.identityOnlyMode && Boolean(cloudSyncState.currentUserRole);
    const mobileAuthFlow = !allowIdentityMode && isMobileAuthDevice() && Boolean(cloudSyncState.accessToken);

    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken && !allowIdentityMode) {
        showWaitingForSessionState();
        return false;
    }

    if (cloudSyncState.requireAuth && cloudSyncState.accessToken) {
        await fetchCurrentUserRole();
        if (!cloudSyncState.currentUserRole) {
            setSyncIndicator('error', 'No workspace permission for this email');
            applyPermissionMode();
            return false;
        }
    }

    console.log(allowIdentityMode ? '[DDS] Identity bootstrap started' : mobileAuthFlow ? '[DDS] Mobile bootstrap started' : '[DDS] Starting cloud bootstrap');
    await bootstrapFromCloud();
    console.log('[DDS DIAG] weeklyDDSGeneralState after bootstrapFromCloud()', loadState('weeklyDDSGeneralState', { weekKey: '', notes: {} }));
    console.log(allowIdentityMode ? '[DDS] Identity bootstrap completed' : mobileAuthFlow ? '[DDS] Mobile bootstrap completed' : '[DDS] Cloud bootstrap complete');

    const banner = document.getElementById('permission-banner');
    if (banner) {
        banner.textContent = '';
    }

    renderAllSections();
    applyPermissionMode();
    updateAdminNavAccess();
    captureRuntimeSnapshot('after runAuthenticatedBootstrap');
    return true;
}

async function fetchCurrentUserRole() {
    if (!cloudSyncState.enabled || !cloudSyncState.currentUserEmail) {
        cloudSyncState.currentUserRole = '';
        updateAuthUi();
        return;
    }

    const email = encodeURIComponent(String(cloudSyncState.currentUserEmail).toLowerCase());
    const workspaceId = encodeURIComponent(cloudSyncState.workspaceId);
    const rows = await cloudFetch(
        `/rest/v1/dds_workspace_members?select=role&workspace_id=eq.${workspaceId}&email=eq.${email}`,
        {
            method: 'GET',
            headers: buildCloudHeaders()
        }
    );

    cloudSyncState.currentUserRole = Array.isArray(rows) && rows[0]?.role ? rows[0].role : '';
    updateAuthUi();
    updateAdminNavAccess();
}

async function initializeAuth(config) {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        setAuthMessage('Access service not available.', true);
        updateAuthUi();
        return;
    }

    cloudSyncState.authClient = window.supabase.createClient(cloudSyncState.baseUrl, cloudSyncState.anonKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    });

    const authInput = document.getElementById('auth-email-input');
    const loginButton = document.getElementById('auth-login-btn');
    const logoutButton = document.getElementById('auth-logout-btn');

    if (loginButton) {
        loginButton.addEventListener('click', async () => {
            const email = String(authInput?.value || '').trim();
            if (!email) {
                setAuthMessage('Please enter your email first.', true);
                return;
            }

            const role = resolveMemberRoleForEmail(email);
            if (!role) {
                setAuthMessage('No workspace permission for this email.', true);
                return;
            }

            if (isLocalhostMode()) {
                console.log('[DDS] Localhost mode');
            }

            activateIdentityOnlySession(email, role);
            console.log(isLocalhostMode() ? '[DDS] Local identity verified' : '[DDS] Identity verified');
            setAuthMessage(`Identity verified: ${email} (${role})`);
            setSyncIndicator('synced', 'Identity verified');

            try {
                await runAuthenticatedBootstrap();
            } catch (error) {
                setAuthMessage(`Login warning: ${error.message || error}`, true);
            }
        });
    }

    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            if (cloudSyncState.authClient) {
                await cloudSyncState.authClient.auth.signOut();
            }
            cloudSyncState.accessToken = '';
            cloudSyncState.currentUserEmail = '';
            cloudSyncState.currentUserRole = '';
            cloudSyncState.identityOnlyMode = false;
            applyAuthSession(null);
            setAuthMessage('Signed out.');
            if (cloudSyncState.requireAuth) {
                setSyncIndicator('error', 'Sign in with your email to continue');
            }
        });
    }

    if (cloudSyncState.authClient) {
        const { data: sessionData } = await cloudSyncState.authClient.auth.getSession();
        applyAuthSession(sessionData?.session || null);
        if (sessionData?.session?.access_token) {
            if (isMobileAuthDevice()) {
                console.log('[DDS] Mobile session restored');
                console.log('[DDS] Mobile access token acquired');
            }
            console.log('[DDS] Session restored');
        } else if (cloudSyncState.requireAuth && !isLocalhostMode()) {
            console.log('[DDS] Session missing');
        }

        cloudSyncState.authClient.auth.onAuthStateChange(async (_event, session) => {
            applyAuthSession(session || null);
            if (session?.access_token) {
                console.log('[DDS] Session restored');
            } else if (cloudSyncState.requireAuth && !isLocalhostMode()) {
                console.log('[DDS] Session missing');
            }

            if (cloudSyncState.enabled && (!cloudSyncState.requireAuth || cloudSyncState.accessToken)) {
                try {
                    await runAuthenticatedBootstrap();
                } catch (_error) {
                    setSyncIndicator('error', 'Permission check failed.');
                }
            } else if (cloudSyncState.requireAuth) {
                if (isLocalhostMode()) {
                    console.log('[DDS] Localhost mode');
                    setSyncIndicator('local', 'Use memberAccess email for localhost login');
                    setAuthMessage('Localhost mode: use a memberAccess email to verify identity.');
                    applyPermissionMode();
                } else {
                    showWaitingForSessionState();
                }
            }
        });
    } else {
        applyAuthSession(null);
    }

    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken) {
        if (isLocalhostMode()) {
            console.log('[DDS] Localhost mode');
            setSyncIndicator('local', 'Use memberAccess email for localhost login');
            setAuthMessage('Localhost mode: use a memberAccess email to verify identity.');
            applyPermissionMode();
        } else {
            showWaitingForSessionState();
        }
    }

    const syncButton = document.getElementById('sync-local-to-cloud-btn');
    if (syncButton) {
        syncButton.addEventListener('click', async () => {
            await syncLocalDataToCloud();
        });
    }

    updateAuthUi();
}

function setSyncIndicator(status, message) {
    const indicator = document.getElementById('sync-status');
    if (!indicator) return;

    indicator.className = `sync-status sync-${status}`;
    indicator.textContent = message;
}

function ensureLocalSyncButton() {
    const existingButton = document.getElementById('sync-local-to-cloud-btn');
    if (existingButton) return existingButton;

    const authControls = document.querySelector('.auth-controls');
    if (!authControls) return null;

    const button = document.createElement('button');
    button.id = 'sync-local-to-cloud-btn';
    button.type = 'button';
    button.textContent = 'Sync local data to cloud';
    button.addEventListener('click', async () => {
        await syncLocalDataToCloud();
    });

    authControls.appendChild(button);
    return button;
}

function buildCloudHeaders() {
    const bearer = cloudSyncState.accessToken || cloudSyncState.anonKey;
    return {
        apikey: cloudSyncState.anonKey,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
    };
}

function buildScopedStateKey(key) {
    return `${cloudSyncState.workspaceId}:${key}`;
}

function startSyncRequest() {
    cloudSyncState.activeRequests += 1;
    setSyncIndicator('syncing', 'Cloud sync in progress...');
}

function endSyncRequest() {
    cloudSyncState.activeRequests = Math.max(0, cloudSyncState.activeRequests - 1);
    if (cloudSyncState.activeRequests === 0) {
        setSyncIndicator('synced', 'Cloud synced');
    }
}

async function cloudFetch(path, options = {}) {
    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken && !(cloudSyncState.identityOnlyMode && cloudSyncState.currentUserRole)) {
        throw new Error('Sign in with your email to continue');
    }

    const method = String(options.method || 'GET').toUpperCase();

    const url = `${cloudSyncState.baseUrl}${path}`;
    startSyncRequest();

    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Cloud sync failed: ${response.status} ${errorText}`);
        }
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return response.json();
        }
        return null;
    } finally {
        endSyncRequest();
    }
}

function scheduleCloudSave(key, value) {
    if (!cloudSyncState.enabled) return;
    if (!cloudSyncState.supabaseSyncEnabled) return;
    if (cloudSyncState.identityOnlyMode) return;
    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken) return;
    if (!hasWritePermission()) return;

    cloudSyncState.pendingSaves.set(key, JSON.parse(JSON.stringify(value)));
    if (cloudSyncState.flushTimer) return;

    cloudSyncState.flushTimer = setTimeout(() => {
        flushCloudSaves().catch(() => {
            setSyncIndicator('error', 'Save failed. Local changes are still saved.');
        });
    }, 700);
}

async function flushCloudSaves() {
    if (!cloudSyncState.enabled || cloudSyncState.pendingSaves.size === 0) {
        cloudSyncState.flushTimer = null;
        return;
    }

    if (!cloudSyncState.supabaseSyncEnabled) {
        cloudSyncState.flushTimer = null;
        return;
    }

    const pendingEntries = Array.from(cloudSyncState.pendingSaves.entries());
    const payloadRows = pendingEntries.map(([key, value]) => {
        const row = {
            state_key: buildScopedStateKey(key),
            payload: value,
            updated_at: new Date().toISOString()
        };
        if (cloudSyncState.useWorkspaceColumn) {
            row.workspace_id = cloudSyncState.workspaceId;
        }
        return row;
    });

    cloudSyncState.pendingSaves.clear();
    cloudSyncState.flushTimer = null;

    const rollbackSnapshot = registerRollbackSnapshot('flushCloudSaves', pendingEntries);

    try {
        await cloudFetch(
            `/rest/v1/${cloudSyncState.tableName}?on_conflict=state_key`,
            {
                method: 'POST',
                headers: {
                    ...buildCloudHeaders(),
                    Prefer: 'resolution=merge-duplicates,return=minimal'
                },
                body: JSON.stringify(payloadRows)
            }
        );
        logDualWriteResult('success', 'flushCloudSaves', {
            keys: pendingEntries.map(([key]) => key),
            rowCount: payloadRows.length
        });
    } catch (error) {
        rollbackPendingSavesFromSnapshot(rollbackSnapshot, error);
        const status = classifyCloudWriteFailure(error);
        logDualWriteResult(status, 'flushCloudSaves', {
            keys: pendingEntries.map(([key]) => key),
            reason: error?.message || String(error || '')
        });
    }
}

function getLocalCloudSyncPayloadRows() {
    const payloadRows = [];

    LOCAL_TO_CLOUD_SYNC_KEYS.forEach((key) => {
        if (key === WORKSPACE_CONFIG_STORAGE_KEY && !canManageWorkspaceContent()) {
            return;
        }

        const payload = getRuntimeState(key) ?? (window.DDSStorageSync?.readLocalCache(key, null) ?? null);
        if (payload === null || payload === undefined) {
            return;
        }

        const row = {
            state_key: buildScopedStateKey(key),
            payload,
            updated_at: new Date().toISOString()
        };

        if (cloudSyncState.useWorkspaceColumn) {
            row.workspace_id = cloudSyncState.workspaceId;
        }

        payloadRows.push(row);
    });

    return payloadRows;
}

async function syncLocalDataToCloud() {
    if (!cloudSyncState.enabled) {
        setAuthMessage('Cloud sync is not enabled for this workspace.', true);
        return;
    }

    if (!cloudSyncState.supabaseSyncEnabled) {
        setAuthMessage('Supabase sync is disabled by feature flag.');
        logDualWriteResult('fail', 'syncLocalDataToCloud', {
            reason: 'ENABLE_SUPABASE_SYNC is false'
        });
        return;
    }

    if (!hasWritePermission()) {
        setAuthMessage('Only admin or editor can sync local data to cloud.', true);
        return;
    }

    if (!cloudSyncState.baseUrl || !cloudSyncState.anonKey) {
        setAuthMessage('Cloud service is not configured.', true);
        return;
    }

    const syncButton = document.getElementById('sync-local-to-cloud-btn');

    try {
        if (syncButton) {
            syncButton.disabled = true;
            syncButton.textContent = 'Syncing...';
        }

        setSyncIndicator('syncing', 'Syncing local data to cloud...');
        setAuthMessage('Syncing local data to cloud...');

        if (!cloudSyncState.identityOnlyMode) {
            await flushCloudSaves();
        }

        const payloadRows = getLocalCloudSyncPayloadRows();
        if (!payloadRows.length) {
            setSyncIndicator('synced', 'No local data to sync');
            setAuthMessage('No local data found for cloud sync.');
            return;
        }

        const response = await fetch(
            `${cloudSyncState.baseUrl}/rest/v1/${cloudSyncState.tableName}?on_conflict=state_key`,
            {
                method: 'POST',
                headers: {
                    ...buildCloudHeaders(),
                    Prefer: 'resolution=merge-duplicates,return=minimal'
                },
                body: JSON.stringify(payloadRows)
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            const status = response.status === 409 || response.status === 412 ? 'conflict' : 'fail';
            logDualWriteResult(status, 'syncLocalDataToCloud', {
                rowCount: payloadRows.length,
                statusCode: response.status,
                reason: errorText
            });
            throw new Error(`Sync failed: ${response.status} ${errorText}`);
        }

        logDualWriteResult('success', 'syncLocalDataToCloud', {
            rowCount: payloadRows.length
        });

        await bootstrapFromCloud();
        renderAllSections();
        applyPermissionMode();

        setSyncIndicator('synced', `Cloud synced (${payloadRows.length} state keys)`);
        setAuthMessage('Local data synced to cloud.');
    } catch (error) {
        setSyncIndicator('error', 'Sync failed. Local data is still safe.');
        setAuthMessage(error?.message || 'Sync failed. Please retry.', true);
    } finally {
        if (syncButton) {
            syncButton.textContent = 'Sync local data to cloud';
        }
        updateLocalSyncButtonState();
    }
}

async function bootstrapFromCloud() {
    const config = window.DDS_CLOUD_CONFIG || {};
    cloudSyncState.enabled = Boolean(config.enabled);

    if (!cloudSyncState.enabled) {
        setSyncIndicator('local', 'Enter your email to get access');
        return;
    }

    cloudSyncState.baseUrl = String(config.baseUrl || '').replace(/\/$/, '');
    cloudSyncState.anonKey = String(config.anonKey || '');
    cloudSyncState.tableName = String(config.tableName || cloudSyncState.tableName);
    cloudSyncState.workspaceId = String(config.workspaceId || cloudSyncState.workspaceId);
    cloudSyncState.requireAuth = Boolean(config.requireAuth);
    cloudSyncState.useWorkspaceColumn = Boolean(config.useWorkspaceColumn);
    cloudSyncState.supabaseSyncEnabled = isSupabaseSyncEnabled();

    if (!cloudSyncState.baseUrl || !cloudSyncState.anonKey) {
        setSyncIndicator('error', 'Access service not configured');
        return;
    }

    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken && !(cloudSyncState.identityOnlyMode && cloudSyncState.currentUserRole)) {
        setSyncIndicator('error', 'Sign in with your email to continue');
        return;
    }

    try {
        setSyncIndicator('syncing', 'Loading from Supabase...');
        console.log('[DDS] Loading from Supabase');

        const keys = [
            'weeklyDDSGeneralState',
            'weeklyDDSTriggersDateState',
            'weeklyDDSTriggersState',
            'weeklyDDSTriggerDetailsState',
            'weeklyDDSFollowUpsState',
            'weeklyDDSHistoryArchive',
            WORKSPACE_CONFIG_STORAGE_KEY
        ];

        await Promise.all(keys.map(async (key) => {
            const cachedFallback = getRuntimeState(key) ?? loadState(key, null);
            const fallback = cachedFallback === null ? undefined : cachedFallback;
            const value = await window.DDSStorageSync.loadFromSupabase({
                key,
                fallback,
                storageKey: key,
                config,
                workspaceId: cloudSyncState.workspaceId,
                accessToken: cloudSyncState.accessToken,
                useWorkspaceColumn: cloudSyncState.useWorkspaceColumn,
                tableName: cloudSyncState.tableName,
                localTimestamp: getLocalFreshnessMeta(key)?.updatedAt || null,
                onCacheUpdate: (payload, row) => {
                    setRuntimeState(key, payload);
                    updateLocalFreshnessMeta(key, {
                        version: toFiniteNumber(row?.version),
                        updatedAt: String(row?.last_updated || row?.updated_at || new Date().toISOString()),
                        source: 'cloud'
                    });
                },
                onOffline: () => {
                    setSyncIndicator('warning', 'Offline Mode - displaying cached data');
                }
            });

            console.log('[DDS DIAG] loadFromSupabase returned', { key, value });

            if (value !== undefined) {
                setRuntimeState(key, value);
            }
        }));

        logGeneralStateDiagnostic('weeklyDDSGeneralState after bootstrapFromCloud', {
            state: getRuntimeState('weeklyDDSGeneralState') ?? loadState('weeklyDDSGeneralState', null)
        });

        setSyncIndicator('synced', 'Cloud data loaded');
    } catch (error) {
        setSyncIndicator('error', cloudSyncState.requireAuth
            ? 'Access denied. Check your email role.'
            : 'Service unavailable. Using local data only.');
    }
}

function renderAllSections() {
    if (hasWritePermission()) {
        saveTriggerState(getTriggerState());
    }
    renderGeneralNotes();
    renderTriggerGrid();
    renderTriggerDetails();
    renderFollowUps();
    if (hasWritePermission()) {
        archiveCurrentSnapshot(false);
    }
}

function setFollowupAddButtonDisabled(disabled) {
    const followupAddButton = document.querySelector('.add-btn[data-target="followups"]');
    if (followupAddButton) {
        followupAddButton.disabled = disabled;
    }
}

function getFollowupAddGateUntil() {
    return Number(window.__weeklyDDSFollowupAddGateUntil || 0);
}

function setFollowupAddGate(ms) {
    window.__weeklyDDSFollowupAddGateUntil = Date.now() + ms;
}

function unlockFollowupAddAfterRender() {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const remaining = getFollowupAddGateUntil() - Date.now();
            if (remaining > 0) {
                setTimeout(unlockFollowupAddAfterRender, remaining);
                return;
            }

            followupAddLocked = false;
            window.__weeklyDDSFollowupAddGateUntil = 0;
            setFollowupAddButtonDisabled(false);
        });
    });
}

function startOfWeek(date) {
    const current = new Date(date);
    const day = current.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    current.setDate(current.getDate() + diff);
    current.setHours(0, 0, 0, 0);
    return current;
}

function addDays(date, days) {
    const current = new Date(date);
    current.setDate(current.getDate() + days);
    return current;
}

function formatDate(date) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

function formatWorkday(date) {
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day}`;
}

function parseManualDate(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    parsed.setHours(0, 0, 0, 0);
    return parsed;
}

function getWeekNumber(date) {
    const temp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = temp.getUTCDay() || 7;
    temp.setUTCDate(temp.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
    return Math.ceil((((temp - yearStart) / 86400000) + 1) / 7);
}

function getWeekDisplayRange(date) {
    const current = new Date(date);
    const day = current.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const monday = new Date(current);
    monday.setDate(current.getDate() + diff);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    return `Week ${getWeekNumber(monday)}: ${formatWorkday(monday)} - ${formatWorkday(friday)}`;
}

function getWeekKey(date) {
    const weekStart = startOfWeek(date);
    return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
}

function getWeekRange(date) {
    const weekStart = startOfWeek(date);
    const weekEnd = addDays(weekStart, 4);
    return `${formatWorkday(weekStart)} - ${formatWorkday(weekEnd)}`;
}

function getDateStateForCurrentWeek() {
    const currentWeekKey = getWeekKey(new Date());
    const workspaceConfig = getWorkspaceConfig();
    const defaultStartDate = String(workspaceConfig.defaultTriggerStartDate || '').trim() || startOfWeek(new Date()).toISOString().slice(0, 10);
    const rawState = loadState('weeklyDDSTriggersDateState', { startDate: '', weekKey: '' });
    const state = {
        startDate: rawState.startDate || defaultStartDate,
        weekKey: rawState.weekKey || currentWeekKey
    };

    if (state.weekKey !== currentWeekKey) {
        // Keep the trigger timeline anchored to the manually selected start date.
        // Only initialize with current week start when no manual date has been set.
        if (!state.startDate) {
            state.startDate = defaultStartDate;
        }

        state.weekKey = currentWeekKey;
        saveState('weeklyDDSTriggersDateState', state);
    }

    return state;
}

function loadState(key, fallback) {
    const runtimeValue = getRuntimeState(key);
    if (runtimeValue !== null) {
        if (String(key) === 'weeklyDDSGeneralState') {
            ensureRuntimeDiagStore().lastGeneralStateSource = 'runtime memory (state)';
        }
        return runtimeValue;
    }

    try {
        const parsed = window.DDSStorageSync
            ? window.DDSStorageSync.readLocalCache(key, fallback)
            : (() => {
                const value = localStorage.getItem(key);
                return value ? JSON.parse(value) : fallback;
            })();
        if (String(key) === 'weeklyDDSGeneralState') {
            ensureRuntimeDiagStore().lastGeneralStateSource = 'localStorage';
            if (!ensureRuntimeDiagStore().firstTest999Appearance && JSON.stringify(parsed).includes('TEST999')) {
                ensureRuntimeDiagStore().firstTest999Appearance = {
                    tag: 'loadState',
                    location: 'localStorage',
                    value: JSON.parse(JSON.stringify(parsed))
                };
            }
        }
        if (parsed !== undefined) {
            setRuntimeState(key, parsed);
        }
        return parsed;
    } catch (error) {
        if (String(key) === 'weeklyDDSGeneralState') {
            ensureRuntimeDiagStore().lastGeneralStateSource = 'fallback defaults';
        }
        return fallback;
    }
}

function buildReminderConfigKey(label, index) {
    const base = String(label || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return base || `reminder-${index + 1}`;
}

function normalizeWorkspaceConfig(config = {}) {
    const reminderSource = Array.isArray(config.reminderItems) && config.reminderItems.length
        ? config.reminderItems
        : DEFAULT_REMINDER_ITEMS;
    const triggerSource = Array.isArray(config.triggerRows) && config.triggerRows.length
        ? config.triggerRows
        : DEFAULT_TRIGGER_ROWS;

    const reminderItems = reminderSource
        .map((item, index) => {
            if (typeof item === 'string') {
                const label = item.trim();
                return label ? { key: buildReminderConfigKey(label, index), label } : null;
            }

            const label = String(item?.label || '').trim();
            if (!label) return null;
            const key = String(item?.key || '').trim() || buildReminderConfigKey(label, index);
            return { key, label };
        })
        .filter(Boolean);

    const triggerRows = triggerSource
        .map((item) => String(item || '').trim())
        .filter(Boolean);

    return {
        reminderItems: reminderItems.length ? reminderItems : DEFAULT_REMINDER_ITEMS.map((item) => ({ ...item })),
        triggerRows: triggerRows.length ? triggerRows : [...DEFAULT_TRIGGER_ROWS],
        defaultTriggerStartDate: String(config.defaultTriggerStartDate || '').trim()
    };
}

function getWorkspaceConfig() {
    return normalizeWorkspaceConfig(loadState(WORKSPACE_CONFIG_STORAGE_KEY, {}));
}

function getReminderItems() {
    return getWorkspaceConfig().reminderItems;
}

function getTriggerRows() {
    return getWorkspaceConfig().triggerRows;
}

function saveState(key, value) {
    if (key === 'weeklyDDSTriggersDateState' && !canManageWorkspaceContent()) {
        return;
    }

    setRuntimeState(key, value);
    if (!window.DDSStorageSync) {
        return;
    }

    window.DDSStorageSync.saveToSupabase({
        key,
        value,
        storageKey: key,
        config: window.DDS_CLOUD_CONFIG || {},
        workspaceId: cloudSyncState.workspaceId,
        accessToken: cloudSyncState.accessToken,
        useWorkspaceColumn: cloudSyncState.useWorkspaceColumn,
        tableName: cloudSyncState.tableName,
        localTimestamp: getLocalFreshnessMeta(key)?.updatedAt || null,
        onCacheUpdate: (payload, row) => {
            setRuntimeState(key, payload);
            updateLocalFreshnessMeta(key, {
                updatedAt: String(row?.last_updated || row?.updated_at || new Date().toISOString()),
                source: 'cloud'
            });
        },
        onOffline: () => {
            setSyncIndicator('warning', 'Offline Mode - displaying cached data');
        }
    }).then((ok) => {
        if (ok) {
            updateLocalFreshnessMeta(key, { source: 'cloud' });
        }
    });
}

function recordRemovalToHistory(kind, item) {
    const currentWeekKey = getWeekKey(new Date());
    const currentWeekLabel = getWeekRange(new Date());
    const archive = loadState('weeklyDDSHistoryArchive', []);
    const existingIndex = archive.findIndex((entry) => entry && entry.weekKey === currentWeekKey);

    const removalEntry = {
        kind,
        item: { ...item },
        removedAt: new Date().toISOString()
    };

    const snapshot = existingIndex >= 0
        ? archive[existingIndex]
        : {
            weekKey: currentWeekKey,
            weekLabel: currentWeekLabel,
            capturedAt: new Date().toISOString(),
            generalNotes: {},
            triggerLabels: [],
            triggerValues: [],
            triggerDetails: [],
            followUps: [],
            removedItems: []
        };

    if (!Array.isArray(snapshot.removedItems)) {
        snapshot.removedItems = [];
    }

    snapshot.removedItems.unshift(removalEntry);
    snapshot.removedItems = snapshot.removedItems.slice(0, 100);
    snapshot.weekKey = currentWeekKey;
    snapshot.weekLabel = currentWeekLabel;
    snapshot.capturedAt = snapshot.capturedAt || new Date().toISOString();

    if (existingIndex >= 0) {
        archive[existingIndex] = snapshot;
    } else {
        archive.unshift(snapshot);
    }

    const limitedArchive = archive.filter((entry) => entry && entry.weekKey).slice(0, 52);
    saveState('weeklyDDSHistoryArchive', limitedArchive);
    return limitedArchive;
}

function getDefaultTriggerState() {
    const triggerRows = getTriggerRows();
    return {
        labels: [...triggerRows],
        values: Array.from({ length: triggerRows.length }, () => []),
        orders: triggerRows.map((_, index) => index + 1)
    };
}

function normalizeTriggerState(state = {}) {
    const fallback = getDefaultTriggerState();
    const hasStoredLabels = Array.isArray(state.labels) && state.labels.some((label) => String(label || '').trim());
    const labels = hasStoredLabels
        ? state.labels.filter((label) => String(label || '').trim())
        : fallback.labels;
    const values = Array.isArray(state.values) ? state.values : [];
    const orders = Array.isArray(state.orders) && state.orders.length === labels.length
        ? state.orders
        : labels.map((_, index) => index + 1);

    const rows = labels.map((label, index) => ({
        label,
        order: Number(orders[index]) || index + 1,
        sourceIndex: index,
        values: Array.isArray(values[index]) ? values[index] : []
    }));

    rows.sort((a, b) => a.order - b.order);
    rows.forEach((row, index) => {
        row.order = index + 1;
    });

    return {
        labels: rows.map((row) => row.label),
        values: rows.map((row) => row.values),
        orders: rows.map((row) => row.order)
    };
}

function getTriggerState() {
    const state = loadState('weeklyDDSTriggersState', getDefaultTriggerState());
    return normalizeTriggerState(state);
}

function saveTriggerState(state) {
    const normalizedState = normalizeTriggerState(state);
    saveState('weeklyDDSTriggersState', normalizedState);
}

function buildCurrentSnapshot() {
    const generalState = loadState('weeklyDDSGeneralState', { weekKey: '', notes: {} });
    const triggerState = getTriggerState();
    const triggerDetailsState = normalizeTriggerDetailsStateForCurrentWeek();
    const followUpsState = normalizeFollowUpsStateForCurrentWeek();

    return {
        weekKey: getWeekKey(new Date()),
        weekLabel: getWeekRange(new Date()),
        capturedAt: new Date().toISOString(),
        generalNotes: generalState.notes || {},
        triggerLabels: Array.isArray(triggerState.labels) ? [...triggerState.labels] : [],
        triggerValues: Array.isArray(triggerState.values)
            ? triggerState.values.map((row) => (Array.isArray(row) ? [...row] : []))
            : [],
        triggerDetails: Array.isArray(triggerDetailsState.items)
            ? triggerDetailsState.items.map((item) => ({ ...item }))
            : [],
        followUps: Array.isArray(followUpsState.items)
            ? followUpsState.items.map((item) => ({ ...item }))
            : []
    };
}

function archiveCurrentSnapshot(force = false) {
    const archive = loadState('weeklyDDSHistoryArchive', []);
    const currentWeekKey = getWeekKey(new Date());
    const existingIndex = archive.findIndex((entry) => entry.weekKey === currentWeekKey);
    const snapshot = buildCurrentSnapshot();

    if (existingIndex >= 0) {
        const existing = archive[existingIndex] || {};
        if (Array.isArray(existing.removedItems) && existing.removedItems.length) {
            snapshot.removedItems = [...existing.removedItems];
        }
        archive[existingIndex] = snapshot;
    } else {
        archive.unshift(snapshot);
    }

    const limitedArchive = archive.filter((entry) => entry && entry.weekKey).slice(0, 52);
    saveState('weeklyDDSHistoryArchive', limitedArchive);
    return limitedArchive;
}

function getGeneralState() {
    const currentWeekKey = getWeekKey(new Date());
    const state = loadState('weeklyDDSGeneralState', { weekKey: '', notes: {} });
    console.log('[DDS DIAG] getGeneralState()', { currentWeekKey, stateWeekKey: state.weekKey, notes: state.notes });

    logGeneralStateDiagnostic('getGeneralState before week check', {
        currentWeekKey,
        stateWeekKey: state.weekKey,
        stateNotes: state.notes
    });

    if (state.weekKey !== currentWeekKey) {
        const history = loadState('weeklyDDSGeneralHistory', []);
        if (state.weekKey && Object.values(state.notes).some(Boolean)) {
            history.unshift({
                weekLabel: state.weekKey,
                notes: { ...state.notes }
            });
            saveState('weeklyDDSGeneralHistory', history.slice(0, 6));
        }

        archiveCurrentSnapshot(true);
        state.weekKey = currentWeekKey;
        logGeneralStateDiagnostic('state.notes preserved during week rollover', {
            currentWeekKey,
            stateWeekKey: state.weekKey,
            stateNotes: state.notes
        });
        saveState('weeklyDDSGeneralState', state);
    }

    return state;
}

function renderGeneralNotes() {
    const state = getGeneralState();
    const reminderList = document.getElementById('reminder-list');
    const notesInput = document.getElementById('general-notes-input');

    logGeneralStateDiagnostic('weeklyDDSGeneralState before renderGeneralNotes', {
        currentWeekKey: getWeekKey(new Date()),
        stateWeekKey: state.weekKey,
        stateNotes: state.notes
    });

    reminderList.innerHTML = getReminderItems().map((item) => `<li>${item.label}</li>`).join('');

    const noteValue = typeof state.notes === 'string'
        ? state.notes
        : state.notes?.['combined-notes'] || Object.values(state.notes || {}).filter(Boolean).join('\n\n');

    logGeneralStateDiagnostic('noteValue before notesInput.value assignment', {
        currentWeekKey: getWeekKey(new Date()),
        stateWeekKey: state.weekKey,
        noteValue,
        stateNotes: state.notes
    });

    console.log('[DDS DIAG] renderGeneralNotes call stack =', new Error('renderGeneralNotes stack').stack);
    console.log('[DDS DIAG] renderGeneralNotes source candidate =', JSON.stringify({
        fromSupabase: ensureRuntimeDiagStore().supabaseGeneralRecord || null,
        fromLocalStorage: window.DDSStorageSync ? window.DDSStorageSync.readLocalCache('weeklyDDSGeneralState', null) : null,
        fromSessionStorage: (() => {
            try {
                const raw = sessionStorage.getItem('weeklyDDSGeneralState');
                return raw ? JSON.parse(raw) : null;
            } catch (_error) {
                return null;
            }
        })(),
        fromRuntime: getRuntimeState('weeklyDDSGeneralState'),
        fromFallbackDefaults: { weekKey: '', notes: {} },
        selectedForRender: state,
        noteValue
    }));

    notesInput.value = noteValue || '';
    if (String(noteValue || '').includes('TEST999') && !ensureRuntimeDiagStore().firstTest999Appearance) {
        ensureRuntimeDiagStore().firstTest999Appearance = {
            tag: 'renderGeneralNotes',
            location: 'noteValue before notesInput.value',
            value: noteValue
        };
    }
    captureRuntimeSnapshot('after renderGeneralNotes assignment');

    notesInput.oninput = (event) => {
        state.notes = { 'combined-notes': event.target.value };
        logGeneralStateDiagnostic('state.notes mutation from general notes input', {
            currentWeekKey: getWeekKey(new Date()),
            stateWeekKey: state.weekKey,
            stateNotes: state.notes
        });
        saveState('weeklyDDSGeneralState', state);
    };
}

function getQuarterStartDate(date) {
    const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3;
    const start = new Date(date.getFullYear(), quarterStartMonth, 1);
    const day = start.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    start.setDate(start.getDate() + diff);
    return start;
}

function buildWeekHeaders() {
    const state = getDateStateForCurrentWeek();
    const baseDate = state.startDate ? parseManualDate(state.startDate) : startOfWeek(new Date());
    if (!baseDate) {
        return Array.from({ length: 13 }, (_, index) => addDays(startOfWeek(new Date()), index * 7));
    }
    return Array.from({ length: 13 }, (_, index) => addDays(baseDate, index * 7));
}

function normalizeTriggerDetailsStateForCurrentWeek() {
    const currentWeekKey = getWeekKey(new Date());
    const state = loadState('weeklyDDSTriggerDetailsState', { weekKey: currentWeekKey, items: [] });

    if (!state.weekKey) {
        state.weekKey = currentWeekKey;
    }
    if (!Array.isArray(state.items)) {
        state.items = [];
    }

    if (state.weekKey !== currentWeekKey) {
        const closedItems = state.items.filter((item) => String(item.status || '').trim().toLowerCase() === 'close');
        closedItems.forEach((item) => {
            recordRemovalToHistory('trigger-detail', {
                triggerType: item.triggerType,
                triggerDetail: item.triggerDetail,
                nextStep: item.nextStep,
                owner: item.owner,
                dueDate: item.dueDate,
                status: item.status
            });
        });

        state.items = state.items.filter((item) => String(item.status || '').trim().toLowerCase() !== 'close');
        state.weekKey = currentWeekKey;
        saveState('weeklyDDSTriggerDetailsState', state);
    }

    return state;
}

const triggerTypeOrder = ['Quality Issue', 'Change Management', 'SOP', 'Others'];

function getTriggerTypeSortWeight(triggerType) {
    const normalized = String(triggerType || '').trim().toLowerCase();
    const index = triggerTypeOrder.findIndex((item) => item.toLowerCase() === normalized);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function isTriggerDetailRowReadyForSort(item) {
    const row = item || {};
    return Boolean(
        String(row.triggerType || '').trim()
        && String(row.triggerDetail || '').trim()
        && String(row.dueDate || '').trim()
    );
}

function compareTriggerDetailEntries(left, right) {
    const leftItem = left.item || {};
    const rightItem = right.item || {};

    const leftReady = isTriggerDetailRowReadyForSort(leftItem);
    const rightReady = isTriggerDetailRowReadyForSort(rightItem);

    if (leftReady !== rightReady) {
        return leftReady ? -1 : 1;
    }

    if (!leftReady && !rightReady) {
        return left.index - right.index;
    }

    const typeDelta = getTriggerTypeSortWeight(leftItem.triggerType) - getTriggerTypeSortWeight(rightItem.triggerType);
    if (typeDelta !== 0) return typeDelta;

    const dueDateDelta = getDueDateSortWeight(leftItem.dueDate) - getDueDateSortWeight(rightItem.dueDate);
    if (dueDateDelta !== 0) return dueDateDelta;

    return left.index - right.index;
}

function normalizeFollowUpsStateForCurrentWeek() {
    const currentWeekKey = getWeekKey(new Date());
    const state = loadState('weeklyDDSFollowUpsState', { weekKey: currentWeekKey, items: [] });

    if (!state.weekKey) {
        state.weekKey = currentWeekKey;
    }
    if (!Array.isArray(state.items)) {
        state.items = [];
    }

    const beforeCleanupCount = state.items.length;
    state.items = state.items.filter((item) => {
        const bucket = String(item?.bucket || '').trim();
        const taskName = String(item?.taskName || '').trim();
        const comments = String(item?.comments || '').trim();
        const assignTo = String(item?.assignTo || '').trim();
        const dueDate = String(item?.dueDate || '').trim();
        const status = String(item?.status || 'Open').trim().toLowerCase();

        const isPlaceholderEmptyRow = !assignTo && !taskName && !comments && !dueDate && status === 'open' && bucket === 'DDS FU';
        return !isPlaceholderEmptyRow;
    });

    if (state.weekKey !== currentWeekKey) {
        const closedItems = state.items.filter((item) => String(item.status || '').trim().toLowerCase() === 'close');
        closedItems.forEach((item) => {
            recordRemovalToHistory('follow-up', {
                bucket: item.bucket,
                taskName: item.taskName,
                assignTo: item.assignTo,
                dueDate: item.dueDate,
                status: item.status,
                comments: item.comments
            });
        });

        state.items = state.items.filter((item) => String(item.status || '').trim().toLowerCase() !== 'close');
        state.weekKey = currentWeekKey;
        saveState('weeklyDDSFollowUpsState', state);
        return state;
    }

    if (state.items.length !== beforeCleanupCount) {
        saveState('weeklyDDSFollowUpsState', state);
    }

    return state;
}

function getBucketSortWeight(bucket) {
    const index = followupBucketOrder.indexOf(String(bucket || '').trim());
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function getDueDateSortWeight(dueDate) {
    if (!dueDate) return Number.MAX_SAFE_INTEGER;
    const parsed = Date.parse(String(dueDate));
    return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function isFollowUpRowReadyForSort(item) {
    const row = item || {};
    return Boolean(
        String(row.bucket || '').trim()
        && String(row.taskName || '').trim()
        && String(row.assignTo || '').trim()
        && String(row.dueDate || '').trim()
    );
}

function compareFollowUpEntries(left, right) {
    const leftItem = left.item || {};
    const rightItem = right.item || {};

    const leftReady = isFollowUpRowReadyForSort(leftItem);
    const rightReady = isFollowUpRowReadyForSort(rightItem);

    if (leftReady !== rightReady) {
        return leftReady ? -1 : 1;
    }

    if (!leftReady && !rightReady) {
        return left.index - right.index;
    }

    const bucketDelta = getBucketSortWeight(leftItem.bucket) - getBucketSortWeight(rightItem.bucket);
    if (bucketDelta !== 0) return bucketDelta;

    const dueDateDelta = getDueDateSortWeight(leftItem.dueDate) - getDueDateSortWeight(rightItem.dueDate);
    if (dueDateDelta !== 0) return dueDateDelta;

    return left.index - right.index;
}

function applyStatusFieldStyle(field) {
    if (!field || field.tagName !== 'SELECT' || field.dataset.field !== 'status') return;

    field.classList.remove('status-in-progress', 'status-delay', 'status-close');

    const normalized = String(field.value || '').trim().toLowerCase();
    if (normalized === 'in progress') {
        field.classList.add('status-in-progress');
    } else if (normalized === 'delay') {
        field.classList.add('status-delay');
    } else if (normalized === 'close') {
        field.classList.add('status-close');
    }
}

function applyTriggerCellStyle(input) {
    input.classList.remove('is-zero', 'is-positive', 'is-future');

    if (input.dataset.future === 'true') {
        input.classList.add('is-future');
        return;
    }

    const value = input.value.trim();
    if (!value) {
        return;
    }

    const numeric = Number(value);
    if (numeric === 0) {
        input.classList.add('is-zero');
    } else if (numeric > 0) {
        input.classList.add('is-positive');
    }
}

function renderTriggerGrid() {
    const dateState = getDateStateForCurrentWeek();
    const weekDates = buildWeekHeaders();
    const state = getTriggerState();
    const labels = Array.isArray(state.labels) && state.labels.length ? state.labels : [...getTriggerRows()];
    const values = Array.isArray(state.values) ? state.values : [];
    const orders = Array.isArray(state.orders) ? state.orders : labels.map((_, index) => index + 1);
    const normalizedValues = labels.map((_, rowIndex) => {
        const existingRow = Array.isArray(values[rowIndex]) ? values[rowIndex] : [];
        return Array.from({ length: weekDates.length }, (_, columnIndex) => existingRow[columnIndex] ?? '');
    });
    const rowEntries = labels.map((label, rowIndex) => ({
        label,
        order: Number(orders[rowIndex]) || rowIndex + 1,
        sourceIndex: rowIndex,
        values: normalizedValues[rowIndex] || []
    }));

    const head = document.getElementById('trigger-head');
    const body = document.getElementById('trigger-body');
    const startDateInput = document.getElementById('trigger-start-date');
    const addTriggerButton = document.getElementById('add-trigger-row-btn');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const canManageTrigger = canManageWorkspaceContent();
    const canEditTriggerValues = hasWritePermission();

    if (startDateInput) {
        startDateInput.value = dateState.startDate || '';
        startDateInput.disabled = !canManageTrigger;
        startDateInput.onchange = (event) => {
            if (!canManageWorkspaceContent()) {
                event.target.value = dateState.startDate || '';
                return;
            }
            dateState.startDate = event.target.value;
            saveState('weeklyDDSTriggersDateState', dateState);
            renderTriggerGrid();
        };
    }

    if (addTriggerButton) {
        addTriggerButton.disabled = !canManageTrigger;
    }

    head.innerHTML = `
        <tr>
            <th>Trigger</th>
            ${weekDates.map((date) => `<th><span class="trigger-week-number">W${getWeekNumber(date)}</span><span class="trigger-week-date">${formatWorkday(date)}</span></th>`).join('')}
        </tr>
    `;

    body.innerHTML = '';

    rowEntries.forEach((rowEntry) => {
        const row = document.createElement('tr');
        const labelCell = document.createElement('td');

        if (canManageTrigger) {
            const orderBadge = document.createElement('span');
            orderBadge.className = 'trigger-order-badge';
            orderBadge.textContent = `${rowEntry.order}.`;
            labelCell.appendChild(orderBadge);

            const labelInput = document.createElement('input');
            labelInput.type = 'text';
            labelInput.className = 'trigger-label-input';
            labelInput.value = rowEntry.label;
            labelInput.addEventListener('input', () => {
                const triggerData = getTriggerState();
                triggerData.labels[rowEntry.sourceIndex] = labelInput.value;
                saveTriggerState(triggerData);
            });
            labelCell.appendChild(labelInput);

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'trigger-row-delete';
            deleteButton.textContent = '×';
            deleteButton.addEventListener('click', () => {
                const triggerData = getTriggerState();
                triggerData.labels.splice(rowEntry.sourceIndex, 1);
                triggerData.values.splice(rowEntry.sourceIndex, 1);
                triggerData.orders = triggerData.labels.map((_, index) => index + 1);
                saveTriggerState(triggerData);
                renderTriggerGrid();
            });
            labelCell.appendChild(deleteButton);
        } else {
            const orderBadge = document.createElement('span');
            orderBadge.className = 'trigger-order-badge';
            orderBadge.textContent = `${rowEntry.order}.`;
            labelCell.appendChild(orderBadge);

            const labelText = document.createElement('span');
            labelText.textContent = rowEntry.label;
            labelCell.appendChild(labelText);
        }

        row.appendChild(labelCell);

        weekDates.forEach((date, columnIndex) => {
            const cell = document.createElement('td');
            const input = document.createElement('input');
            const columnDate = new Date(date);
            columnDate.setHours(0, 0, 0, 0);
            input.type = 'number';
            input.min = '0';
            input.step = '1';
            input.inputMode = 'numeric';
            input.pattern = '[0-9]*';
            input.value = rowEntry.values[columnIndex] ?? '0';
            input.disabled = !canEditTriggerValues;
            input.dataset.future = String(columnDate.getTime() > today.getTime());
            input.dataset.rowIndex = String(rowEntry.sourceIndex);
            input.dataset.columnIndex = String(columnIndex);
            input.addEventListener('input', (event) => {
                const rawValue = event.target.value;
                const value = rawValue === '' ? '0' : String(Math.max(0, Number(rawValue) || 0));
                event.target.value = value;
                const triggerData = getTriggerState();
                if (!Array.isArray(triggerData.values[rowEntry.sourceIndex])) {
                    triggerData.values[rowEntry.sourceIndex] = [];
                }
                triggerData.values[rowEntry.sourceIndex][columnIndex] = value;
                saveTriggerState(triggerData);
                applyTriggerCellStyle(event.target);
            });
            applyTriggerCellStyle(input);
            cell.appendChild(input);
            row.appendChild(cell);
        });

        body.appendChild(row);
    });
}

function renderTriggerDetails() {
    const state = normalizeTriggerDetailsStateForCurrentWeek();
    const body = document.getElementById('details-body');
    const archive = document.getElementById('details-archive');

    const allItems = state.items;
    const sortedEntries = allItems
        .map((item, index) => ({ item, index }))
        .sort(compareTriggerDetailEntries);
    const archivedItems = state.items.filter((item) => item.status === 'Close');

    body.innerHTML = '';

    if (!allItems.length) {
        body.innerHTML = '<tr><td colspan="6">No trigger details yet. Add a new row to begin.</td></tr>';
    } else {
        sortedEntries.forEach((entry) => {
            const item = entry.item;
            const itemIndex = entry.index;
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <select class="detail-field" data-field="triggerType" data-index="${itemIndex}">
                        <option value=""></option>
                        <option value="Quality Issue">Quality Issue</option>
                        <option value="Change Management">Change Management</option>
                        <option value="SOP">SOP</option>
                        <option value="Others">Others</option>
                    </select>
                </td>
                <td><textarea rows="1" class="detail-field detail-textarea" data-field="triggerDetail" data-index="${itemIndex}"></textarea></td>
                <td><textarea rows="1" class="detail-field detail-textarea" data-field="nextStep" data-index="${itemIndex}"></textarea></td>
                <td><input type="text" class="detail-field" data-field="owner" data-index="${itemIndex}"></td>
                <td><input type="date" class="detail-field" data-field="dueDate" data-index="${itemIndex}"></td>
                <td>
                    <select class="detail-field" data-field="status" data-index="${itemIndex}">
                        <option value="Open">Open</option>
                        <option value="In Progress">In Progress</option>
                        <option value="Delay">Delay</option>
                        <option value="Close">Close</option>
                    </select>
                </td>
            `;

            row.querySelectorAll('.detail-field').forEach((field) => {
                field.value = item[field.dataset.field] || '';
                applyStatusFieldStyle(field);
                field.addEventListener('input', () => {
                    const target = state.items[itemIndex];
                    if (!target) return;
                    target[field.dataset.field] = field.value;
                    saveState('weeklyDDSTriggerDetailsState', state);
                    applyStatusFieldStyle(field);
                    if (field.tagName === 'TEXTAREA') {
                        autoResizeTextArea(field);
                    }
                });
                field.addEventListener('change', () => {
                    const target = state.items[itemIndex];
                    if (!target) return;
                    target[field.dataset.field] = field.value;
                    saveState('weeklyDDSTriggerDetailsState', state);
                    applyStatusFieldStyle(field);
                    if (field.tagName === 'TEXTAREA') {
                        autoResizeTextArea(field);
                    }
                    if (field.dataset.field === 'status'
                        || field.dataset.field === 'triggerType'
                        || field.dataset.field === 'dueDate') {
                        renderTriggerDetails();
                    }
                });
            });

            body.appendChild(row);
        });

        // Resize textareas after rows are mounted so scrollHeight reflects real wrapping.
        body.querySelectorAll('.detail-textarea').forEach((textarea) => {
            autoResizeTextArea(textarea);
        });
    }

    if (archive) {
        archive.innerHTML = '';

        if (archivedItems.length) {
            archivedItems.forEach((item) => {
                const li = document.createElement('li');
                const triggerDetail = item.triggerDetail || 'Archived item';
                const owner = item.owner || 'Unassigned';
                li.textContent = `${triggerDetail} · ${owner}`;
                archive.appendChild(li);
            });
        } else {
            const li = document.createElement('li');
            li.textContent = 'No archived trigger details yet.';
            archive.appendChild(li);
        }
    }
}

function renderFollowUps() {
    const state = normalizeFollowUpsStateForCurrentWeek();
    const body = document.getElementById('followup-body');
    const reminderPanel = document.getElementById('reminder-panel');

    const allItems = state.items;
    const sortedEntries = allItems
        .map((item, index) => ({ item, index }))
        .sort(compareFollowUpEntries);
    const reminderTasks = allItems.filter((item) => item.status !== 'Close' && item.assignTo && item.dueDate);

    body.innerHTML = '';

    if (!allItems.length) {
        body.innerHTML = '<tr><td colspan="6">No follow-up tasks yet. Add a new row to begin.</td></tr>';
    } else {
        sortedEntries.forEach((entry) => {
            const item = entry.item;
            const itemIndex = entry.index;
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <select class="followup-field" data-field="bucket" data-index="${itemIndex}">
                        <option value=""></option>
                        <option value="DDS FU">DDS FU</option>
                        <option value="Command Center">Command Center</option>
                        <option value="Quality System Related">Quality System Related</option>
                        <option value="Others">Others</option>
                    </select>
                </td>
                <td><textarea rows="1" class="followup-field followup-textarea" data-field="taskName" data-index="${itemIndex}"></textarea></td>
                <td><textarea rows="1" class="followup-field followup-textarea" data-field="comments" data-index="${itemIndex}"></textarea></td>
                <td><input type="text" class="followup-field" data-field="assignTo" data-index="${itemIndex}"></td>
                <td><input type="date" class="followup-field" data-field="dueDate" data-index="${itemIndex}"></td>
                <td>
                    <select class="followup-field" data-field="status" data-index="${itemIndex}">
                        <option value="Open">Open</option>
                        <option value="In Progress">In Progress</option>
                        <option value="Delay">Delay</option>
                        <option value="Close">Close</option>
                    </select>
                </td>
            `;

            row.querySelectorAll('.followup-field').forEach((field) => {
                field.value = item[field.dataset.field] || '';
                applyStatusFieldStyle(field);
                field.addEventListener('input', () => {
                    const target = state.items[itemIndex];
                    if (!target) return;
                    target[field.dataset.field] = field.value;
                    saveState('weeklyDDSFollowUpsState', state);
                    applyStatusFieldStyle(field);
                    if (field.tagName === 'TEXTAREA') {
                        autoResizeTextArea(field);
                    }
                });
                field.addEventListener('change', () => {
                    const target = state.items[itemIndex];
                    if (!target) return;
                    target[field.dataset.field] = field.value;
                    saveState('weeklyDDSFollowUpsState', state);
                    applyStatusFieldStyle(field);
                    if (field.tagName === 'TEXTAREA') {
                        autoResizeTextArea(field);
                    }
                    const shouldResort = field.dataset.field === 'status'
                        || field.dataset.field === 'dueDate'
                        || field.dataset.field === 'bucket'
                        || isFollowUpRowReadyForSort(target);
                    if (shouldResort) {
                        renderFollowUps();
                    }
                });
            });

            body.appendChild(row);
        });

        // Resize textareas after rows are mounted so scrollHeight reflects real wrapping.
        body.querySelectorAll('.followup-textarea').forEach((textarea) => {
            autoResizeTextArea(textarea);
        });
    }

    if (reminderPanel) {
        reminderPanel.innerHTML = '';

        if (reminderTasks.length) {
            reminderTasks.forEach((item) => {
                const dueDate = new Date(item.dueDate);
                const diffDays = Math.ceil((dueDate - new Date()) / (1000 * 60 * 60 * 24));
                const card = document.createElement('div');
                card.className = 'reminder-card';
                card.textContent = `${item.taskName || 'Unnamed task'} · assigned to ${item.assignTo || 'TBD'} · due in ${Math.max(diffDays, 0)} day(s)`;
                reminderPanel.appendChild(card);
            });
        } else {
            const card = document.createElement('div');
            card.className = 'reminder-card';
            card.textContent = 'No urgent tasks pending.';
            reminderPanel.appendChild(card);
        }
    }
}

function autoResizeTextArea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const baseHeight = textarea.scrollHeight;
    const needsHeadroom = textarea.classList.contains('followup-textarea') || textarea.classList.contains('detail-textarea');
    const headroomRatio = needsHeadroom ? 1.2 : 1;
    const targetHeight = Math.max(24, Math.ceil(baseHeight * headroomRatio));
    textarea.style.height = `${targetHeight}px`;
}

function addRow(target) {
    if (!hasWritePermission()) return;

    if (target === 'details') {
        const state = normalizeTriggerDetailsStateForCurrentWeek();
        state.items.push({ triggerType: '', triggerDetail: '', nextStep: '', owner: '', dueDate: '', status: 'Open' });
        saveState('weeklyDDSTriggerDetailsState', state);
        renderTriggerDetails();
    }

    if (target === 'followups') {
        if (followupAddLocked || Date.now() < getFollowupAddGateUntil()) return;
        followupAddLocked = true;
        setFollowupAddGate(followupAddCooldownMs);
        setFollowupAddButtonDisabled(true);

        try {
            const state = normalizeFollowUpsStateForCurrentWeek();
            state.items.push({ bucket: '', taskName: '', assignTo: '', dueDate: '', status: 'Open', comments: '' });
            saveState('weeklyDDSFollowUpsState', state);
            renderFollowUps();
        } finally {
            unlockFollowupAddAfterRender();
        }
    }
}

function addTriggerRow() {
    if (!canManageWorkspaceContent()) return;

    const state = getTriggerState();
    const nextOrder = Math.max(0, ...state.orders.map((order) => Number(order) || 0)) + 1;
    state.labels.push('New trigger');
    state.values.push(Array.from({ length: buildWeekHeaders().length }, () => ''));
    state.orders.push(nextOrder);
    saveTriggerState(state);
    renderTriggerGrid();
}

function attachEventHandlers() {
    if (handlersAttached) {
        return;
    }

    document.getElementById('reset-week-btn').addEventListener('click', () => {
        if (!hasWritePermission()) return;
        const state = getGeneralState();
        archiveCurrentSnapshot(true);
        state.notes = {};
        logGeneralStateDiagnostic('state.notes mutation from reset-week button', {
            currentWeekKey: getWeekKey(new Date()),
            stateWeekKey: state.weekKey,
            stateNotes: state.notes
        });
        saveState('weeklyDDSGeneralState', state);
        renderGeneralNotes();
    });

    document.querySelectorAll('.add-btn').forEach((button) => {
        button.addEventListener('click', () => addRow(button.dataset.target));
    });

    const addTriggerButton = document.getElementById('add-trigger-row-btn');
    if (addTriggerButton) {
        addTriggerButton.addEventListener('click', addTriggerRow);
    }

    const syncLocalToCloudButton = document.getElementById('sync-local-to-cloud-btn');
    if (syncLocalToCloudButton) {
        syncLocalToCloudButton.addEventListener('click', () => {
            syncLocalDataToCloud();
        });
    }

    handlersAttached = true;
}

function init() {
    const config = window.DDS_CLOUD_CONFIG || {};
    cloudSyncState.enabled = Boolean(config.enabled);
    cloudSyncState.baseUrl = String(config.baseUrl || '').replace(/\/$/, '');
    cloudSyncState.anonKey = String(config.anonKey || '');
    cloudSyncState.tableName = String(config.tableName || cloudSyncState.tableName);
    cloudSyncState.workspaceId = String(config.workspaceId || cloudSyncState.workspaceId);
    cloudSyncState.requireAuth = Boolean(config.requireAuth);
    cloudSyncState.useWorkspaceColumn = Boolean(config.useWorkspaceColumn);

    return initializeAuth(config).then(async () => {
        document.getElementById('current-week-label').textContent = getWeekDisplayRange(new Date());

        const historyLink = document.getElementById('history-nav-link');
        [historyLink].filter(Boolean).forEach((link) => {
            if (link.dataset.boundAccessGuard) return;
            link.dataset.boundAccessGuard = 'true';
            link.addEventListener('click', (event) => {
                if (link.dataset.locked === 'true') {
                    event.preventDefault();
                    setAuthMessage('Only admin or editor can open DDS history.', true);
                }
            });
        });

        attachEventHandlers();

        await runAuthenticatedBootstrap();

        let teamList = document.getElementById('team-list');
        if (!teamList) {
            teamList = document.createElement('datalist');
            teamList.id = 'team-list';
            teamList.innerHTML = teamMembers.map((member) => `<option value="${member}"></option>`).join('');
            document.body.appendChild(teamList);
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                flushCloudSaves().catch(() => {
                    setSyncIndicator('error', 'Save failed. Local changes are still saved.');
                });
            }
        });

        window.addEventListener('beforeunload', () => {
            if (cloudSyncState.enabled && cloudSyncState.pendingSaves.size) {
                flushCloudSaves().catch(() => {
                    setSyncIndicator('error', 'Save failed. Local changes are still saved.');
                });
            }
        });
    }).catch(() => {
        setSyncIndicator('error', 'Init failed. Refresh to retry.');
    });
}

init();