// create_user.js
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function createUser() {
    const [username, password] = process.argv.slice(2);
    if (!username || !password) {
        console.error("Uso: node create_user.js <username> <password>");
        process.exit(1);
    }
    try {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        await pool.query(
            'INSERT INTO impressao_users (username, password_hash) VALUES ($1, $2)',
            [username, passwordHash]
        );
        console.log(`✅ Usuário '${username}' criado com sucesso!`);
    } catch (err) {
        if (err.code === '23505') {
            console.error(`❌ ERRO: O usuário '${username}' já existe.`);
        } else {
            console.error("❌ ERRO ao criar usuário:", err);
        }
    } finally {
        await pool.end();
    }
}
createUser();