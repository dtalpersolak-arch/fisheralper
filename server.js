// ============================================================================
// BURNAZ SAHİL & DÖRTYOL - 2.5D İZOMETRİK MMO OYUNU SUNUCUSU (Node.js & Socket.io)
// Railway & Yerel Çalıştırma Desteği ile Tam Uyumlu
// ============================================================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'burnaz_mmo_secret_jwt_2026_super_secure';
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'burak').toLowerCase();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

// file:/// ve cross-origin için açık başlık garantisi
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================================
// ÇİFT MODLU VERİTABANI YÖNETİMİ (PostgreSQL VEYA Dosya Tabanlı JSON Depolama)
// ============================================================================
let dbMode = 'json';
let pgPool = null;

// JSON Deposu Yolu (data/db.json)
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let jsonDb = {
    users: [],
    characters: {},
    marketListings: [],
    guilds: {},
    gameConfigs: {}
};

function initJsonDb() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            jsonDb = JSON.parse(raw);
            if (!jsonDb.users) jsonDb.users = [];
            if (!jsonDb.characters) jsonDb.characters = {};
            if (!jsonDb.marketListings) jsonDb.marketListings = [];
            if (!jsonDb.guilds) jsonDb.guilds = {};
            if (!jsonDb.gameConfigs) jsonDb.gameConfigs = {};
        } catch (e) {
            console.error('JSON DB yüklenirken hata oluştu, varsayılan oluşturuluyor:', e);
        }
    } else {
        saveJsonDb();
    }
}

let saveTimeout = null;
function saveJsonDb(immediate = false) {
    const doWrite = () => {
        try {
            if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(DB_FILE, JSON.stringify(jsonDb, null, 2), 'utf8');
        } catch (e) {
            console.error('JSON DB kaydedilemedi:', e);
        }
    };

    if (immediate) {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }
        doWrite();
        return;
    }

    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(doWrite, 150);
}

// PostgreSQL Bağlantısı (Railway DATABASE_URL varsa)
async function initDatabase() {
    if (process.env.DATABASE_URL) {
        try {
            const { Pool } = require('pg');
            pgPool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
            });

            pgPool.on('error', (err) => {
                console.error('⚠️ PostgreSQL havuz bağlantı uyarısı (boşta bağlantı düştü):', err.message);
            });

            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(50) UNIQUE NOT NULL,
                    email VARCHAR(100) UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    role VARCHAR(20) DEFAULT 'player',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS characters (
                    id SERIAL PRIMARY KEY,
                    user_id INT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                    name VARCHAR(50) UNIQUE NOT NULL,
                    data JSONB NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS market_listings (
                    id VARCHAR(100) PRIMARY KEY,
                    user_id INT REFERENCES users(id) ON DELETE CASCADE,
                    data JSONB NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS game_configs (
                    key VARCHAR(100) PRIMARY KEY,
                    value JSONB NOT NULL
                );
            `);
            dbMode = 'postgres';
            console.log('✅ PostgreSQL veritabanı başarıyla bağlandı ve tablolar hazırlandı.');
            return;
        } catch (err) {
            console.warn('⚠️ PostgreSQL bağlantısı başarısız, JSON DB moduna geçiliyor:', err.message);
        }
    }

    dbMode = 'json';
    initJsonDb();
    console.log('📂 Yerel / Bağımsız JSON Veritabanı devrede (data/db.json).');
}

// Veritabanı Yardımcı Fonksiyonları
const DB = {
    async findUserByUsernameOrEmail(identifier) {
        if (!identifier) return null;
        const lower = identifier.trim().toLowerCase();
        if (dbMode === 'postgres') {
            const res = await pgPool.query(
                'SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1',
                [lower]
            );
            return res.rows[0] || null;
        } else {
            return jsonDb.users.find(u => 
                (u.username && u.username.toLowerCase() === lower) || 
                (u.email && u.email.toLowerCase() === lower)
            ) || null;
        }
    },

    async findUserById(id) {
        if (dbMode === 'postgres') {
            const res = await pgPool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
            return res.rows[0] || null;
        } else {
            return jsonDb.users.find(u => u.id === id) || null;
        }
    },

    async getUserCount() {
        if (dbMode === 'postgres') {
            const res = await pgPool.query('SELECT COUNT(*) FROM users');
            return parseInt(res.rows[0].count, 10);
        } else {
            return jsonDb.users.length;
        }
    },

    async createUser(username, email, passwordHash, role) {
        if (dbMode === 'postgres') {
            const res = await pgPool.query(
                'INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *',
                [username, email, passwordHash, role]
            );
            return res.rows[0];
        } else {
            const newUser = {
                id: Date.now() + Math.floor(Math.random() * 1000),
                username,
                email,
                password_hash: passwordHash,
                role,
                created_at: new Date().toISOString()
            };
            jsonDb.users.push(newUser);
            saveJsonDb(true);
            return newUser;
        }
    },

    async getCharacterByUserId(userId) {
        if (dbMode === 'postgres') {
            const res = await pgPool.query('SELECT * FROM characters WHERE user_id = $1 LIMIT 1', [userId]);
            if (!res.rows[0]) return null;
            let parsedData = res.rows[0].data;
            if (typeof parsedData === 'string') {
                try { parsedData = JSON.parse(parsedData); } catch(e) {}
            }
            return {
                id: res.rows[0].id,
                userId: res.rows[0].user_id,
                name: res.rows[0].name,
                ...(parsedData || {})
            };
        } else {
            const char = jsonDb.characters[userId];
            return char || null;
        }
    },

    async isCharacterNameTaken(name, excludeUserId = null) {
        const lower = name.trim().toLowerCase();
        if (dbMode === 'postgres') {
            const res = await pgPool.query(
                'SELECT user_id FROM characters WHERE LOWER(name) = $1 LIMIT 1',
                [lower]
            );
            if (res.rows.length === 0) return false;
            return excludeUserId ? res.rows[0].user_id !== excludeUserId : true;
        } else {
            for (const [uId, char] of Object.entries(jsonDb.characters)) {
                if (char && char.name && char.name.toLowerCase() === lower) {
                    if (excludeUserId && parseInt(uId, 10) === parseInt(excludeUserId, 10)) continue;
                    return true;
                }
            }
            return false;
        }
    },

    async saveCharacter(userId, characterData) {
        const charName = characterData.name;
        if (dbMode === 'postgres') {
            await pgPool.query(`
                INSERT INTO characters (user_id, name, data, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (user_id) DO UPDATE
                SET name = $2, data = $3, updated_at = NOW()
            `, [userId, charName, JSON.stringify(characterData)]);
        } else {
            jsonDb.characters[userId] = {
                userId,
                name: charName,
                ...characterData,
                updated_at: new Date().toISOString()
            };
            saveJsonDb(true);
        }
        return true;
    },

    async getMarketListings() {
        if (dbMode === 'postgres') {
            const res = await pgPool.query('SELECT * FROM market_listings ORDER BY created_at DESC');
            return res.rows
                .map(r => ({ id: r.id, userId: r.user_id, ...r.data }))
                .filter(item => item && (!item.id || (!item.id.startsWith('list_seed_') && item.isPlayerListing !== false)));
        } else {
            return (jsonDb.marketListings || []).filter(item => item && (!item.id || (!item.id.startsWith('list_seed_') && item.isPlayerListing !== false)));
        }
    },

    async addMarketListing(item) {
        if (dbMode === 'postgres') {
            await pgPool.query(
                'INSERT INTO market_listings (id, user_id, data) VALUES ($1, $2, $3)',
                [item.id, item.sellerUserId || null, JSON.stringify(item)]
            );
        } else {
            if (!jsonDb.marketListings) jsonDb.marketListings = [];
            // Demo eşyaları temizle ve yeniyi ekle
            jsonDb.marketListings = jsonDb.marketListings.filter(l => !l.id || (!l.id.startsWith('list_seed_') && l.isPlayerListing !== false));
            jsonDb.marketListings.unshift(item);
            saveJsonDb();
        }
    },

    async removeMarketListing(listingId) {
        if (dbMode === 'postgres') {
            await pgPool.query('DELETE FROM market_listings WHERE id = $1', [listingId]);
        } else {
            if (!jsonDb.marketListings) jsonDb.marketListings = [];
            jsonDb.marketListings = jsonDb.marketListings.filter(l => l.id !== listingId);
            saveJsonDb();
        }
    },

    async findMarketListing(listingId) {
        const all = await this.getMarketListings();
        return all.find(l => l.id === listingId) || null;
    },

    async getAllGuilds() {
        if (dbMode === 'postgres') {
            const res = await pgPool.query("SELECT value FROM game_configs WHERE key = 'guilds'");
            return res.rows[0]?.value || {};
        } else {
            return jsonDb.guilds || {};
        }
    },

    async getGuild(name) {
        const all = await this.getAllGuilds();
        return all[name] || null;
    },

    async saveGuild(name, guildData) {
        if (dbMode === 'postgres') {
            const current = await this.getAllGuilds();
            current[name] = guildData;
            await pgPool.query(
                "INSERT INTO game_configs (key, value) VALUES ('guilds', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify(current)]
            );
        } else {
            if (!jsonDb.guilds) jsonDb.guilds = {};
            jsonDb.guilds[name] = guildData;
            saveJsonDb(true);
        }
    },

    async deleteGuild(name) {
        if (dbMode === 'postgres') {
            const current = await this.getAllGuilds();
            delete current[name];
            await pgPool.query(
                "INSERT INTO game_configs (key, value) VALUES ('guilds', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify(current)]
            );
        } else {
            if (!jsonDb.guilds) jsonDb.guilds = {};
            delete jsonDb.guilds[name];
            saveJsonDb(true);
        }
    },

    async updateCharacterGold(charName, goldDelta) {
        if (!charName || !goldDelta) return;
        if (dbMode === 'postgres') {
            const res = await pgPool.query('SELECT user_id, data FROM characters WHERE LOWER(name) = $1 LIMIT 1', [charName.toLowerCase()]);
            if (res.rows.length > 0) {
                const row = res.rows[0];
                const charData = row.data;
                charData.gold = Math.max(0, (charData.gold || 0) + goldDelta);
                await pgPool.query('UPDATE characters SET data = $1, updated_at = NOW() WHERE user_id = $2', [JSON.stringify(charData), row.user_id]);
            }
        } else {
            for (const [uId, char] of Object.entries(jsonDb.characters)) {
                if (char && char.name && char.name.toLowerCase() === charName.toLowerCase()) {
                    char.gold = Math.max(0, (char.gold || 0) + goldDelta);
                    saveJsonDb(true);
                    break;
                }
            }
        }
    },

    async getGlobalConfig() {
        if (dbMode === 'postgres') {
            const res = await pgPool.query("SELECT value FROM game_configs WHERE key = 'global_config'");
            return res.rows[0]?.value || null;
        } else {
            return (jsonDb.gameConfigs && jsonDb.gameConfigs['global_config']) || null;
        }
    },

    async saveGlobalConfig(config) {
        if (dbMode === 'postgres') {
            await pgPool.query(
                "INSERT INTO game_configs (key, value) VALUES ('global_config', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
                [JSON.stringify(config)]
            );
        } else {
            if (!jsonDb.gameConfigs) jsonDb.gameConfigs = {};
            jsonDb.gameConfigs['global_config'] = config;
            saveJsonDb(true);
        }
    },

    async saveMarketListings(listings) {
        if (dbMode === 'postgres') {
            await pgPool.query('DELETE FROM market_listings');
            for (const item of listings) {
                await pgPool.query(
                    'INSERT INTO market_listings (id, user_id, data) VALUES ($1, $2, $3)',
                    [item.id, item.sellerUserId || null, JSON.stringify(item)]
                );
            }
        } else {
            jsonDb.marketListings = listings;
            saveJsonDb();
        }
    }
};

// ============================================================================
// AUTH MIDDLEWARE (JWT Doğrulama)
// ============================================================================
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Oturum açmanız gerekiyor (Yetkisiz erişim).' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Geçersiz veya süresi dolmuş oturum belirteci.' });
    }
}

// ============================================================================
// REST API ENDPOINT'LERİ (Üyelik, Giriş, Karakter, Pazar)
// ============================================================================

// 1. ÜYE OL (Kayıt)
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ success: false, message: 'Kullanıcı adı, e-posta ve şifre zorunludur!' });
        }

        const cleanUsername = username.trim();
        const cleanEmail = email.trim().toLowerCase();

        if (cleanUsername.length < 3 || cleanUsername.length > 16) {
            return res.status(400).json({ success: false, message: 'Kullanıcı adı 3 ile 16 karakter arasında olmalıdır!' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(cleanEmail)) {
            return res.status(400).json({ success: false, message: 'Lütfen geçerli bir e-posta adresi girin!' });
        }

        if (password.length < 4) {
            return res.status(400).json({ success: false, message: 'Şifreniz en az 4 karakterden oluşmalıdır!' });
        }

        // Kullanıcı adı veya e-posta zaten var mı?
        const existing = await DB.findUserByUsernameOrEmail(cleanUsername);
        if (existing) {
            if (existing.username.toLowerCase() === cleanUsername.toLowerCase()) {
                return res.status(400).json({ success: false, message: 'Bu kullanıcı adı zaten alınmış!' });
            }
            return res.status(400).json({ success: false, message: 'Bu e-posta adresi ile zaten bir hesap var!' });
        }

        const existingEmail = await DB.findUserByUsernameOrEmail(cleanEmail);
        if (existingEmail) {
            return res.status(400).json({ success: false, message: 'Bu e-posta adresi zaten kullanımda!' });
        }

        // Şifreyi tuzla ve şifrele
        const salt = bcrypt.genSaltSync(10);
        const passwordHash = bcrypt.hashSync(password, salt);

        // Rol Belirleme: İlk kayıt olan kullanıcı VEYA ADMIN_USERNAME ile eşleşen 'admin' (GM) olur!
        const totalUsers = await DB.getUserCount();
        const isMasterAdmin = (cleanUsername.toLowerCase() === ADMIN_USERNAME) || (totalUsers === 0);
        const role = isMasterAdmin ? 'admin' : 'player';

        const user = await DB.createUser(cleanUsername, cleanEmail, passwordHash, role);

        // JWT Token oluştur
        const token = jwt.sign(
            { id: user.id, username: user.username, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            message: isMasterAdmin ? '👑 Tebrikler! Yönetici (GM) hesabı ile kaydoldunuz.' : '🎉 Hesabınız başarıyla oluşturuldu!',
            token,
            user: { id: user.id, username: user.username, email: user.email, role: user.role },
            character: null
        });
    } catch (err) {
        console.error('Kayıt hatası:', err);
        res.status(500).json({ success: false, message: 'Sunucu hatası oluştu, lütfen tekrar deneyin.' });
    }
});

// 2. GİRİŞ YAP
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Lütfen kullanıcı adı/e-posta ve şifrenizi girin!' });
        }

        const user = await DB.findUserByUsernameOrEmail(username.trim());
        if (!user) {
            return res.status(400).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı!' });
        }

        if (!user.password_hash) {
            return res.status(400).json({ success: false, message: 'Hesap şifresi doğrulanamadı!' });
        }

        const match = bcrypt.compareSync(password, user.password_hash);
        if (!match) {
            return res.status(400).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı!' });
        }

        // Kullanıcının kayıtlı karakterini çek
        const character = await DB.getCharacterByUserId(user.id);

        const token = jwt.sign(
            { id: user.id, username: user.username, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            success: true,
            message: `Hoş geldin, ${user.username}!`,
            token,
            user: { id: user.id, username: user.username, email: user.email, role: user.role },
            character: character || null
        });
    } catch (err) {
        console.error('Giriş hatası:', err);
        res.status(500).json({ success: false, message: 'Giriş yapılırken sunucu hatası oluştu.' });
    }
});

// 3. MEVCUT OTURUM BİLGİSİNİ AL (Token Kontrolü)
app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const user = await DB.findUserById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı.' });
        }

        const character = await DB.getCharacterByUserId(user.id);
        res.json({
            success: true,
            user: { id: user.id, username: user.username, email: user.email, role: user.role },
            character: character || null
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Oturum doğrulanamadı.' });
    }
});

// 4. İLK KARAKTERİ OLUŞTUR
app.post('/api/character/create', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || name.trim().length < 2 || name.trim().length > 16) {
            return res.status(400).json({ success: false, message: 'Karakter adı 2 ile 16 karakter arasında olmalıdır!' });
        }

        const cleanName = name.trim();

        // Kullanıcının zaten bir karakteri var mı?
        const existingChar = await DB.getCharacterByUserId(req.user.id);
        if (existingChar) {
            return res.status(400).json({ success: false, message: 'Bu hesapta zaten bir karakter mevcut!' });
        }

        // Karakter adı dünyada başka biri tarafından alınmış mı?
        const isTaken = await DB.isCharacterNameTaken(cleanName);
        if (isTaken) {
            return res.status(400).json({ success: false, message: 'Bu karakter adı başka bir oyuncu tarafından kullanılıyor!' });
        }

        // Varsayılan Başlangıç Karakter Verisi
        const initialCharacterData = {
            name: cleanName,
            level: 1,
            exp: 0,
            gold: 250,
            skillPoints: 0,
            x: 13.5,
            y: 11.5,
            mapId: 'burnaz_sahil',
            guildName: '',
            ownedBoats: [],
            activeBoatId: 'boat_raft',
            skills: {
                burak_tactics: 0,
                talha_luck: 0,
                duran_beret: 0,
                chef_gusto_mastery: 0,
                carpenter_wisdom: 0,
                anvil_patron: 0,
                fisherman_prayer: 0
            },
            equipped: {
                rod: 'rod_bamboo',
                rodUid: 'init_rod_1',
                bait: 'bait_worm',
                costume: 'costume_fisher',
                costumeUid: 'init_costume_1'
            },
            rodEnchants: {
                rod_bamboo: { count: 0, luck: 0, speed: 0, control: 0 },
                rod_oak: { count: 0, luck: 0, speed: 0, control: 0 },
                rod_carbon: { count: 0, luck: 0, speed: 0, control: 0 },
                rod_dragon: { count: 0, luck: 0, speed: 0, control: 0 }
            },
            costumeEnchants: {},
            buffs: [],
            inventory: [
                { uid: 'init_rod_1', id: 'rod_bamboo', count: 1, enchants: { count: 0, luck: 0, speed: 0, control: 0 } },
                { id: 'bait_worm', count: 15 },
                { uid: 'init_costume_1', id: 'costume_fisher', count: 1, enchants: { count: 0, luck: 0, speed: 0, control: 0 } },
                { uid: 'init_costume_2', id: 'costume_pirate', count: 1, enchants: { count: 0, luck: 0, speed: 0, control: 0 } },
                { uid: 'init_costume_3', id: 'costume_explorer', count: 1, enchants: { count: 0, luck: 0, speed: 0, control: 0 } },
                { id: 'fish_perch', count: 2 },
                { id: 'fish_koi', count: 1 }
            ],
            storage: [
                new Array(24).fill(null),
                new Array(24).fill(null)
            ]
        };

        await DB.saveCharacter(req.user.id, initialCharacterData);

        res.json({
            success: true,
            message: `🎉 [${cleanName}] başarıyla oluşturuldu! Dünyaya adım atılıyor...`,
            character: initialCharacterData
        });
    } catch (err) {
        console.error('Karakter oluşturma hatası:', err);
        res.status(500).json({ success: false, message: 'Karakter oluşturulurken hata meydana geldi.' });
    }
});

// 5. KARAKTER İLERLEMESİNİ BULUTA KAYDET
app.post('/api/character/save', authMiddleware, async (req, res) => {
    try {
        const { characterData } = req.body;
        if (!characterData || !characterData.name) {
            return res.status(400).json({ success: false, message: 'Geçersiz karakter verisi!' });
        }

        await DB.saveCharacter(req.user.id, characterData);
        res.json({ success: true, message: 'Karakter kaydedildi.' });
    } catch (err) {
        console.error('Karakter kaydetme hatası:', err);
        res.status(500).json({ success: false, message: 'Karakter kaydedilemedi.' });
    }
});

// 6. DÖRTYOL PAZAR YERİ LİSTELEME & İŞLEMLER
app.get('/api/market', async (req, res) => {
    try {
        const listings = await DB.getMarketListings();
        res.json({ success: true, listings });
    } catch (err) {
        res.status(500).json({ success: false, listings: [] });
    }
});

app.post('/api/market/add', authMiddleware, async (req, res) => {
    try {
        const listing = req.body;
        if (!listing || !listing.id || !listing.itemId || !listing.totalPrice) {
            return res.status(400).json({ success: false, message: 'Geçersiz ilan verisi.' });
        }
        listing.sellerUserId = req.user.id;
        listing.sellerName = req.user.username;
        listing.isPlayerListing = true;
        await DB.addMarketListing(listing);
        io.emit('market_listing_added', listing);
        res.json({ success: true, listing });
    } catch (err) {
        res.status(500).json({ success: false, message: 'İlan pazara eklenemedi.' });
    }
});

// 7. LONCA LİSTESİ API
app.get('/api/guilds', async (req, res) => {
    try {
        const allGuilds = await DB.getAllGuilds();
        const list = Object.values(allGuilds).map(g => ({
            name: g.name,
            leader: g.leader,
            level: g.level || 1,
            exp: g.exp || 0,
            createdDate: g.createdDate || '',
            memberCount: (g.members || []).length,
            applicationCount: (g.applications || []).length
        }));
        res.json({ success: true, guilds: list });
    } catch (err) {
        res.status(500).json({ success: false, guilds: [] });
    }
});

// 8. OYUN GLOBAL AYARLARI (GM Ayarları Senkronizasyonu)
app.get('/api/config', async (req, res) => {
    try {
        const config = await DB.getGlobalConfig();
        res.json({ success: true, config });
    } catch (err) {
        res.status(500).json({ success: false, config: null });
    }
});

// 7. SUNUCU DURUMU (Ping / Health)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/api/status', (req, res) => {
    res.json({
        online: true,
        status: 'online',
        game: 'Burnaz Sahil & Dörtyol MMO',
        version: '2.0.0',
        dbMode,
        onlinePlayers: Object.keys(onlinePlayers).length,
        uptime: Math.floor(process.uptime())
    });
});

// ============================================================================
// STATİK DOSYA SUNUMU (Frontend)
// ============================================================================
app.use(express.static(path.join(__dirname)));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================================
// REAL-TIME MULTIPLAYER WEBSOCKET (SOCKET.IO)
// Haritalar Arası Oyuncu Senkronizasyonu & Canlı Sohbet
// ============================================================================
const onlinePlayers = {};

io.on('connection', (socket) => {
    // 1. Oyuncu Dünyaya Katıldı
    socket.on('player_join', (data) => {
        const { token, charName, x, y, mapId, costume, boatId, level, guildName } = data;
        let userId = null;
        let role = 'player';

        if (token) {
            try {
                const dec = jwt.verify(token, JWT_SECRET);
                userId = dec.id;
                role = dec.role || 'player';
            } catch (e) {}
        }

        function normalizeServerMap(m) {
            if (!m || m === 'burnaz') return 'burnaz_sahil';
            return m;
        }

        const safeMap = normalizeServerMap(mapId);
        onlinePlayers[socket.id] = {
            socketId: socket.id,
            userId,
            name: charName || 'Gezgin',
            level: level || 1,
            role,
            x: Number(x) || 13.5,
            y: Number(y) || 11.5,
            dirX: 1,
            dirY: 0,
            isMoving: false,
            mapId: safeMap,
            costume: costume || 'costume_fisher',
            boatId: boatId || null,
            guildName: guildName || '',
            isFishing: false
        };

        socket.join(`map_${safeMap}`);

        // O haritada bulunan diğer oyuncuları bu oyuncuya gönder
        const peers = Object.values(onlinePlayers).filter(p => p.mapId === safeMap && p.socketId !== socket.id);
        socket.emit('map_peers', peers);

        // Diğer oyunculara bu oyuncunun geldiğini bildir
        socket.to(`map_${safeMap}`).emit('player_joined', onlinePlayers[socket.id]);

        // Genel çevrimiçi sayısını güncelle
        io.emit('online_count', Object.keys(onlinePlayers).length);

        // Oyuncunun loncası varsa, sunucudaki en güncel lonca verisini gönder (Destroyer & Kraken senkronizasyonu)
        if (guildName) {
            DB.getGuild(guildName).then(g => {
                if (g) socket.emit('guild_data_updated', g);
            }).catch(() => {});
        }

        // Sunucuda kayıtlı global GM oyun ayarları varsa oyuncuya anında gönder
        DB.getGlobalConfig().then(cfg => {
            if (cfg) socket.emit('game_config_sync', cfg);
        }).catch(() => {});
    });

    // 2. Oyuncu Hareketi (Anlık Pozisyon & Yön Güncellemesi)
    socket.on('player_move', (data) => {
        const p = onlinePlayers[socket.id];
        if (!p) return;

        p.x = Number(data.x);
        p.y = Number(data.y);
        p.dirX = Number(data.dirX || 1);
        p.dirY = Number(data.dirY || 0);
        p.isMoving = Boolean(data.isMoving);
        if (data.costume) p.costume = data.costume;
        if (data.boatId !== undefined) p.boatId = data.boatId;
        if (data.guildName !== undefined) p.guildName = data.guildName;

        socket.to(`map_${p.mapId}`).emit('player_moved', {
            socketId: socket.id,
            x: p.x,
            y: p.y,
            dirX: p.dirX,
            dirY: p.dirY,
            isMoving: p.isMoving,
            costume: p.costume,
            boatId: p.boatId,
            guildName: p.guildName
        });
    });

    // 2.1 Oyuncu Profil Güncellemesi (Lonca, Kostüm, Seviye)
    socket.on('player_update_profile', (data) => {
        const p = onlinePlayers[socket.id];
        if (!p) return;
        if (data.guildName !== undefined) p.guildName = data.guildName;
        if (data.costume !== undefined) p.costume = data.costume;
        if (data.level !== undefined) p.level = data.level;
        if (data.boatId !== undefined) p.boatId = data.boatId;

        socket.to(`map_${p.mapId}`).emit('player_profile_updated', {
            socketId: socket.id,
            guildName: p.guildName,
            costume: p.costume,
            level: p.level,
            boatId: p.boatId
        });
    });

    // ========================================================================
    // PAZAR / AUCTION HOUSE CANLI SENKRONİZASYONU
    // ========================================================================
    socket.on('market_get_listings', async () => {
        const listings = await DB.getMarketListings();
        socket.emit('market_sync', listings);
    });

    socket.on('market_add_listing', async (listing) => {
        if (!listing || !listing.id) return;
        listing.isPlayerListing = true;
        const p = onlinePlayers[socket.id];
        if (p && !listing.sellerUserId && p.userId) {
            listing.sellerUserId = p.userId;
        }
        await DB.addMarketListing(listing);
        io.emit('market_listing_added', listing);
    });

    socket.on('market_buy_listing', async (data) => {
        const { listingId, buyerName } = data || {};
        if (!listingId) return;

        const listing = await DB.findMarketListing(listingId);
        if (!listing) {
            socket.emit('market_buy_error', { message: 'Bu ilan başka bir oyuncu tarafından satın alınmış veya kaldırılmış!' });
            return;
        }

        await DB.removeMarketListing(listingId);
        io.emit('market_listing_removed', listingId);

        // Satıcıya altın aktarımı ve bildirim
        if (listing.sellerName) {
            await DB.updateCharacterGold(listing.sellerName, listing.totalPrice);
            // Satıcı şu an online mı?
            const sellerSocketEntry = Object.entries(onlinePlayers).find(([sId, pl]) => pl.name === listing.sellerName);
            if (sellerSocketEntry) {
                io.to(sellerSocketEntry[0]).emit('market_item_sold', {
                    itemId: listing.itemId,
                    count: listing.count,
                    totalPrice: listing.totalPrice,
                    buyerName: buyerName || 'Bir Oyuncu'
                });
            }
        }

        socket.emit('market_buy_success', { listingId, listing });
    });

    socket.on('market_cancel_listing', async (data) => {
        const { listingId, sellerName } = data || {};
        if (!listingId) return;
        const listing = await DB.findMarketListing(listingId);
        if (!listing) return;

        await DB.removeMarketListing(listingId);
        io.emit('market_listing_removed', listingId);
        socket.emit('market_cancel_success', { listingId, listing });
    });

    // ========================================================================
    // LONCA SİSTEMİ & BAŞVURU SENKRONİZASYONU
    // ========================================================================
    socket.on('guild_get_list', async () => {
        const allGuilds = await DB.getAllGuilds();
        const list = Object.values(allGuilds).map(g => ({
            name: g.name,
            leader: g.leader,
            level: g.level || 1,
            exp: g.exp || 0,
            createdDate: g.createdDate || '',
            members: g.members || [],
            applications: g.applications || []
        }));
        socket.emit('guild_list_response', list);
    });

    socket.on('guild_create', async (guildData) => {
        if (!guildData || !guildData.name) return;
        guildData.applications = guildData.applications || [];
        await DB.saveGuild(guildData.name, guildData);

        const p = onlinePlayers[socket.id];
        if (p) {
            p.guildName = guildData.name;
            socket.to(`map_${p.mapId}`).emit('player_profile_updated', {
                socketId: socket.id,
                guildName: p.guildName
            });
        }
        io.emit('guild_list_updated');
    });

    socket.on('guild_apply', async (data) => {
        const { guildName, applicantName, applicantLevel } = data || {};
        if (!guildName || !applicantName) return;

        const guild = await DB.getGuild(guildName);
        if (!guild) {
            socket.emit('guild_apply_error', { message: 'Lonca bulunamadı!' });
            return;
        }

        guild.applications = guild.applications || [];
        const alreadyApplied = guild.applications.some(a => a.name.toLowerCase() === applicantName.toLowerCase());
        const alreadyMember = (guild.members || []).some(m => m.name.toLowerCase() === applicantName.toLowerCase());

        if (alreadyApplied) {
            socket.emit('guild_apply_error', { message: 'Bu loncaya zaten başvurunuz bulunuyor!' });
            return;
        }
        if (alreadyMember) {
            socket.emit('guild_apply_error', { message: 'Zaten bu loncanın üyesisiniz!' });
            return;
        }

        const newApp = {
            name: applicantName,
            level: applicantLevel || 1,
            date: new Date().toLocaleDateString('tr-TR')
        };
        guild.applications.push(newApp);
        await DB.saveGuild(guildName, guild);

        socket.emit('guild_apply_success', { guildName, application: newApp });

        // Lidere anlık bildirim (Online ise)
        const leaderEntry = Object.entries(onlinePlayers).find(([sId, pl]) => pl.name === guild.leader);
        if (leaderEntry) {
            io.to(leaderEntry[0]).emit('guild_new_application', {
                guildName,
                applicant: newApp,
                applications: guild.applications
            });
        }
    });

    socket.on('guild_approve_applicant', async (data) => {
        const { guildName, applicantName } = data || {};
        if (!guildName || !applicantName) return;

        const guild = await DB.getGuild(guildName);
        if (!guild) return;

        guild.applications = (guild.applications || []).filter(a => a.name.toLowerCase() !== applicantName.toLowerCase());
        guild.members = guild.members || [];
        if (!guild.members.some(m => m.name.toLowerCase() === applicantName.toLowerCase())) {
            guild.members.push({
                name: applicantName,
                level: 1,
                role: 'Üye',
                online: true
            });
        }
        await DB.saveGuild(guildName, guild);

        // Lidere güncel lonca verisini gönder
        socket.emit('guild_data_updated', guild);

        // Başvuran oyuncu online ise ona katılma müjdesini ver
        const appEntry = Object.entries(onlinePlayers).find(([sId, pl]) => pl.name.toLowerCase() === applicantName.toLowerCase());
        if (appEntry) {
            const appSocketId = appEntry[0];
            onlinePlayers[appSocketId].guildName = guildName;
            io.to(appSocketId).emit('guild_application_approved', {
                guildName,
                guild
            });
            socket.to(`map_${onlinePlayers[appSocketId].mapId}`).emit('player_profile_updated', {
                socketId: appSocketId,
                guildName: guildName
            });
        }
    });

    socket.on('guild_reject_applicant', async (data) => {
        const { guildName, applicantName } = data || {};
        if (!guildName || !applicantName) return;

        const guild = await DB.getGuild(guildName);
        if (!guild) return;

        guild.applications = (guild.applications || []).filter(a => a.name.toLowerCase() !== applicantName.toLowerCase());
        await DB.saveGuild(guildName, guild);

        socket.emit('guild_data_updated', guild);

        const appEntry = Object.entries(onlinePlayers).find(([sId, pl]) => pl.name.toLowerCase() === applicantName.toLowerCase());
        if (appEntry) {
            io.to(appEntry[0]).emit('guild_application_rejected', { guildName });
        }
    });

    socket.on('guild_leave', async (data) => {
        const { guildName, memberName } = data || {};
        const p = onlinePlayers[socket.id];
        const nameToLeave = memberName || (p ? p.name : '');
        if (!guildName || !nameToLeave) return;

        const guild = await DB.getGuild(guildName);
        if (guild && guild.members) {
            guild.members = guild.members.filter(m => m.name.toLowerCase() !== nameToLeave.toLowerCase());
            await DB.saveGuild(guildName, guild);
        }

        if (p) {
            p.guildName = '';
            socket.to(`map_${p.mapId}`).emit('player_profile_updated', {
                socketId: socket.id,
                guildName: ''
            });
        }
    });

    socket.on('guild_buy_destroyer', async (data) => {
        const { guildName } = data || {};
        if (!guildName) return;
        const guild = await DB.getGuild(guildName);
        if (guild) {
            guild.hasDestroyer = true;
            await DB.saveGuild(guildName, guild);
            for (const [sId, pl] of Object.entries(onlinePlayers)) {
                if (pl.guildName && pl.guildName.toLowerCase() === guildName.toLowerCase()) {
                    io.to(sId).emit('guild_data_updated', guild);
                }
            }
        }
    });

    socket.on('guild_start_kraken_raid', async (data) => {
        const { guildName, leaderName } = data || {};
        if (!guildName) return;
        const guild = await DB.getGuild(guildName);
        if (guild) {
            guild.krakenActive = true;
            guild.hasDestroyer = true;
            await DB.saveGuild(guildName, guild);
        }
        for (const [sId, pl] of Object.entries(onlinePlayers)) {
            if (pl.guildName && pl.guildName.toLowerCase() === guildName.toLowerCase()) {
                io.to(sId).emit('guild_kraken_raid_started', {
                    guildName,
                    leaderName: leaderName || (guild ? guild.leader : 'Lonca Lideri')
                });
                if (guild) io.to(sId).emit('guild_data_updated', guild);
            }
        }
    });

    socket.on('guild_end_kraken_raid', async (data) => {
        const { guildName } = data || {};
        if (!guildName) return;
        const guild = await DB.getGuild(guildName);
        if (guild) {
            guild.krakenActive = false;
            await DB.saveGuild(guildName, guild);
        }
        for (const [sId, pl] of Object.entries(onlinePlayers)) {
            if (pl.guildName && pl.guildName.toLowerCase() === guildName.toLowerCase()) {
                io.to(sId).emit('guild_kraken_raid_ended', { guildName });
                if (guild) io.to(sId).emit('guild_data_updated', guild);
            }
        }
    });

    // 3. Harita Değiştirme (Işınlanma)
    socket.on('player_change_map', (data) => {
        const p = onlinePlayers[socket.id];
        if (!p) return;

        const oldMap = p.mapId;
        const newMap = (data.newMapId === 'burnaz' || !data.newMapId) ? 'burnaz_sahil' : data.newMapId;

        socket.leave(`map_${oldMap}`);
        socket.to(`map_${oldMap}`).emit('player_left', socket.id);

        p.mapId = newMap;
        p.x = Number(data.x) || 13.5;
        p.y = Number(data.y) || 11.5;

        socket.join(`map_${newMap}`);

        const newPeers = Object.values(onlinePlayers).filter(pl => pl.mapId === newMap && pl.socketId !== socket.id);
        socket.emit('map_peers', newPeers);
        socket.to(`map_${newMap}`).emit('player_joined', p);
    });

    // 4. Balık Tutma / Olta Atma Efekti
    socket.on('player_fishing', (data) => {
        const p = onlinePlayers[socket.id];
        if (!p) return;
        p.isFishing = Boolean(data.isFishing);
        socket.to(`map_${p.mapId}`).emit('player_fishing_state', {
            socketId: socket.id,
            isFishing: p.isFishing,
            waterX: data.waterX,
            waterY: data.waterY
        });
    });

    // 5. Canlı Sohbet (Chat) Yayını
    socket.on('chat_send', (data) => {
        const p = onlinePlayers[socket.id];
        if (!p) return;

        const msgData = {
            sender: p.name,
            level: p.level,
            role: p.role,
            text: (data.text || '').slice(0, 150),
            channel: data.channel || 'all',
            mapId: p.mapId,
            time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
        };

        if (data.channel === 'map') {
            io.to(`map_${p.mapId}`).emit('chat_broadcast', msgData);
        } else {
            io.emit('chat_broadcast', msgData);
        }
    });

    // 6. Bağlantı Koptu
    // 5.5 Canlı GM / Oyun Ayarları Senkronizasyonu (Kraken Zamanı, Droplar, Kurallar)
    socket.on('admin_update_game_config', async (data) => {
        const p = onlinePlayers[socket.id];
        const isAuthorized = p && (p.role === 'admin' || (p.name && p.name.toLowerCase() === 'burak'));
        if (!isAuthorized) return;

        const { config } = data || {};
        if (!config) return;

        await DB.saveGlobalConfig(config);
        // Tüm sunucuya canlı dağıt
        io.emit('game_config_sync', config);
    });

    socket.on('admin_reset_game_config', async () => {
        const p = onlinePlayers[socket.id];
        const isAuthorized = p && (p.role === 'admin' || (p.name && p.name.toLowerCase() === 'burak'));
        if (!isAuthorized) return;

        await DB.saveGlobalConfig(null);
        io.emit('game_config_reset');
    });

    socket.on('disconnect', () => {
        const p = onlinePlayers[socket.id];
        if (p) {
            socket.to(`map_${p.mapId}`).emit('player_left', socket.id);
            delete onlinePlayers[socket.id];
            io.emit('online_count', Object.keys(onlinePlayers).length);
        }
    });
});

// Sunucuyu Başlat
initDatabase().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`====================================================`);
        console.log(`🚀 Burnaz Sahil & Dörtyol MMO Sunucusu Hazır!`);
        console.log(`📡 Port: ${PORT}`);
        console.log(`👑 Yönetici Hesabı: ${ADMIN_USERNAME}`);
        console.log(`🌐 URL: http://localhost:${PORT}`);
        console.log(`====================================================`);
    });
});

// Güvenli Kapatma (Railway & Docker SIGTERM / SIGINT Uyumlu)
function gracefulShutdown(signal) {
    console.log(`🛑 ${signal} sinyali alındı. Sunucu güvenli bir şekilde kapatılıyor...`);
    saveJsonDb(true);
    server.close(() => {
        console.log('✅ HTTP ve Socket sunucusu kapatıldı.');
        process.exit(0);
    });
    setTimeout(() => {
        console.warn('⚠️ Sunucu zorla kapatıldı (zaman aşımı).');
        process.exit(0);
    }, 4000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('🔥 Yakalanmamış İstisna (uncaughtException):', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('🔥 İşlenmemiş Promise Reddi (unhandledRejection):', reason);
});
