const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios'); // For making secure API calls to Bigisub & Flutterwave
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database
const dbFile = path.join(__dirname, 'usesub.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("Error opening database", err.message);
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

// Active session tracking for current local browser testing
let activeUserPhone = null;

// Data plans with your custom profit markup (+₦100 added on top of base cost)
const localDataPlans = [
    { id: "mtn-1gb", network: "MTN", name: "MTN 1GB SME (1 Month)", price: 400, bigisubCode: "mtn_1gb_sme" },
    { id: "mtn-2gb", network: "MTN", name: "MTN 2GB SME (1 Month)", price: 700, bigisubCode: "mtn_2gb_sme" },
    { id: "airtel-1gb", network: "Airtel", name: "Airtel 1GB Corporate (1 Month)", price: 420, bigisubCode: "airtel_1gb_corp" },
    { id: "glo-1gb", network: "Glo", name: "Glo 1GB Data (1 Month)", price: 380, bigisubCode: "glo_1gb" },
    { id: "9mobile-1gb", network: "9mobile", name: "9mobile 1GB Data (1 Month)", price: 400, bigisubCode: "9mobile_1gb" }
];

// Helper Function: Validate Nigerian Network Prefixes
function isValidNetworkPrefix(network, phone) {
    const prefix = phone.substring(0, 4);

    const mtnPrefixes = ['0803', '0806', '0703', '0706', '0813', '0814', '0816', '0903', '0906', '0913', '0916'];
    const airtelPrefixes = ['0802', '0808', '0708', '0812', '0902', '0901', '0904', '0907', '0912'];
    const gloPrefixes = ['0805', '0807', '0705', '0811', '0707', '0905'];
    const mobile9Prefixes = ['0809', '0817', '0818', '0909'];

    if (network === 'MTN') return mtnPrefixes.some(p => phone.startsWith(p));
    if (network === 'Airtel') return airtelPrefixes.some(p => phone.startsWith(p));
    if (network === 'Glo') return gloPrefixes.some(p => phone.startsWith(p));
    if (network === '9mobile') return mobile9Prefixes.some(p => phone.startsWith(p));
    
    return true; 
}

// Get current session user from database
app.get('/api/user', (req, res) => {
    if (!activeUserPhone) {
        return res.json({ success: false, message: "Not logged in" });
    }

    db.get(`SELECT * FROM users WHERE phone = ?`, [activeUserPhone], (err, row) => {
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

    if (!phone || phone.length < 10 || !pin || pin.length < 4) {
        return res.json({ success: false, message: "Please enter a valid phone number and 4-digit PIN." });
    }

    const verificationCode = Math.floor(1000 + Math.random() * 9000).toString();

    db.get(`SELECT * FROM users WHERE phone = ?`, [phone], (err, row) => {
        if (row) {
            db.run(`UPDATE users SET name = ?, pin = ?, verificationCode = ? WHERE phone = ?`, 
                [name || "User", pin, verificationCode, phone], (updateErr) => {
                    if (updateErr) {
                        return res.json({ success: false, message: "Database update error." });
                    }
                    console.log(`[OTP RESENT] Verification code for ${phone} is: ${verificationCode}`);
                    return res.json({
                        success: true,
                        requiresVerification: true,
                        phone,
                        message: `Verification code sent! (Check server console for code: ${verificationCode})`
                    });
            });
        } else {
            db.run(`INSERT INTO users (name, phone, email, pin, walletBalance, isVerified, verificationCode) VALUES (?, ?, ?, ?, 0, 0, ?)`,
                [name || "User", phone, email || "", pin, verificationCode], (insertErr) => {
                    if (insertErr) {
                        return res.json({ success: false, message: "Error creating user account." });
                    }
                    console.log(`[OTP SENT] Verification code for ${phone} is: ${verificationCode}`);
                    return res.json({
                        success: true,
                        requiresVerification: true,
                        phone,
                        message: `Verification code sent! (Check server console for code: ${verificationCode})`
                    });
            });
        }
    });
});

// Step 2: Verify Phone Number with OTP Code
app.post('/api/verify-otp', (req, res) => {
    const { phone, code } = req.body;

    db.get(`SELECT * FROM users WHERE phone = ?`, [phone], (err, user) => {
        if (err || !user) {
            return res.json({ success: false, message: "User not found." });
        }

        if (user.verificationCode !== code) {
            return res.json({ success: false, message: "Invalid verification code." });
        }

        db.run(`UPDATE users SET isVerified = 1 WHERE phone = ?`, [phone], (updateErr) => {
            if (updateErr) {
                return res.json({ success: false, message: "Verification state error." });
            }
            activeUserPhone = phone; 
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

// Endpoint for frontend to fetch plans
app.get('/api/data-plans', (req, res) => {
    res.json({ success: true, plans: localDataPlans });
});

// Endpoint to fund wallet manually (or test)
app.post('/api/fund-wallet', (req, res) => {
    if (!activeUserPhone) {
        return res.json({ success: false, message: "Please log in first." });
    }

    const { amount } = req.body;
    const addAmount = parseFloat(amount);

    if (!addAmount || addAmount <= 0) {
        return res.json({ success: false, message: "Enter a valid funding amount." });
    }

    db.get(`SELECT walletBalance FROM users WHERE phone = ?`, [activeUserPhone], (err, row) => {
        if (err || !row) {
            return res.json({ success: false, message: "User session not found." });
        }

        const newBalance = row.walletBalance + addAmount;

        db.run(`UPDATE users SET walletBalance = ? WHERE phone = ?`, [newBalance, activeUserPhone], (updateErr) => {
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
    const flutterwaveSignature = req.headers['verif-hash'];
    // In production, verify flutterwaveSignature matches your secret hash

    const event = req.body;
    if (event && event.event === 'charge.completed' && event.data.status === 'successful') {
        const customerEmail = event.data.customer.email;
        const amountPaid = event.data.amount;

        db.get(`SELECT * FROM users WHERE email = ? OR phone = ?`, [customerEmail, customerEmail], (err, user) => {
            if (user) {
                const newBalance = user.walletBalance + amountPaid;
                db.run(`UPDATE users SET walletBalance = ? WHERE id = ?`, [newBalance, user.id], () => {
                    console.log(`[FLUTTERWAVE FUNDING SUCCESS] Credited ₦${amountPaid} to user ${user.phone}`);
                });
            }
        });
    }
    res.sendStatus(200);
});

// Endpoint to process data purchase via Bigisub API & SQLite balance update
app.post('/api/buy-data', async (req, res) => {
    if (!activeUserPhone) {
        return res.json({ success: false, message: "Please log in first." });
    }

    const { network, planId, phone, pin } = req.body;

    const plan = localDataPlans.find(p => p.id === planId);
    if (!plan) {
        return res.json({ success: false, message: "Invalid data plan selected." });
    }

    if (!phone || phone.length < 10) {
        return res.json({ success: false, message: "Please enter a valid recipient phone number." });
    }

    if (!isValidNetworkPrefix(network, phone)) {
        return res.json({ success: false, message: `Invalid phone number prefix for ${network}. Please check the number.` });
    }

    db.get(`SELECT * FROM users WHERE phone = ?`, [activeUserPhone], async (err, user) => {
        if (err || !user) {
            return res.json({ success: false, message: "User session not found." });
        }

        if (pin !== user.pin) {
            return res.json({ success: false, message: "Incorrect transaction PIN." });
        }

        if (user.walletBalance < plan.price) {
            return res.json({ success: false, message: "Insufficient wallet balance. Please fund your wallet." });
        }

        try {
            // Live call to Bigisub API (Base URL: https://api.bigisub.ng)
            const bigisubResponse = await axios.post('https://api.bigisub.ng/api/v2/data/', {
                network: network.toLowerCase(),
                plan: plan.bigisubCode,
                phone: phone,
                pin: user.pin
            }, {
                headers: { 'Authorization': `Token ${process.env.BIGISUB_TOKEN}` }
            });

            // Deduct balance and update SQLite database only after successful API call
            const newBalance = user.walletBalance - plan.price;

            db.run(`UPDATE users SET walletBalance = ? WHERE phone = ?`, [newBalance, activeUserPhone], (updateErr) => {
                if (updateErr) {
                    return res.json({ success: false, message: "Transaction processing failed." });
                }

                console.log(`[BIGISUB API SUCCESS] Network: ${network}, Plan: ${plan.name}, Price: ₦${plan.price}, Recipient: ${phone}`);
                
                res.json({ 
                    success: true, 
                    message: `Successfully delivered ${plan.name} to ${phone}!`,
                    newBalance: newBalance
                });
            });

        } catch (apiError) {
            console.error("Bigisub API Error:", apiError.message);
            res.json({ success: false, message: "Network gateway error. Please try again later." });
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
