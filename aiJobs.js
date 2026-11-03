// Long AI answers as background jobs.
//
// Cloudflare closes a request that has not answered within 100 seconds (error 524), and the
// local model can take longer than that for a programme, especially when a retry is needed. The
// server would still finish and save the work, but the phone would show an error, and tapping
// again would design a second programme. So a client that sends "Prefer: respond-async" gets
// 202 { jobId } at once and polls GET /api/ai-jobs/:id, each poll a short request. Clients that
// do not ask keep the old behaviour: the answer in the same request.
const crypto = require('crypto');

const KEEP_MS = 15 * 60 * 1000;   // a finished job's answer stays readable this long
const jobs = new Map();           // id -> { userId, status: 'running'|'done', code, body, at }

function sweep(now) {
    for (const [id, j] of jobs) if (now - j.at > KEEP_MS) jobs.delete(id);
}

// A stand-in for Express's res that records what the handler sends instead of sending it.
function recorder(job) {
    const res = {
        statusCode: 200,
        headersSent: false,
        status(code) { res.statusCode = code; return res; },
        set() { return res; },
        setHeader() { return res; },
        json(body) {
            if (job.status === 'done') return res;
            Object.assign(job, { status: 'done', code: res.statusCode, body, at: Date.now() });
            res.headersSent = true;
            return res;
        },
        send(body) { return res.json(body); }
    };
    return res;
}

/** Wraps an AI route handler so it can run as a background job when the client asks. */
function asyncable(handler) {
    return (req, res, next) => {
        if (!/respond-async/i.test(req.get('Prefer') || '')) return handler(req, res, next);
        const now = Date.now();
        sweep(now);
        const id = crypto.randomBytes(16).toString('hex');
        const job = { userId: req.user && req.user.id, status: 'running', code: null, body: null, at: now };
        jobs.set(id, job);
        Promise.resolve()
            .then(() => handler(req, recorder(job), next))
            .then(() => {
                if (job.status !== 'done') Object.assign(job, { status: 'done', code: 500, body: { error: 'No answer was produced' }, at: Date.now() });
            })
            .catch(err => Object.assign(job, { status: 'done', code: 500, body: { error: (err && err.message) || 'Failed' }, at: Date.now() }));
        res.status(202).json({ jobId: id });
    };
}

/** GET /api/ai-jobs/:id — only the user who started a job can read it. */
function jobStatus(req, res) {
    const job = jobs.get(String(req.params.id || ''));
    if (!job || job.userId !== (req.user && req.user.id)) return res.status(404).json({ error: 'Unknown or expired job' });
    if (job.status === 'running') return res.json({ status: 'running' });
    res.json({ status: 'done', code: job.code, body: job.body });
}

module.exports = { asyncable, jobStatus, __jobs: jobs };
