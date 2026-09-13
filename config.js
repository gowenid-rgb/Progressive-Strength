// Centralised environment configuration.
//
// dotenv is loaded here rather than relying on server.js so that require order
// can never leave a module reading an unpopulated process.env.
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

// JWT_SECRET is a security boundary. A default value would let anyone who can read
// this repo forge a token for any user id, and the app would behave completely
// normally while they did it. Refuse to start rather than run silently insecure.
if (!JWT_SECRET) {
    console.error([
        '',
        'FATAL: JWT_SECRET is not set.',
        '',
        'Tokens cannot be signed securely without it, and there is deliberately no',
        'fallback value. Set it before starting:',
        '',
        '  Railway  ->  service > Variables > New Variable',
        '  Local    ->  copy .env.example to .env and fill it in',
        '',
        'Generate a strong value with:',
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
        ''
    ].join('\n'));
    process.exit(1);
}

if (JWT_SECRET.length < 32) {
    console.warn(
        'WARNING: JWT_SECRET is under 32 characters. Use a long random value, ' +
        'not a memorable phrase — short secrets are brute-forceable offline.'
    );
}

module.exports = {
    JWT_SECRET,
    // These two keep their existing optional semantics: the server warns and runs
    // without a database, and the AI routes return a clear 500 when the key is absent.
    DATABASE_URL: process.env.DATABASE_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    PORT: process.env.PORT || 3000
};
