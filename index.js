// index.js (VERSÃO FINAL E COMPLETA - Log Geral e Reimpressão)

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
        if (err || !user.unitNumber) {
            return res.sendStatus(403);
        }
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
app.get('/', (req, res) => {
    res.json({ status: "online", version: "final", message: "API de Fila de Impressão está operacional." });
});

// ROTA DE LOGIN
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) { return res.status(400).json({ message: "Usuário e senha são obrigatórios." }); }
    try {
        const result = await pool.query('SELECT * FROM impressao_users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ message: "Credenciais inválidas." });
        
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ message: "Credenciais inválidas." });
        
        const tokenPayload = { username: user.username, userId: user.id, unitNumber: user.unit_number };
        const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: "Login bem-sucedido!", token });
    } catch (err) { console.error("Erro no /login:", err); res.status(500).json({ message: "Erro interno do servidor." }); }
});

// ROTA PARA N8N CRIAR UM NOVO PEDIDO
app.post('/jobs/new', authenticateN8N, async (req, res) => {
    const { unit_number, ...job_data } = req.body;
    if (!unit_number || !job_data.pedido_id) {
        return res.status(400).json({ message: "Requisição inválida. 'unit_number' e 'pedido_id' são obrigatórios." });
    }
    try {
        await pool.query(
            'INSERT INTO impressao_fila (job_data, status, unit_number) VALUES ($1, $2, $3)',
            [job_data, 'pending', unit_number]
        );
        res.status(201).json({ message: "Trabalho adicionado à fila.", pedidoId: job_data.pedido_id });
    } catch (err) { console.error("Erro no /jobs/new:", err); res.status(500).json({ message: "Erro interno do servidor." }); }
});

// ROTA PARA O APP PYTHON BUSCAR O PRÓXIMO TRABALHO NA FILA
app.get('/jobs/next', authenticateToken, async (req, res) => {
    const { unitNumber } = req.user;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT * FROM impressao_fila WHERE status = 'pending' AND unit_number = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [unitNumber]
        );
        if (result.rows.length === 0) { await client.query('COMMIT'); return res.status(204).send(); }
        const job = result.rows[0];
        await client.query("UPDATE impressao_fila SET status = 'processing' WHERE id = $1", [job.id]);
        await client.query('COMMIT');
        res.json(job);
    } catch (err) { await client.query('ROLLBACK'); console.error("Erro no /jobs/next:", err); res.status(500).json({ message: "Erro interno do servidor." });
    } finally { client.release(); }
});

// ROTA PARA O APP PYTHON MARCAR UM PEDIDO COMO IMPRESSO
app.post('/jobs/:id/complete', authenticateToken, async (req, res) => {
    const { unitNumber } = req.user;
    const jobId = parseInt(req.params.id, 10);
    try {
        const result = await pool.query(
            "UPDATE impressao_fila SET status = 'completed', completed_at = NOW() WHERE id = $1 AND unit_number = $2 AND status = 'processing'",
            [jobId, unitNumber]
        );
        if (result.rowCount === 0) { return res.status(404).json({ message: "Trabalho não encontrado ou em estado inválido para esta unidade." }); }
        res.status(200).json({ message: `Trabalho ${jobId} marcado como concluído.` });
    } catch (err) { console.error(`Erro no /jobs/${jobId}/complete:`, err); res.status(500).json({ message: "Erro interno do servidor." }); }
});

// ***** ROTA ATUALIZADA *****
// ROTA PARA EXIBIR TODOS OS PEDIDOS DA UNIDADE (O LOG GERAL)
app.get('/jobs/history', authenticateToken, async (req, res) => {
    const { unitNumber } = req.user;
    try {
        const result = await pool.query(
            `SELECT id, job_data, status, created_at, completed_at FROM impressao_fila 
             WHERE unit_number = $1 
             ORDER BY created_at DESC 
             LIMIT 100`, // Mantemos um limite para não sobrecarregar
            [unitNumber]
        );
        res.status(200).json(result.rows);
    } catch (err) { console.error("Erro no /jobs/history:", err); res.status(500).json({ message: "Erro interno do servidor." }); }
});

// ***** NOVA ROTA PARA SUA FUTURA FUNCIONALIDADE *****
app.post('/jobs/:id/reprint', authenticateToken, async (req, res) => {
    const { unitNumber } = req.user;
    const jobId = parseInt(req.params.id, 10);
    try {
        // Criamos um novo pedido na fila, copiando os dados do antigo.
        // Isso preserva o histórico do pedido original.
        const originalJobResult = await pool.query("SELECT job_data FROM impressao_fila WHERE id = $1 AND unit_number = $2", [jobId, unitNumber]);
        if (originalJobResult.rows.length === 0) {
            return res.status(404).json({ message: "Pedido original não encontrado para esta unidade." });
        }
        const job_data = originalJobResult.rows[0].job_data;
        // Adiciona uma anotação de que é uma reimpressão
        job_data.reprint_of = jobId; 

        await pool.query(
            'INSERT INTO impressao_fila (job_data, status, unit_number) VALUES ($1, $2, $3)',
            [job_data, 'pending', unitNumber]
        );
        res.status(201).json({ message: `Pedido ${jobId} colocado na fila para reimpressão.` });
    } catch (err) {
        console.error(`Erro no /jobs/${jobId}/reprint:`, err);
        res.status(500).json({ message: "Erro interno do servidor." });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API de Impressão (Final - Log Geral) rodando na porta ${PORT}`);
});