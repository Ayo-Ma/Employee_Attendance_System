/**
 * PDN Attendance — settings shared by every device.
 *
 * apiUrl:   the app's server (the Vercel function in /api). Leave as is.
 * sheetUrl: the Google Sheet copy's Apps Script "Web app" URL (ends in /exec).
 *           After each punch the app pings it so the sheet updates straight
 *           away; without it the sheet still updates every minute.
 */
window.PDN_CONFIG = {
    orgName: 'PISHON Digital Network',
    shortName: 'PDN',
    apiUrl: '/api/app',
    sheetUrl: 'https://script.google.com/macros/s/AKfycbxiEhQ07mZUcM5itBTpTZBgBSoXOP4QQ2Utgwh5Sptw5Rg-ExrVIpBQD5k9dx1bbXb60g/exec',
    // How often an open screen checks for changes made on other devices.
    syncIntervalSec: 30
};
