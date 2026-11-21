const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios'); // For making secure API calls to Bigisub & Flutterwave
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

// Initialize SQLite Database
const dbFile = path.join(__dirname, 'usesub.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("Error opening database:", err.message);
    } else {
        console.log("Connected to the SQLite database.");
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            phone TEXT UNIQUE,
            email TEXT,
            pin TEXT,
            walletBalance REAL DEFAULT 0,
            isVerified INTEGER DEFAULT 0,
            verificationCode TEXT
        )`);
    }
});

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

// Get current user from database
app.get('/api/user', (req, res) => {
    const targetPhone = getRequestPhone(req);
    if (!targetPhone) {
        return res.json({ success: false, message: "Not logged in" });
    }

    db.get(`SELECT * FROM users WHERE phone = ?`, [targetPhone], (err, row) => {
        if (err || !row) {
            return res.json({ success: false, message: "User session not found" });
        }
        res.json({
            success: true,
            user: {
                name: row.name,
                phone: row.phone,
                email: row.email,
                walletBalance: row.walletBalance,
                pin: row.pin
            }
        });
    });
});

// Step 1: Register User (Saves to SQLite & generates OTP)
app.post('/api/register', (req, res) => {
    const { name, phone, email, pin } = req.body;
    const cleanPhone = String(phone || '').trim();
    const cleanPin = String(pin || '').trim();

    if (!cleanPhone || cleanPhone.length < 10 || !cleanPin || cleanPin.length < 4) {
        return res.json({ success: false, message: "Please enter a valid phone number and 4-digit PIN." });
    }

    const verificationCode = Math.floor(1000 + Math.random() * 9000).toString();

    db.get(`SELECT * FROM users WHERE phone = ?`, [cleanPhone], (err, row) => {
        if (err) {
            return res.json({ success: false, message: "Database lookup error." });
        }

        if (row) {
            db.run(
                `UPDATE users SET name = ?, pin = ?, verificationCode = ? WHERE phone = ?`,
                [name || "User", cleanPin, verificationCode, cleanPhone],
                (updateErr) => {
                    if (updateErr) {
                        return res.json({ success: false, message: "Database update error." });
                    }
                    console.log(`[OTP RESENT] Verification code for ${cleanPhone} is: ${verificationCode}`);
                    return res.json({
                        success: true,
                        requiresVerification: true,
                        phone: cleanPhone,
                        message: `Verification code sent! (Check Render server logs for code: ${verificationCode})`
                    });
                }
            );
        } else {
            db.run(
                `INSERT INTO users (name, phone, email, pin, walletBalance, isVerified, verificationCode) VALUES (?, ?, ?, ?, 0, 0, ?)`,
                [name || "User", cleanPhone, email || "", cleanPin, verificationCode],
                (insertErr) => {
                    if (insertErr) {
                        return res.json({ success: false, message: "Error creating user account." });
                    }
                    console.log(`[OTP SENT] Verification code for ${cleanPhone} is: ${verificationCode}`);
                    return res.json({
                        success: true,
                        requiresVerification: true,
                        phone: cleanPhone,
                        message: `Verification code sent! (Check Render server logs for code: ${verificationCode})`
                    });
                }
            );
        }
    });
});

// Step 2: Verify Phone Number with OTP Code
app.post('/api/verify-otp', (req, res) => {
    const cleanPhone = String((req.body && req.body.phone) || '').trim();
    const cleanCode = String((req.body && req.body.code) || '').trim();

    db.get(`SELECT * FROM users WHERE phone = ?`, [cleanPhone], (err, user) => {
        if (err || !user) {
            return res.json({ success: false, message: "User not found." });
        }

        if (String(user.verificationCode) !== cleanCode) {
            return res.json({ success: false, message: "Invalid verification code." });
        }

        db.run(`UPDATE users SET isVerified = 1 WHERE phone = ?`, [cleanPhone], (updateErr) => {
            if (updateErr) {
                return res.json({ success: false, message: "Verification state error." });
            }
            activeUserPhone = cleanPhone;
            res.json({
                success: true,
                message: "Account verified successfully!",
                user: {
                    name: user.name,
                    phone: user.phone,
                    walletBalance: user.walletBalance
                }
            });
        });
    });
});

// Endpoint for frontend to fetch plans (includes profit in price)
app.get('/api/data-plans', (req, res) => {
    res.json({ success: true, plans: localDataPlans });
});

// Endpoint to fund wallet manually (or test)
app.post('/api/fund-wallet', (req, res) => {
    const targetPhone = getRequestPhone(req);
    if (!targetPhone) {
        return res.json({ success: false, message: "Please log in first." });
    }

    const addAmount = parseFloat(req.body && req.body.amount);

    if (!addAmount || addAmount <= 0) {
        return res.json({ success: false, message: "Enter a valid funding amount." });
    }

    db.get(`SELECT walletBalance FROM users WHERE phone = ?`, [targetPhone], (err, row) => {
        if (err || !row) {
            return res.json({ success: false, message: "User session not found." });
        }

        const newBalance = Number((row.walletBalance + addAmount).toFixed(2));

        db.run(`UPDATE users SET walletBalance = ? WHERE phone = ?`, [newBalance, targetPhone], (updateErr) => {
            if (updateErr) {
                return res.json({ success: false, message: "Failed to update wallet balance." });
            }

            res.json({
                success: true,
                message: `Successfully added ₦${addAmount} to your wallet!`,
                newBalance: newBalance
            });
        });
    });
});

// Flutterwave Webhook Endpoint for Automated Card/Bank Funding
app.post('/api/flw-webhook', (req, res) => {
    const event = req.body;
    if (event && event.event === 'charge.completed' && event.data && event.data.status === 'successful') {
        const customerEmail = event.data.customer && event.data.customer.email;
        const amountPaid = parseFloat(event.data.amount);

        if (customerEmail && amountPaid > 0) {
            db.get(`SELECT * FROM users WHERE email = ? OR phone = ?`, [customerEmail, customerEmail], (err, user) => {
                if (user) {
                    const newBalance = Number((user.walletBalance + amountPaid).toFixed(2));
                    db.run(`UPDATE users SET walletBalance = ? WHERE id = ?`, [newBalance, user.id], () => {
                        console.log(`[FLUTTERWAVE FUNDING SUCCESS] Credited ₦${amountPaid} to user ${user.phone}`);
                    });
                }
            });
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
            db.get(`SELECT walletBalance FROM users WHERE phone = ?`, [targetPhone], (err, row) => {
                if (err || !row) {
                    return res.json({ success: false, message: "User account not found." });
                }

                const newBalance = Number((row.walletBalance + paidAmount).toFixed(2));
                db.run(`UPDATE users SET walletBalance = ? WHERE phone = ?`, [newBalance, targetPhone], (updateErr) => {
                    if (updateErr) {
                        return res.json({ success: false, message: "Failed to credit wallet balance." });
                    }
                    return res.json({
                        success: true,
                        message: `Wallet credited with ₦${paidAmount}!`,
                        newBalance: newBalance
                    });
                });
            });
        } else {
            return res.json({ success: false, message: "Payment could not be verified as successful." });
        }
    } catch (error) {
        console.error("Flutterwave verify error:", error.message, error.response?.data || "");
        return res.json({ success: false, message: "Payment verification failed." });
    }
});

// Endpoint to process data purchase via Bigisub API & SQLite balance update
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

    db.get(`SELECT * FROM users WHERE phone = ?`, [targetPhone], async (err, user) => {
        if (err || !user) {
            return res.json({ success: false, message: "User session not found." });
        }

        if (userPin !== String(user.pin)) {
            return res.json({ success: false, message: "Incorrect transaction PIN." });
        }

        if (user.walletBalance < plan.price) {
            return res.json({ success: false, message: "Insufficient wallet balance. Please fund your wallet." });
        }

        try {
            // Live call to Bigisub v2 Data Purchase API
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
                        'Authorization': `Token ${String(process.env.BIGISUB_TOKEN || '').trim()}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            // Deduct balance and update SQLite database only after successful API call
            const newBalance = Number((user.walletBalance - plan.price).toFixed(2));

            db.run(`UPDATE users SET walletBalance = ? WHERE phone = ?`, [newBalance, targetPhone], (updateErr) => {
                if (updateErr) {
                    return res.json({ success: false, message: "Transaction processing failed." });
                }

                const ref = (bigisubRes.data && (bigisubRes.data.reference || bigisubRes.data.transaction_id)) || 'N/A';
                console.log(
                    `[BIGISUB API SUCCESS] Ref: ${ref} | Network: ${network} | Plan: ${plan.name} | Sold: ₦${plan.price} | Base: ₦${plan.basePrice} | Profit: ₦${plan.profit} | Recipient: ${recipientPhone}`
                );

                res.json({
                    success: true,
                    message: `Successfully delivered ${plan.name} to ${recipientPhone}!`,
                    newBalance: newBalance
                });
            });
        } catch (apiError) {
            console.error("Bigisub API Error:", apiError.message, apiError.response?.data || "");
            const apiMsg = apiError.response?.data && apiError.response.data.message;
            res.json({
                success: false,
                message: apiMsg || "Network gateway error. Please try again later."
            });
        }
    });
});

// Page Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/data', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'data.html'));
});
app.get('/wallet', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'wallet.html'));
});
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.listen(PORT, () => {
    console.log(`USEsub persistent engine running live on port ${PORT}`);
});
                        
