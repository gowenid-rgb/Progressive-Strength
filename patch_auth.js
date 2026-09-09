const fs = require('fs');
const path = './public/index.html';
let html = fs.readFileSync(path, 'utf8');

const authScreen = "<!-- SCREEN 0: AUTH -->\n" +
"        <div id='screen-auth' class='screen flex-col h-full overflow-y-auto pb-24 items-center justify-center p-8 active'>\n" +
"            <div class='w-full'>\n" +
"                <h1 class='text-4xl font-bold text-white mb-2 tracking-tight'>Login</h1>\n" +
"                <p class='text-textMuted mb-8 text-sm'>Welcome to Progressive Strength.</p>\n" +
"                <input type='email' id='auth-email' placeholder='Email' class='w-full bg-surface border border-borderSubtle rounded-xl p-4 text-white mb-4 focus:outline-none focus:border-white transition-colors'>\n" +
"                <input type='password' id='auth-password' placeholder='Password' class='w-full bg-surface border border-borderSubtle rounded-xl p-4 text-white mb-6 focus:outline-none focus:border-white transition-colors'>\n" +
"                <button onclick='handleAuth(\"login\")' class='w-full bg-white text-black py-4 rounded-xl font-bold mb-4 hover:bg-gray-200'>Log In</button>\n" +
"                <button onclick='handleAuth(\"register\")' class='w-full bg-surface text-white py-4 rounded-xl font-bold border border-borderSubtle hover:bg-surfaceElevated'>Create Account</button>\n" +
"            </div>\n" +
"        </div>\n";

html = html.replace('<!-- SCREEN 1: ONBOARDING -->', authScreen + '        <!-- SCREEN 1: ONBOARDING -->');
html = html.replace('id="screen-onboarding" class="screen active', 'id="screen-onboarding" class="screen');

const domLoadedTarget = "document.addEventListener('DOMContentLoaded', () => {\\n" +
"            const savedPlan = localStorage.getItem('currentWorkoutPlan');\\n" +
"            if (savedPlan) {\\n" +
"                try {\\n" +
"                    currentWorkoutPlan = JSON.parse(savedPlan);\\n" +
"                    renderPlan(currentWorkoutPlan);\\n" +
"                    nav('screen-plan', 'nav-plan');\\n" +
"                } catch(e) {}\\n" +
"            }\\n" +
"        });";

// We'll just replace by finding 'document.addEventListener('DOMContentLoaded', () => {' and replacing to the end of the block.
const blockRegex = /document\.addEventListener\('DOMContentLoaded', \(\) => \{[\s\S]*?\}\);/;

const domLoadedReplace = "document.addEventListener('DOMContentLoaded', async () => {\n" +
"            const token = localStorage.getItem('token');\n" +
"            if (!token) {\n" +
"                nav('screen-auth');\n" +
"                return;\n" +
"            }\n" +
"            try {\n" +
"                const res = await fetch('/api/user/data', { headers: { 'Authorization': 'Bearer ' + token } });\n" +
"                if (res.ok) {\n" +
"                    const data = await res.json();\n" +
"                    if (data.currentPlan) {\n" +
"                        currentWorkoutPlan = typeof data.currentPlan === 'string' ? JSON.parse(data.currentPlan) : data.currentPlan;\n" +
"                        localStorage.setItem('currentWorkoutPlan', JSON.stringify(currentWorkoutPlan));\n" +
"                        renderPlan(currentWorkoutPlan);\n" +
"                        nav('screen-plan', 'nav-plan');\n" +
"                    } else {\n" +
"                        nav('screen-onboarding');\n" +
"                    }\n" +
"                    if (data.workoutJournal) {\n" +
"                        localStorage.setItem('workoutJournal', JSON.stringify(data.workoutJournal));\n" +
"                    }\n" +
"                } else {\n" +
"                    nav('screen-auth');\n" +
"                }\n" +
"            } catch(e) { nav('screen-auth'); }\n" +
"        });\n" +
"\n" +
"        async function handleAuth(type) {\n" +
"            const email = document.getElementById('auth-email').value;\n" +
"            const password = document.getElementById('auth-password').value;\n" +
"            if(!email || !password) return alert('Email and password required');\n" +
"            try {\n" +
"                const res = await fetch('/api/auth/' + type, {\n" +
"                    method: 'POST',\n" +
"                    headers: { 'Content-Type': 'application/json' },\n" +
"                    body: JSON.stringify({ email, password })\n" +
"                });\n" +
"                const data = await res.json();\n" +
"                if(!res.ok) throw new Error(data.error || 'Failed');\n" +
"                \n" +
"                localStorage.setItem('token', data.token);\n" +
"                const userRes = await fetch('/api/user/data', { headers: { 'Authorization': 'Bearer ' + data.token } });\n" +
"                const userData = await userRes.json();\n" +
"                if (userData.currentPlan) {\n" +
"                    currentWorkoutPlan = typeof userData.currentPlan === 'string' ? JSON.parse(userData.currentPlan) : userData.currentPlan;\n" +
"                    localStorage.setItem('currentWorkoutPlan', JSON.stringify(currentWorkoutPlan));\n" +
"                    renderPlan(currentWorkoutPlan);\n" +
"                    nav('screen-plan', 'nav-plan');\n" +
"                } else {\n" +
"                    nav('screen-onboarding');\n" +
"                }\n" +
"            } catch(e) {\n" +
"                alert(e.message);\n" +
"            }\n" +
"        }\n" +
"        \n" +
"        async function syncData() {\n" +
"            const token = localStorage.getItem('token');\n" +
"            if(!token) return;\n" +
"            const currentPlan = localStorage.getItem('currentWorkoutPlan');\n" +
"            const workoutJournal = localStorage.getItem('workoutJournal');\n" +
"            await fetch('/api/user/data', {\n" +
"                method: 'POST',\n" +
"                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },\n" +
"                body: JSON.stringify({\n" +
"                    currentPlan: currentPlan ? JSON.parse(currentPlan) : null,\n" +
"                    workoutJournal: workoutJournal ? JSON.parse(workoutJournal) : []\n" +
"                })\n" +
"            });\n" +
"        }";

html = html.replace(blockRegex, domLoadedReplace);

html = html.replace(/headers: \{ 'Content-Type': 'application\/json' \},/g, "headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },");
html = html.replace(/localStorage\.setItem\('currentWorkoutPlan', JSON\.stringify\((.*?)\)\);/g, "localStorage.setItem('currentWorkoutPlan', JSON.stringify()); await syncData();");
html = html.replace('alert("Workout finished and saved to journal!");', 'await syncData(); alert("Workout finished and saved to journal!");');

fs.writeFileSync(path, html);
console.log('Patched index.html successfully!');
