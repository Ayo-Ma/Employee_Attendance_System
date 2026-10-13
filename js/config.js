/**
 * PDN Attendance — one place to configure the app for every device.
 *
 * sheetsUrl: the Google Apps Script "Web app" URL for your attendance sheet.
 * It looks like  https://script.google.com/macros/s/AKfy.../exec
 * (not the docs.google.com link of the spreadsheet itself).
 *
 * Set it here once and every phone, tablet and kiosk that opens the app is
 * connected automatically. Leave it empty to connect from Settings instead.
 */
window.PDN_CONFIG = {
    orgName: 'PISHON Digital Network',
    shortName: 'PDN',
    sheetsUrl: 'https://script.google.com/macros/s/AKfycbxiEhQ07mZUcM5itBTpTZBgBSoXOP4QQ2Utgwh5Sptw5Rg-ExrVIpBQD5k9dx1bbXb60g/exec',
    // How often an open screen checks the sheet for changes made on other devices.
    syncIntervalSec: 60
};
