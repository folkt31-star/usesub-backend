const express = require('express');
const path = require('path');
const axios = require('axios'); // For making secure API calls to Bigisub & Flutterwave
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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
