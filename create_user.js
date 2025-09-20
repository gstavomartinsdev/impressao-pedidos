// create_user.js (VERSÃO 2.0 - com unit_number)
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function createUser() {
    const [username, password, unitNumber] = process.argv.slice(2);
    if (!username || !password || !unitNumber) {
        console.error("Uso: node create_user.js <username> <password> <unit_number>");
        process.exit(1);
    }
    const unitId = parseInt(unitNumber, 10);
    if (isNaN(unitId)) {
        console.error("ERRO: O número da unidade deve ser um número inteiro.");
        process.exit(1);
    }
    try {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        await pool.query(
            'INSERT INTO impressao_users (username, password_hash, unit_number) VALUES ($1, $2, $3)',
            [username, passwordHash, unitId]
        );
        console.log(`✅ Usuário '${username}' criado para a unidade ${unitId} com sucesso!`);
    } catch (err) {
        if (err.code === '23505') { console.error(`❌ ERRO: O usuário '${username}' já existe.`); } 
        else { console.error("❌ ERRO ao criar usuário:", err); }
    } finally {
        await pool.end();
    }
}
createUser();