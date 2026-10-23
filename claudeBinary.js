// The Claude program the SDK runs on Windows lives in node_modules. A claude.exe started from
// there by hand (a sign-in window left open, say) updates itself by renaming its file to
// claude.exe.old.<number>, and can leave nothing in its place; npm then reports "up to date".
// Put it back. (Same idea as home-assistant's src/claude-binary.js.)
const fs = require('fs');
const path = require('path');

// Returns null when the program is there (or was restored), or a message saying what to do.
function ensureClaudeBinary({ root = __dirname, platform = process.platform, arch = process.arch } = {}) {
    if (platform !== 'win32') return null;
    const dir = path.join(root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-win32-${arch}`);
    const exe = path.join(dir, 'claude.exe');
    if (fs.existsSync(exe)) return null;

    let olds = [];
    try { olds = fs.readdirSync(dir).filter(n => /^claude\.exe\.old\.\d+$/.test(n)); } catch (e) { /* package missing */ }
    const newest = olds.sort((a, b) => Number(b.split('.').pop()) - Number(a.split('.').pop()))[0];
    if (newest) {
        try {
            fs.copyFileSync(path.join(dir, newest), exe);
            // The leftovers are large. One still running cannot be deleted; skip it.
            for (const n of olds) { try { fs.rmSync(path.join(dir, n)); } catch (e) { /* in use */ } }
            return null;
        } catch (e) { /* fall through */ }
    }
    return 'The Claude program the AI features need is missing (' + exe + '). Close any Claude window started from this '
        + 'folder, then in ' + root + ' delete node_modules, run "npm install", and restart the app.';
}

module.exports = { ensureClaudeBinary };
