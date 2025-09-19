// index.js (VERSÃO CORRIGIDA E FINAL)

// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// --- VALIDAÇÃO DAS VARIÁVEIS DE AMBIENTE ---
const requiredEnv = ['PORT', 'DATABASE_URL', 'JWT_SECRET', 'API_KEY_N8N'];
for (const env of requiredEnv) {
    if (!process.env[env]) {
        console.error(`ERRO FATAL: A variável de ambiente '${env}' não está definida.`);
        process.exit(1);
    }
}

// --- CONFIGURAÇÃO DA APLICAÇÃO ---
const app = express();
const PORT = process.env.PORT;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(bodyParser.json());

// --- MIDDLEWARES DE AUTENTICAÇÃO ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

function authenticateN8N(req, res, next) {
    const providedKey = req.headers['x-api-key'];
    if (providedKey && providedKey === process.env.API_KEY_N8N) {
        next();
    } else {
        res.status(401).json({ message: "Chave de API inválida ou ausente." });
    }
}

// --- ROTAS DA API ---

// ROTA RAIZ: Para verificar se a API está online
app.get('/', (req, res) => {
    res.json({
        status: "online",
        message: "API de Fila de Impressão está operacional.",
        timestamp: new Date().toISOString()
    });
});

// ROTA DE LOGIN: O agente desktop usa para obter um token de acesso
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Usuário e senha são obrigatórios." });
    }
    try {
        const result = await pool.query('SELECT * FROM impressao_users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ message: "Credenciais inválidas." });

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ message: "Credenciais inválidas." });
        
        const token = jwt.sign({ username: user.username, userId: user.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: "Login bem-sucedido!", token });
    } catch (err) {
        console.error("Erro no /login:", err);
        res.status(500).json({ message: "Erro interno do servidor." });
    }
});

// ROTA PARA N8N: Adiciona um novo trabalho à fila de impressão
app.post('/jobs/new', authenticateN8N, async (req, res) => {
    const job_data  = req.body; // Aceita o corpo inteiro como job_data
    if (!job_data || typeof job_data !== 'object') {
        return res.status(400).json({ message: "O corpo da requisição deve ser um objeto JSON." });
    }
    try {
        const result = await pool.query(
            'INSERT INTO impressao_fila (job_data, status) VALUES ($1, $2) RETURNING id',
            [job_data, 'pending']
        );
        res.status(201).json({ message: "Trabalho adicionado à fila.", jobId: result.rows[0].id });
    } catch (err) {
        console.error("Erro no /jobs/new:", err);
        res.status(500).json({ message: "Erro interno do servidor." });
    }
});

// ROTA PARA AGENTE DESKTOP: Busca o próximo trabalho disponível na fila
app.get('/jobs/next', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const query = `
            SELECT * FROM impressao_fila
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `;
        const result = await client.query(query);

        if (result.rows.length === 0) {
            await client.query('COMMIT');
            return res.status(204).send(); // Fila vazia
        }
        
        const jobId = result.rows[0].id;
        const updateResult = await client.query(
            "UPDATE impressao_fila SET status = 'processing' WHERE id = $1 RETURNING *",
            [jobId]
        );
        
        await client.query('COMMIT');
        res.json(updateResult.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Erro no /jobs/next:", err);
        res.status(500).json({ message: "Erro interno do servidor." });
    } finally {
        client.release();
    }
});

// ROTA PARA AGENTE DESKTOP: Confirma que um trabalho foi concluído
app.post('/jobs/:id/complete', authenticateToken, async (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    try {
        // ATUALIZA o status para 'completed' e registra a data/hora.
        const result = await pool.query(
            "UPDATE impressao_fila SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status = 'processing'",
            [jobId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Trabalho não encontrado ou em estado inválido." });
        }
        res.status(200).json({ message: `Trabalho ${jobId} marcado como concluído.` });
    } catch (err) {
        console.error(`Erro no /jobs/${jobId}/complete:`, err);
        res.status(500).json({ message: "Erro interno do servidor." });
    }
});

// ROTA PARA AGENTE DESKTOP: Busca o histórico dos últimos 100 pedidos impressos
app.get('/jobs/history', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, job_data, completed_at FROM impressao_fila 
             WHERE status = 'completed' 
             ORDER BY completed_at DESC 
             LIMIT 100`
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Erro no /jobs/history:", err);
        res.status(500).json({ message: "Erro interno do servidor." });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API de Impressão rodando na porta ${PORT}`);
});