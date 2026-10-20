const fs = require('fs');
const path = require('path');
const p = path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
process.stdout.write(j.auth.accessToken || '');
