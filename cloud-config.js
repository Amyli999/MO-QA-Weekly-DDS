const ddsHost = String(window.location.hostname || '').toLowerCase();
const ddsProtocol = String(window.location.protocol || '').toLowerCase();
const ddsIsLocalDev = ddsHost === '127.0.0.1' || ddsHost === 'localhost' || ddsProtocol === 'file:';

window.DDS_CLOUD_CONFIG = {
    enabled: !ddsIsLocalDev,
    baseUrl: 'https://tamagreqdngmbsoyrknp.supabase.co',
    anonKey: 'sb_publishable_oT0gc9Vs4xsbxWqaeQFU2Q_eV8C88HY',
    tableName: 'dds_state',
    workspaceId: 'cn-mo-qa-team-a',
    requireAuth: !ddsIsLocalDev,
    useWorkspaceColumn: true
};
