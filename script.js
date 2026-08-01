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
const ADMIN_LOGIN_EMAIL = 'li.he.7@pg.com';
const LOCAL_AUTH_STORAGE_KEY = 'weeklyDDSLocalAuthSession';

const teamMembers = ['Amy', 'Ben', 'Cathy', 'Diana', 'Ethan', 'Frank'];
const followupBucketOrder = ['DDS FU', 'Command Center', 'Quality System Related', 'Others'];
let followupAddLocked = false;
let handlersAttached = false;
const followupAddCooldownMs = 450;

const cloudSyncState = {
    enabled: false,
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
    pendingSaves: new Map(),
    flushTimer: null,
    activeRequests: 0
};

function loadLocalAuthSession() {
    try {
        const raw = localStorage.getItem(LOCAL_AUTH_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return null;

        const email = String(parsed.email || '').trim();
        const role = String(parsed.role || '').trim();
        if (!email || !role) return null;

        return { email, role };
    } catch (_error) {
        return null;
    }
}

function saveLocalAuthSession(email, role) {
    localStorage.setItem(LOCAL_AUTH_STORAGE_KEY, JSON.stringify({
        email: String(email || '').trim(),
        role: String(role || '').trim()
    }));
}

function clearLocalAuthSession() {
    localStorage.removeItem(LOCAL_AUTH_STORAGE_KEY);
}

function setAuthMessage(message, isError = false) {
    const authMessage = document.getElementById('auth-message');
    if (!authMessage) return;
    authMessage.textContent = message || '';
    authMessage.style.color = isError ? '#ffd9d6' : '#ffe9a5';
}

function updateAdminNavAccess() {
    const adminLink = document.getElementById('admin-nav-link');
    if (!adminLink) return;

    const requiresGuard = cloudSyncState.enabled && cloudSyncState.requireAuth;
    const allowAdmin = !requiresGuard || cloudSyncState.currentUserRole === 'admin';

    if (allowAdmin) {
        adminLink.classList.remove('nav-disabled');
        adminLink.dataset.locked = 'false';
        return;
    }

    adminLink.classList.add('nav-disabled');
    adminLink.dataset.locked = 'true';
}

function updateAuthUi() {
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
        if (signedIn) {
            authInput.value = cloudSyncState.currentUserEmail;
        }
    }
}

function hasWritePermission() {
    if (!cloudSyncState.enabled) return cloudSyncState.currentUserRole === 'admin';
    if (!cloudSyncState.requireAuth) return true;
    return cloudSyncState.currentUserRole === 'admin' || cloudSyncState.currentUserRole === 'editor';
}

function canManageWorkspaceContent() {
    if (!cloudSyncState.enabled) return cloudSyncState.currentUserRole === 'admin';
    if (!cloudSyncState.requireAuth) return true;
    return cloudSyncState.currentUserRole === 'admin';
}

function applyPermissionMode() {
    const readOnly = !hasWritePermission();
    const banner = document.getElementById('permission-banner');
    if (banner) {
        banner.textContent = readOnly ? 'Read-only mode: viewer access for this email.' : '';
    }

    document.querySelectorAll('main input, main textarea, main select, main button').forEach((el) => {
        el.disabled = readOnly;
    });
}

function applyAuthSession(session) {
    cloudSyncState.accessToken = session?.access_token || '';
    cloudSyncState.currentUserEmail = session?.user?.email || '';
    cloudSyncState.currentUserRole = '';
    updateAuthUi();
    updateAdminNavAccess();
}

async function fetchCurrentUserRole() {
    if (!cloudSyncState.enabled || !cloudSyncState.accessToken || !cloudSyncState.currentUserEmail) {
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
    if (!cloudSyncState.enabled) {
        const authInput = document.getElementById('auth-email-input');
        const loginButton = document.getElementById('auth-login-btn');
        const logoutButton = document.getElementById('auth-logout-btn');
        const savedSession = loadLocalAuthSession();

        if (savedSession?.email?.toLowerCase() === ADMIN_LOGIN_EMAIL && savedSession.role === 'admin') {
            cloudSyncState.currentUserEmail = savedSession.email;
            cloudSyncState.currentUserRole = 'admin';
        } else {
            cloudSyncState.currentUserEmail = '';
            cloudSyncState.currentUserRole = '';
            clearLocalAuthSession();
        }

        if (loginButton && !loginButton.dataset.boundLocalAuth) {
            loginButton.dataset.boundLocalAuth = 'true';
            loginButton.addEventListener('click', () => {
                const email = String(authInput?.value || '').trim();
                if (!email) {
                    setAuthMessage('Please enter your email first.', true);
                    return;
                }
                if (email.toLowerCase() !== ADMIN_LOGIN_EMAIL) {
                    setAuthMessage('你不是管理员', true);
                    return;
                }

                cloudSyncState.currentUserEmail = email;
                cloudSyncState.currentUserRole = 'admin';
                saveLocalAuthSession(email, 'admin');
                setAuthMessage('Local admin mode enabled.');
                updateAuthUi();
                applyPermissionMode();
                renderAllSections();
            });
        }

        if (logoutButton && !logoutButton.dataset.boundLocalAuth) {
            logoutButton.dataset.boundLocalAuth = 'true';
            logoutButton.addEventListener('click', () => {
                cloudSyncState.currentUserEmail = '';
                cloudSyncState.currentUserRole = '';
                clearLocalAuthSession();
                setAuthMessage('Signed out from local admin mode.');
                updateAuthUi();
                applyPermissionMode();
                renderAllSections();
            });
        }

        setAuthMessage('Local mode: only li.he.7@pg.com can sign in as admin.');
        updateAuthUi();
        updateAdminNavAccess();
        return;
    }

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        setAuthMessage('Supabase library not loaded.', true);
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

    // Support both modern code-based callback and token_hash callback for magic links.
    const callbackUrl = new URL(window.location.href);
    const authCode = callbackUrl.searchParams.get('code');
    const tokenHash = callbackUrl.searchParams.get('token_hash');
    const verifyTypeRaw = callbackUrl.searchParams.get('type');
    const verifyType = verifyTypeRaw === 'email' || verifyTypeRaw === 'signup' || verifyTypeRaw === 'recovery' || verifyTypeRaw === 'invite' || verifyTypeRaw === 'magiclink'
        ? verifyTypeRaw
        : null;

    try {
        if (authCode) {
            const { error } = await cloudSyncState.authClient.auth.exchangeCodeForSession(authCode);
            if (error) throw error;
        } else if (tokenHash && verifyType) {
            const { error } = await cloudSyncState.authClient.auth.verifyOtp({
                token_hash: tokenHash,
                type: verifyType
            });
            if (error) throw error;
        }
    } catch (error) {
        setAuthMessage(`Login failed: ${error.message || error}`, true);
    } finally {
        if (authCode || tokenHash || verifyTypeRaw) {
            callbackUrl.searchParams.delete('code');
            callbackUrl.searchParams.delete('token_hash');
            callbackUrl.searchParams.delete('type');
            callbackUrl.searchParams.delete('next');
            window.history.replaceState({}, '', `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`);
        }
    }

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

            try {
                setAuthMessage('Sending login link...');
                const redirectTo = `${window.location.origin}${window.location.pathname}`;
                const { error } = await cloudSyncState.authClient.auth.signInWithOtp({
                    email,
                    options: { emailRedirectTo: redirectTo }
                });
                if (error) {
                    throw error;
                }
                setAuthMessage('Login link sent. Check your email inbox.');
            } catch (error) {
                setAuthMessage(`Login failed: ${error.message || error}`, true);
            }
        });
    }

    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            if (!cloudSyncState.authClient) return;
            await cloudSyncState.authClient.auth.signOut();
            applyAuthSession(null);
            setAuthMessage('Signed out.');
            if (cloudSyncState.requireAuth) {
                setSyncIndicator('error', 'Login required for cloud sync');
            }
        });
    }

    const { data: sessionData } = await cloudSyncState.authClient.auth.getSession();
    applyAuthSession(sessionData?.session || null);

    cloudSyncState.authClient.auth.onAuthStateChange(async (_event, session) => {
        applyAuthSession(session || null);
        if (cloudSyncState.enabled && (!cloudSyncState.requireAuth || cloudSyncState.accessToken)) {
            try {
                if (cloudSyncState.requireAuth) {
                    await fetchCurrentUserRole();
                    if (!cloudSyncState.currentUserRole) {
                        setSyncIndicator('error', 'No workspace permission for this email');
                        applyPermissionMode();
                        return;
                    }
                }

                await bootstrapFromCloud();
                renderAllSections();
                applyPermissionMode();
            } catch (_error) {
                setSyncIndicator('error', 'Permission check failed.');
            }
        } else if (cloudSyncState.requireAuth) {
            setSyncIndicator('error', 'Login required for cloud sync');
            applyPermissionMode();
        }
    });

    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken) {
        setAuthMessage('Sign in with your approved email to enable cloud data.');
    }

    updateAuthUi();
}

function setSyncIndicator(status, message) {
    const indicator = document.getElementById('sync-status');
    if (!indicator) return;

    indicator.className = `sync-status sync-${status}`;
    indicator.textContent = message;
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
    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken) {
        throw new Error('Login required for cloud sync');
    }

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
    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken) return;
    if (!hasWritePermission()) return;

    cloudSyncState.pendingSaves.set(key, JSON.parse(JSON.stringify(value)));
    if (cloudSyncState.flushTimer) return;

    cloudSyncState.flushTimer = setTimeout(() => {
        flushCloudSaves().catch(() => {
            setSyncIndicator('error', 'Cloud sync failed. Local changes are still saved.');
        });
    }, 700);
}

async function flushCloudSaves() {
    if (!cloudSyncState.enabled || cloudSyncState.pendingSaves.size === 0) {
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

    try {
        await cloudFetch(
            `/rest/v1/${cloudSyncState.tableName}?on_conflict=state_key`,
            {
                method: 'POST',
                headers: buildCloudHeaders(),
                body: JSON.stringify(payloadRows)
            }
        );
    } catch (error) {
        pendingEntries.forEach(([key, value]) => {
            if (!cloudSyncState.pendingSaves.has(key)) {
                cloudSyncState.pendingSaves.set(key, value);
            }
        });
        throw error;
    }
}

async function bootstrapFromCloud() {
    const config = window.DDS_CLOUD_CONFIG || {};
    cloudSyncState.enabled = Boolean(config.enabled);

    if (!cloudSyncState.enabled) {
        setSyncIndicator('local', 'Local-only mode');
        return;
    }

    cloudSyncState.baseUrl = String(config.baseUrl || '').replace(/\/$/, '');
    cloudSyncState.anonKey = String(config.anonKey || '');
    cloudSyncState.tableName = String(config.tableName || cloudSyncState.tableName);
    cloudSyncState.workspaceId = String(config.workspaceId || cloudSyncState.workspaceId);
    cloudSyncState.requireAuth = Boolean(config.requireAuth);
    cloudSyncState.useWorkspaceColumn = Boolean(config.useWorkspaceColumn);

    if (!cloudSyncState.baseUrl || !cloudSyncState.anonKey) {
        setSyncIndicator('local', 'Local-only mode (cloud not configured)');
        return;
    }

    if (cloudSyncState.requireAuth && !cloudSyncState.accessToken) {
        setSyncIndicator('error', 'Login required for cloud sync');
        return;
    }

    try {
        setSyncIndicator('syncing', 'Loading cloud data...');
        const scopedPrefix = `${cloudSyncState.workspaceId}:`;
        const query = cloudSyncState.useWorkspaceColumn
            ? `/rest/v1/${cloudSyncState.tableName}?select=state_key,payload&workspace_id=eq.${encodeURIComponent(cloudSyncState.workspaceId)}`
            : `/rest/v1/${cloudSyncState.tableName}?select=state_key,payload&state_key=like.${encodeURIComponent(`${scopedPrefix}*`)}`;

        const rows = await cloudFetch(
            query,
            {
                method: 'GET',
                headers: buildCloudHeaders()
            }
        );

        if (Array.isArray(rows)) {
            rows.forEach((row) => {
                if (!row || typeof row.state_key !== 'string') return;
                if (!row.state_key.startsWith(scopedPrefix)) return;

                const localKey = row.state_key.slice(scopedPrefix.length);
                localStorage.setItem(localKey, JSON.stringify(row.payload));
            });
        }

        setSyncIndicator('synced', 'Cloud data loaded');
    } catch (error) {
        setSyncIndicator('error', cloudSyncState.requireAuth
            ? 'Cloud denied. Check login email permissions.'
            : 'Cloud unavailable. Using local data only.');
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
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
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
    localStorage.setItem(key, JSON.stringify(value));
    scheduleCloudSave(key, value);
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
        state.notes = {};
        saveState('weeklyDDSGeneralState', state);
    }

    return state;
}

function renderGeneralNotes() {
    const state = getGeneralState();
    const reminderList = document.getElementById('reminder-list');
    const notesInput = document.getElementById('general-notes-input');

    reminderList.innerHTML = getReminderItems().map((item) => `<li>${item.label}</li>`).join('');

    const noteValue = typeof state.notes === 'string'
        ? state.notes
        : state.notes?.['combined-notes'] || Object.values(state.notes || {}).filter(Boolean).join('\n\n');

    notesInput.value = noteValue || '';
    notesInput.oninput = (event) => {
        state.notes = { 'combined-notes': event.target.value };
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
    })).sort((a, b) => a.order - b.order);

    rowEntries.forEach((row, index) => {
        row.order = index + 1;
    });

    const head = document.getElementById('trigger-head');
    const body = document.getElementById('trigger-body');
    const startDateInput = document.getElementById('trigger-start-date');
    const addTriggerButton = document.getElementById('add-trigger-row-btn');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const canManageTrigger = canManageWorkspaceContent();

    if (startDateInput) {
        startDateInput.value = dateState.startDate || '';
        startDateInput.disabled = !canManageTrigger;
        startDateInput.onchange = (event) => {
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
    const archivedItems = state.items.filter((item) => item.status === 'Close');

    body.innerHTML = '';

    if (!allItems.length) {
        body.innerHTML = '<tr><td colspan="5">No trigger details yet. Add a new row to begin.</td></tr>';
    } else {
        allItems.forEach((item) => {
            const itemIndex = state.items.indexOf(item);
            const row = document.createElement('tr');
            row.innerHTML = `
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
                    if (field.dataset.field === 'status') {
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
        state.items.push({ triggerDetail: '', nextStep: '', owner: '', dueDate: '', status: 'Open' });
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
        if (cloudSyncState.requireAuth && cloudSyncState.accessToken) {
            await fetchCurrentUserRole();
            if (!cloudSyncState.currentUserRole) {
                setSyncIndicator('error', 'No workspace permission for this email');
            }
        }

        await bootstrapFromCloud();

        document.getElementById('current-week-label').textContent = getWeekDisplayRange(new Date());

        const adminLink = document.getElementById('admin-nav-link');
        if (adminLink && !adminLink.dataset.boundAccessGuard) {
            adminLink.dataset.boundAccessGuard = 'true';
            adminLink.addEventListener('click', (event) => {
                if (adminLink.dataset.locked === 'true') {
                    event.preventDefault();
                    setAuthMessage('need access', true);
                }
            });
        }

        attachEventHandlers();
        renderAllSections();
        applyPermissionMode();
        updateAdminNavAccess();

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
                    setSyncIndicator('error', 'Cloud sync failed. Local changes are still saved.');
                });
            }
        });

        window.addEventListener('beforeunload', () => {
            if (cloudSyncState.enabled && cloudSyncState.pendingSaves.size) {
                flushCloudSaves().catch(() => {
                    setSyncIndicator('error', 'Cloud sync failed. Local changes are still saved.');
                });
            }
        });
    }).catch(() => {
        setSyncIndicator('error', 'Init failed. Refresh to retry.');
    });
}

init();