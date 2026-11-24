// Aqua reminder timer (Google Apps Script)
// Starts the "Water reminders" GitHub workflow every 10 minutes.
// Setup: Project Settings > Script properties > add GITHUB_TOKEN, then run setUpTimer once.

var REPO = 'bhavesh2799/aqua-water-reminder';

function triggerReminders() {
var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
if (!token) throw new Error('Add GITHUB_TOKEN under Project Settings > Script properties');
var res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/reminders.yml/dispatches', {
method: 'post',
contentType: 'application/json',
headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
payload: JSON.stringify({ ref: 'main' }),
muteHttpExceptions: true
});
if (res.getResponseCode() !== 204) throw new Error('GitHub replied ' + res.getResponseCode() + ': ' + res.getContentText());
console.log('Reminder job started');
}

function setUpTimer() {
ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
ScriptApp.newTrigger('triggerReminders').timeBased().everyMinutes(10).create();
triggerReminders();
console.log('Timer set: every 10 minutes');
}
