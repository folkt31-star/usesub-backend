const express = require('express');
const path = require('path');
const axios = require('axios'); // For making secure API calls to Bigisub, Flutterwave & Resend
const { createClient } = require('@libsql/client');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Allowed frontend origins (QServers domain + Vercel preview)
const allowedOrigins = [
    'https://usesub.com.ng',
    'https://www.usesub.com.ng',
    'https://usesub-omega.vercel.app'
];

// CORS & Preflight Middleware (no external package needed)
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Phone');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Turso Cloud Database
const turso = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

(async () => {
    try {
        await turso.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                phone TEXT UNIQUE,
                email TEXT,
                pin TEXT,
                walletBalance REAL DEFAULT 0,
                isVerified INTEGER DEFAULT 0,
                verificationCode TEXT
            )
        `);
        // Safely add new auth columns without breaking existing users or balances
        try { await turso.execute(`ALTER TABLE users ADD COLUMN googleId TEXT`); } catch (e) {}
        try { await turso.execute(`ALTER TABLE users ADD COLUMN emailVerified INTEGER DEFAULT 0`); } catch (e) {}
        console.log('Connected to Turso database.');
    } catch (err) {
        console.error('Error initializing Turso database:', err.message);
    }
})();

// Fallback session tracking for single-user testing
let activeUserPhone = null;

// Helper to resolve logged-in user's phone from userPhone/phone, query, header, or fallback session
function getRequestPhone(req) {
    return (
        (req.body && req.body.userPhone) ||
        (req.query && req.query.phone) ||
        (req.body && req.body.phone) ||
        req.headers['x-user-phone'] ||
        activeUserPhone
    );
}

// Bigisub v2 Network IDs (1=MTN, 2=Glo, 3=Airtel, 4=9Mobile)
const BIGISUB_NETWORK_IDS = {
    MTN: 1,
    Glo: 2,
    Airtel: 3,
    '9mobile': 4
};

// Custom profit margin per purchase (between ₦50 and ₦70)
const PROFIT_MARGIN = 60;

// Replace bigisubPlanId with the exact numeric plan IDs from GET /api/v2/vtu/data/plans/
const rawPlans = [
    { id: "mtn-1gb", network: "MTN", name: "MTN 1GB SME (7days weekly)", basePrice: 435, profit: PROFIT_MARGIN, bigisubPlanId: 207 },
    { id: "mtn-2gb", network: "MTN", name: "MTN 2GB SME (30 Days)", basePrice: 1160, profit: PROFIT_MARGIN, bigisubPlanId: 3 },
    { id: "glo-1gb", network: "Glo", name: "Glo 1GB SME (1 day)", basePrice: 245, profit: PROFIT_MARGIN, bigisubPlanId: 258 },
    { id: "airtel-1gb", network: "Airtel", name: "Airtel 1GB GIFTING (7days weekly)", basePrice: 801, profit: PROFIT_MARGIN, bigisubPlanId: 172 },
    { id: "airtel-10gb", network: "Airtel", name: "Airtel 10GB SME (30 Days)", basePrice: 3450, profit: PROFIT_MARGIN, bigisubPlanId: 105 },
    { id: "airtel-1gb-3d-social", network: "Airtel", name: "Airtel 1GB GIFTING (3 days social bundle (loan safe))", basePrice: 303, profit: PROFIT_MARGIN, bigisubPlanId: 342 },
    { id: "airtel-500mb-1d", network: "Airtel", name: "Airtel 500MB GIFTING (1 day (loan safe))", basePrice: 356, profit: PROFIT_MARGIN, bigisubPlanId: 339 },
    { id: "airtel-1gb-1d", network: "Airtel", name: "Airtel 1GB GIFTING (1 day (loan safe))", basePrice: 505, profit: PROFIT_MARGIN, bigisubPlanId: 340 },
    { id: "airtel-2gb-2d-a", network: "Airtel", name: "Airtel 2GB GIFTING (2 days (loan safe))", basePrice: 612, profit: PROFIT_MARGIN, bigisubPlanId: 173 },
    { id: "airtel-1gb", network: "Airtel", name: "Airtel 1GB GIFTING (7days weekly)", basePrice: 801, profit: PROFIT_MARGIN, bigisubPlanId: 172 },
    { id: "airtel-4gb-2d", network: "Airtel", name: "Airtel 4GB GIFTING (2 days (loan safe))", basePrice: 1010, profit: PROFIT_MARGIN, bigisubPlanId: 200 },
    { id: "airtel-2gb-30d", network: "Airtel", name: "Airtel 2GB GIFTING (30Days (loan safe))", basePrice: 1503, profit: PROFIT_MARGIN, bigisubPlanId: 175 },
    { id: "airtel-6gb-2d", network: "Airtel", name: "Airtel 6GB GIFTING (2 days)", basePrice: 1517, profit: PROFIT_MARGIN, bigisubPlanId: 247 },
    { id: "airtel-3gb-30d", network: "Airtel", name: "Airtel 3GB GIFTING (30Days)", basePrice: 2008, profit: PROFIT_MARGIN, bigisubPlanId: 176 },
    { id: "airtel-4gb-30d", network: "Airtel", name: "Airtel 4GB GIFTING (30 Days)", basePrice: 2538, profit: PROFIT_MARGIN, bigisubPlanId: 203 },
    { id: "airtel-10gb-30d", network: "Airtel", name: "Airtel 10GB GIFTING (30 Days (loan safe))", basePrice: 4056, profit: PROFIT_MARGIN, bigisubPlanId: 178 } 
    { id: "9mobile-2gb", network: "9mobile", name: "9mobile 2GB DataTransfer (30 Days)", basePrice: 990, profit: PROFIT_MARGIN, bigisubPlanId: 190 }
];

const localDataPlans = rawPlans.map(plan => ({
    ...plan,
    price: plan.basePrice + plan.profit
}));

// Helper Function: Validate Nigerian Network Prefixes
function isValidNetworkPrefix(network, phone) {
    const cleanPhone = String(phone || '').trim();
    const mtnPrefixes = ['0803', '0806', '0703', '0706', '0813', '0814', '0816', '0903', '0906', '0913', '0916'];
    const airtelPrefixes = ['0802', '0808', '0708', '0812', '0902', '0901', '0904', '0907', '0912'];
    const gloPrefixes = ['0805', '0807', '0705', '0811', '0707', '0905'];
    const mobile9Prefixes = ['0809', '0817', '0818', '0909'];

    if (network === 'MTN') return mtnPrefixes.some(p => cleanPhone.startsWith(p));
    if (network === 'Airtel') return airtelPrefixes.some(p => cleanPhone.startsWith(p));
    if (network === 'Glo') return gloPrefixes.some(p => cleanPhone.startsWith(p));
    if (network === '9mobile') return mobile9Prefixes.some(p => cleanPhone.startsWith(p));

    return true;
}

// Buy Airtime via Bigisub VTU
app.post('/api/buy-airtime', async (req, res) => {
    try {
        const userPhone = getRequestPhone(req);
        const { recipientPhone, network, amount } = req.body || {};
        const numericAmount = Number(amount);
        const cleanRecipient = String(recipientPhone || '').trim();
        const normalizedNetwork = String(network || '').trim();
        const networkKey = Object.keys(BIGISUB_NETWORK_IDS).find(
            (k) => k.toUpperCase() === normalizedNetwork.toUpperCase()
        );
        const networkId = networkKey ? BIGISUB_NETWORK_IDS[networkKey] : null;

        if (!userPhone || !cleanRecipient || !networkId || !numericAmount || numericAmount < 50) {
            return res.status(400).json({ success: false, message: 'Invalid airtime request details.' });
        }

        const prefixNetworkMap = {
            MTN: 'MTN',
            GLO: 'Glo',
            AIRTEL: 'Airtel',
            '9MOBILE': '9mobile'
        };
        const prefixCheckNetwork = prefixNetworkMap[networkKey.toUpperCase()];

        if (!isValidNetworkPrefix(prefixCheckNetwork, cleanRecipient)) {
            return res.status(400).json({
                success: false,
                message: `The number ${cleanRecipient} does not match ${networkKey}. Please check the network and try again.`
            });
        }

        const userRes = await turso.execute({
            sql: 'SELECT * FROM users WHERE phone = ?',
            args: [userPhone]
        });
        const row = userRes.rows[0];

        if (!row) {
            return res.status(400).json({ success: false, message: 'User session not found.' });
        }

        if (Number(row.walletBalance || 0) < numericAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient wallet balance.' });
        }

        const bigisubToken = String(process.env.BIGISUB_API_TOKEN || process.env.BIGISUB_TOKEN || '').trim();
        const bigisubPin = String(process.env.BIGISUB_PIN || process.env.BIGISUB_ACCOUNT_PIN || '').trim();

        const bigisubRes = await axios.post(
            'https://api.bigisub.ng/api/v2/vtu/airtime/purchase/',
            {
                network: networkId,
                phone_number: cleanRecipient,
                amount: String(numericAmount),
                airtime_type: 'vtu',
                pin: bigisubPin
            },
            {
                headers: {
                    'Authorization': `Token ${bigisubToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const bigisubData = bigisubRes.data || {};
        if (bigisubData.success === false) {
            return res.status(400).json({
                success: false,
                message: bigisubData.message || 'Bigisub airtime delivery failed.'
            });
        }

        const newBalance = Number((Number(row.walletBalance || 0) - numericAmount).toFixed(2));
        await turso.execute({
            sql: 'UPDATE users SET walletBalance = ? WHERE phone = ?',
            args: [newBalance, userPhone]
        });

        return res.json({
            success: true,
            message: `₦${numericAmount} ${networkKey} airtime sent to ${cleanRecipient}!`,
            newBalance
        });
    } catch (err) {
        console.error('Airtime route error:', err.message, err.response?.data || '');
        return res.status(500).json({ success: false, message: 'Error processing airtime purchase.' });
    }
});

// Get current user from database
app.get('/api/user', async (req, res) => {
    const targetPhone = getRequestPhone(req);
    if (!targetPhone) {
        return res.json({ success: false, message: "Not logged in" });
    }

    try {
        const result = await turso.execute({
            sql: 'SELECT * FROM users WHERE phone = ?',
            args: [targetPhone]
        });
        const row = result.rows[0];
        if (!row) {
            return res.json({ success: false, message: "User session not found" });
        }
        return res.json({
            success: true,
            user: {
                name: row.name,
                phone: row.phone,
                email: row.email,
                walletBalance: row.walletBalance,
                pin: row.pin
            }
        });
    } catch (err) {
        console.error('Get user error:', err.message);
        return res.json({ success: false, message: "Database error loading user." });
    }
});

// Step 1: Register User (Saves to Turso & generates OTP)
app.post('/api/register', async (req, res) => {
    const { name, phone, email, pin } = req.body || {};
    const cleanPhone = String(phone || '').trim();
    const cleanPin = String(pin || '').trim();

    if (!cleanPhone || cleanPhone.length < 10 || !cleanPin || cleanPin.length < 4) {
        return res.json({ success: false, message: "Please enter a valid phone number and 4-digit PIN." });
    }

    const verificationCode = Math.floor(1000 + Math.random() * 9000).toString();

    try {
        const existingRes = await turso.execute({
            sql: 'SELECT * FROM users WHERE phone = ?',
            args: [cleanPhone]
        });
        const row = existingRes.rows[0];

        if (row) {
            await turso.execute({
                sql: 'UPDATE users SET name = ?, pin = ?, verificationCode = ? WHERE phone = ?',
                args: [name || "User", cleanPin, verificationCode, cleanPhone]
            });
            console.log(`[OTP RESENT] Verification code for ${cleanPhone} is: ${verificationCode}`);
            return res.json({
                success: true,
                requiresVerification: true,
                phone: cleanPhone,
                message: `Verification code sent! (Check Render server logs for code: ${verificationCode})`
            });
        }

        await turso.execute({
            sql: 'INSERT INTO users (name, phone, email, pin, walletBalance, isVerified, verificationCode) VALUES (?, ?, ?, ?, 0, 0, ?)',
            args: [name || "User", cleanPhone, email || "", cleanPin, verificationCode]
        });
        console.log(`[OTP SENT] Verification code for ${cleanPhone} is: ${verificationCode}`);
        return res.json({
            success: true,
            requiresVerification: true,
            phone: cleanPhone,
            message: `Verification code sent! (Check Render server logs for code: ${verificationCode})`
        });
    } catch (err) {
        console.error('Register error:', err.message);
        return res.json({ success: false, message: "Database error during registration." });
    }
});

// Step 2: Verify Phone Number with OTP Code
app.post('/api/verify-otp', async (req, res) => {
    const cleanPhone = String((req.body && req.body.phone) || '').trim();
    const cleanCode = String((req.body && req.body.code) || '').trim();

    try {
        const result = await turso.execute({
            sql: 'SELECT * FROM users WHERE phone = ?',
            args: [cleanPhone]
        });
        const user = result.rows[0];

        if (!user) {
            return res.json({ success: false, message: "User not found." });
        }

        if (String(user.verificationCode) !== cleanCode) {
            return res.json({ success: false, message: "Invalid verification code." });
        }

        await turso.execute({
            sql: 'UPDATE users SET isVerified = 1 WHERE phone = ?',
            args: [cleanPhone]
        });

        activeUserPhone = cleanPhone;
        return res.json({
            success: true,
            message: "Account verified successfully!",
            user: {
                name: user.name,
                phone: user.phone,
                walletBalance: user.walletBalance
            }
        });
    } catch (err) {
        console.error('Verify OTP error:', err.message);
        return res.json({ success: false, message: "Verification state error." });
    }
});
    // Endpoint for frontend to fetch plans (includes profit in price)
app.get('/api/data-plans', (req, res) => {
    res.json({ success: true, plans: localDataPlans });
});

// Endpoint to fund wallet manually (or test)
app.post('/api/fund-wallet', async (req, res) => {
    const targetPhone = getRequestPhone(req);
    if (!targetPhone) {
        return res.json({ success: false, message: "Please log in first." });
    }

    const addAmount = parseFloat(req.body && req.body.amount);

    if (!addAmount || addAmount <= 0) {
        return res.json({ success: false, message: "Enter a valid funding amount." });
    }

    try {
        const result = await turso.execute({
            sql: 'SELECT walletBalance FROM users WHERE phone = ?',
            args: [targetPhone]
        });
        const row = result.rows[0];

        if (!row) {
            return res.json({ success: false, message: "User session not found." });
        }

        const newBalance = Number((Number(row.walletBalance || 0) + addAmount).toFixed(2));

        await turso.execute({
            sql: 'UPDATE users SET walletBalance = ? WHERE phone = ?',
            args: [newBalance, targetPhone]
        });

        return res.json({
            success: true,
            message: `Successfully added ₦${addAmount} to your wallet!`,
            newBalance: newBalance
        });
    } catch (err) {
        console.error('Fund wallet error:', err.message);
        return res.json({ success: false, message: "Failed to update wallet balance." });
    }
});

// Flutterwave Webhook Endpoint for Automated Card/Bank Funding
app.post('/api/flw-webhook', async (req, res) => {
    const event = req.body;
    if (event && event.event === 'charge.completed' && event.data && event.data.status === 'successful') {
        const customerEmail = event.data.customer && event.data.customer.email;
        const amountPaid = parseFloat(event.data.amount);

        if (customerEmail && amountPaid > 0) {
            try {
                const result = await turso.execute({
                    sql: 'SELECT * FROM users WHERE email = ? OR phone = ?',
                    args: [customerEmail, customerEmail]
                });
                const user = result.rows[0];

                if (user) {
                    const newBalance = Number((Number(user.walletBalance || 0) + amountPaid).toFixed(2));
                    await turso.execute({
                        sql: 'UPDATE users SET walletBalance = ? WHERE id = ?',
                        args: [newBalance, user.id]
                    });
                    console.log(`[FLUTTERWAVE FUNDING SUCCESS] Credited ₦${amountPaid} to user ${user.phone}`);
                }
            } catch (err) {
                console.error('[FLUTTERWAVE WEBHOOK DB ERROR]', err.message);
            }
        }
    }
    res.sendStatus(200);
});

// Verify Flutterwave payment on backend before crediting user wallet
app.post('/api/verify-flw-payment', async (req, res) => {
    const targetPhone = getRequestPhone(req);
    const { transaction_id } = req.body || {};

    if (!targetPhone || !transaction_id) {
        return res.json({ success: false, message: "Missing user session or transaction ID." });
    }

    try {
        const flwResponse = await axios.get(
            `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transaction_id)}/verify`,
            {
                headers: {
                    Authorization: `Bearer ${String(process.env.FLW_SECRET_KEY || '').trim()}`
                }
            }
        );

        const txData = flwResponse.data && flwResponse.data.data;
        if (
            flwResponse.data &&
            flwResponse.data.status === 'success' &&
            txData &&
            txData.status === 'successful' &&
            txData.currency === 'NGN' &&
            Number(txData.amount) > 0
        ) {
            const paidAmount = Number(txData.amount);
            const result = await turso.execute({
                sql: 'SELECT walletBalance FROM users WHERE phone = ?',
                args: [targetPhone]
            });
            const row = result.rows[0];

            if (!row) {
                return res.json({ success: false, message: "User account not found." });
            }

            const newBalance = Number((Number(row.walletBalance || 0) + paidAmount).toFixed(2));
            await turso.execute({
                sql: 'UPDATE users SET walletBalance = ? WHERE phone = ?',
                args: [newBalance, targetPhone]
            });

            return res.json({
                success: true,
                message: `Wallet credited with ₦${paidAmount}!`,
                newBalance: newBalance
            });
        }

        return res.json({ success: false, message: "Payment could not be verified as successful." });
    } catch (error) {
        console.error("Flutterwave verify error:", error.message, error.response?.data || "");
        return res.json({ success: false, message: "Payment verification failed." });
    }
});

// Endpoint to process data purchase via Bigisub API & Turso balance update
app.post('/api/buy-data', async (req, res) => {
    const targetPhone = getRequestPhone(req);
    if (!targetPhone) {
        return res.json({ success: false, message: "Please log in first." });
    }

    const { network, planId, phone, pin } = req.body || {};
    const recipientPhone = String(phone || '').trim();
    const userPin = String(pin || '').trim();
    const networkId = BIGISUB_NETWORK_IDS[network];
    const plan = localDataPlans.find(p => p.id === planId);

    if (!plan || !networkId) {
        return res.json({ success: false, message: "Invalid network or data plan selected." });
    }

    if (!recipientPhone || recipientPhone.length < 10) {
        return res.json({ success: false, message: "Please enter a valid recipient phone number." });
    }

    if (!isValidNetworkPrefix(network, recipientPhone)) {
        return res.json({ success: false, message: `Invalid phone number prefix for ${network}. Please check the number.` });
    }

    const bigisubPin = String(process.env.BIGISUB_ACCOUNT_PIN || process.env.BIGISUB_PIN || userPin).trim();
    const bigisubToken = String(process.env.BIGISUB_API_TOKEN || process.env.BIGISUB_TOKEN || '').trim();

    try {
        const result = await turso.execute({
            sql: 'SELECT * FROM users WHERE phone = ?',
            args: [targetPhone]
        });
        const user = result.rows[0];

        if (!user) {
            return res.json({ success: false, message: "User session not found." });
        }

        if (userPin !== String(user.pin)) {
            return res.json({ success: false, message: "Incorrect transaction PIN." });
        }

        if (Number(user.walletBalance || 0) < plan.price) {
            return res.json({ success: false, message: "Insufficient wallet balance. Please fund your wallet." });
        }

        const bigisubRes = await axios.post(
            'https://api.bigisub.ng/api/v2/vtu/data/purchase/',
            {
                network: networkId,
                plan: Number(plan.bigisubPlanId),
                phone_number: recipientPhone,
                pin: bigisubPin,
                ported_number: true
            },
            {
                headers: {
                    'Authorization': `Token ${bigisubToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const newBalance = Number((Number(user.walletBalance || 0) - plan.price).toFixed(2));

        await turso.execute({
            sql: 'UPDATE users SET walletBalance = ? WHERE phone = ?',
            args: [newBalance, targetPhone]
        });

        const ref = (bigisubRes.data && (bigisubRes.data.reference || bigisubRes.data.transaction_id)) || 'N/A';
        console.log(`[BIGISUB API SUCCESS] Ref: ${ref} | Phone: ${recipientPhone} | Plan: ${plan.name}`);

        return res.json({
            success: true,
            message: `${plan.name} sent to ${recipientPhone}!`,
            newBalance: newBalance,
            reference: ref
        });
    } catch (error) {
        console.error("Bigisub data purchase error:", error.message, error.response?.data || "");
        return res.json({ success: false, message: "Data purchase failed. Please try again." });
    }
});
                             // ==========================================
// NEW AUTH FLOW: GOOGLE, RESEND OTP & LOGIN
// ==========================================

// 1. Google Sign-In / Sign-Up Authorization
app.post('/api/auth/google', async (req, res) => {
    const { credential } = req.body || {};
    if (!credential) {
        return res.status(400).json({ success: false, message: 'Missing Google credential token.' });
    }

    try {
        const googleRes = await axios.get(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
        );
        const payload = googleRes.data;

        if (process.env.GOOGLE_CLIENT_ID && payload.aud !== process.env.GOOGLE_CLIENT_ID.trim()) {
            return res.status(401).json({ success: false, message: 'Invalid Google Client ID.' });
        }

        const googleId = payload.sub;
        const email = String(payload.email || '').trim().toLowerCase();
        const name = payload.name || email.split('@')[0] || 'User';

        const existingRes = await turso.execute({
            sql: 'SELECT * FROM users WHERE googleId = ? OR LOWER(email) = ?',
            args: [googleId, email]
        });
        let user = existingRes.rows[0];

        if (!user) {
            await turso.execute({
                sql: 'INSERT INTO users (name, email, googleId, walletBalance, isVerified, emailVerified) VALUES (?, ?, ?, 0, 1, 1)',
                args: [name, email, googleId]
            });
            const newRes = await turso.execute({
                sql: 'SELECT * FROM users WHERE LOWER(email) = ?',
                args: [email]
            });
            user = newRes.rows[0];
        } else if (!user.googleId) {
            await turso.execute({
                sql: 'UPDATE users SET googleId = ?, emailVerified = 1 WHERE id = ?',
                args: [googleId, user.id]
            });
        }

        if (user && user.phone) {
            activeUserPhone = user.phone;
        }

        const needsPhoneSetup = !user.phone || !user.pin;
        return res.json({
            success: true,
            needsPhoneSetup,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone || null,
                walletBalance: Number(user.walletBalance || 0)
            }
        });
    } catch (err) {
        console.error('Google auth error:', err.message, err.response?.data || '');
        return res.status(401).json({ success: false, message: 'Google authorization failed.' });
    }
});

// 2. Send Email Verification OTP via Resend API
app.post('/api/auth/email/send-otp', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const name = String((req.body && req.body.name) || '').trim();

    if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    try {
        const existingRes = await turso.execute({
            sql: 'SELECT * FROM users WHERE LOWER(email) = ?',
            args: [email]
        });
        const existingUser = existingRes.rows[0];

        if (existingUser) {
            await turso.execute({
                sql: "UPDATE users SET verificationCode = ?, name = COALESCE(NULLIF(?, ''), name) WHERE id = ?",
                args: [otpCode, name, existingUser.id]
            });
        } else {
            await turso.execute({
                sql: 'INSERT INTO users (name, email, walletBalance, isVerified, emailVerified, verificationCode) VALUES (?, ?, 0, 0, 0, ?)',
                args: [name || email.split('@')[0], email, otpCode]
            });
        }

        const resendKey = String(process.env.RESEND_API_KEY || '').trim();
        const fromEmail = String(process.env.RESEND_FROM_EMAIL || 'noreply@usesub.com.ng').trim();

        if (!resendKey) {
            console.log(`[RESEND NOT SET - DEV OTP] Code for ${email}: ${otpCode}`);
            return res.json({
                success: true,
                message: 'Verification code generated (set RESEND_API_KEY in Render to deliver live emails).'
            });
        }

        await axios.post(
            'https://api.resend.com/emails',
            {
                from: fromEmail,
                to: [email],
                subject: 'Your USEsub Verification Code',
                html: `<div style="font-family:sans-serif;padding:20px;">
                         <h2>Verify Your USEsub Email</h2>
                         <p>Your 6-digit verification code is:</p>
                         <h1 style="letter-spacing:4px;color:#16a34a;">${otpCode}</h1>
                         <p>Enter this code on USEsub to continue setting up your VTU account.</p>
                       </div>`
            },
            {
                headers: {
                    Authorization: `Bearer ${resendKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return res.json({
            success: true,
            message: `Verification code sent directly to ${email}!`
        });
    } catch (err) {
        console.error('Resend email OTP error:', err.message, err.response?.data || '');
        return res.status(500).json({ success: false, message: 'Failed to send verification email.' });
    }
});

// 3. Verify Email OTP Code
app.post('/api/auth/email/verify-otp', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').trim();

    if (!email || !code) {
        return res.status(400).json({ success: false, message: 'Email and verification code are required.' });
    }

    try {
        const result = await turso.execute({
            sql: 'SELECT * FROM users WHERE LOWER(email) = ?',
            args: [email]
        });
        const user = result.rows[0];

        if (!user || String(user.verificationCode) !== code) {
            return res.status(400).json({ success: false, message: 'Invalid verification code.' });
        }

        await turso.execute({
            sql: 'UPDATE users SET emailVerified = 1, verificationCode = NULL WHERE id = ?',
            args: [user.id]
        });

        if (user.phone) {
            activeUserPhone = user.phone;
        }

        const needsPhoneSetup = !user.phone || !user.pin;
        return res.json({
            success: true,
            needsPhoneSetup,
            message: 'Email verified successfully!',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone || null,
                walletBalance: Number(user.walletBalance || 0)
            }
        });
    } catch (err) {
        console.error('Verify email OTP error:', err.message);
        return res.status(500).json({ success: false, message: 'Error verifying email code.' });
    }
});

// 4. Complete Phone Number & 4-Digit PIN Setup (After Google or Email Verification)
app.post('/api/auth/complete-phone', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const cleanPhone = String((req.body && req.body.phone) || '').trim();
    const cleanPin = String((req.body && req.body.pin) || '').trim();

    if (!email || cleanPhone.length < 10 || cleanPin.length < 4) {
        return res.status(400).json({ success: false, message: 'Enter a valid email, phone number, and 4-digit PIN.' });
    }

    try {
        const phoneCheck = await turso.execute({
            sql: 'SELECT * FROM users WHERE phone = ? AND (email IS NULL OR LOWER(email) != ?)',
            args: [cleanPhone, email]
        });
        if (phoneCheck.rows[0]) {
            return res.status(400).json({ success: false, message: 'This phone number is already linked to another account.' });
        }

        await turso.execute({
            sql: 'UPDATE users SET phone = ?, pin = ?, isVerified = 1 WHERE LOWER(email) = ?',
            args: [cleanPhone, cleanPin, email]
        });

        const updatedRes = await turso.execute({
            sql: 'SELECT * FROM users WHERE LOWER(email) = ?',
            args: [email]
        });
        const user = updatedRes.rows[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'Account not found. Please sign up first.' });
        }

        activeUserPhone = cleanPhone;
        return res.json({
            success: true,
            message: 'Account registration completed!',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                walletBalance: Number(user.walletBalance || 0)
            }
        });
    } catch (err) {
        console.error('Complete phone setup error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to save phone number and PIN.' });
    }
});

// 5. Easy Returning User Login (Email or Phone + 4-Digit PIN)
app.post('/api/auth/login', async (req, res) => {
    const identifier = String((req.body && req.body.identifier) || '').trim().toLowerCase();
    const cleanPin = String((req.body && req.body.pin) || '').trim();

    if (!identifier || !cleanPin) {
        return res.status(400).json({ success: false, message: 'Enter your email or phone number and PIN.' });
    }

    try {
        const result = await turso.execute({
            sql: 'SELECT * FROM users WHERE LOWER(email) = ? OR phone = ?',
            args: [identifier, identifier]
        });
        const user = result.rows[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'Account not found. Please sign up first.' });
        }

        if (String(user.pin) !== cleanPin) {
            return res.status(401).json({ success: false, message: 'Incorrect PIN. Please try again.' });
        }

        if (user.phone) {
            activeUserPhone = user.phone;
        }

        return res.json({
            success: true,
            needsPhoneSetup: !user.phone,
            message: 'Welcome back!',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone || null,
                walletBalance: Number(user.walletBalance || 0)
            }
        });
    } catch (err) {
        console.error('Login error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// 6. Recognize Returning User Session (Auto-sync profile & wallet balance)
app.post('/api/auth/session', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const phone = String((req.body && req.body.phone) || '').trim();

    if (!email && !phone) {
        return res.status(400).json({ success: false, message: 'No session identifier provided.' });
    }

    try {
        const result = await turso.execute({
            sql: "SELECT * FROM users WHERE (email IS NOT NULL AND email != '' AND LOWER(email) = ?) OR (phone IS NOT NULL AND phone != '' AND phone = ?) LIMIT 1",
            args: [email, phone]
        });
        const user = result.rows[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        if (user.phone) {
            activeUserPhone = user.phone;
        }

        return res.json({
            success: true,
            needsPhoneSetup: !user.phone || !user.pin,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone || null,
                walletBalance: Number(user.walletBalance || 0)
            }
        });
    } catch (err) {
        console.error('Session check error:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to restore session.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
    
