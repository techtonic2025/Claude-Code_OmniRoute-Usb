import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = join(ROOT_DIR, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'openclaude', 'settings.json');
const CHATS_DIR = join(DATA_DIR, 'chats');
const HTML_FILE = join(__dirname, 'index.html');
const PORT = 3000;
let WORK_DIR = ROOT_DIR;

function readConfig() {
    if (existsSync(SETTINGS_FILE)) {
        try {
            const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
            const cfg = { AI_PROVIDER: 'anthropic', AI_DISPLAY_MODEL: settings.model || 'auto' };
            if (settings.env) {
                if (settings.env.ANTHROPIC_BASE_URL) {
                    cfg.ANTHROPIC_BASE_URL = settings.env.ANTHROPIC_BASE_URL;
                    if (settings.env.ANTHROPIC_BASE_URL.includes('localhost:20128')) {
                        cfg.OPENAI_BASE_URL = settings.env.ANTHROPIC_BASE_URL;
                        cfg.OPENAI_API_KEY = settings.env.ANTHROPIC_AUTH_TOKEN || 'not-needed';
                        cfg.OPENAI_MODEL = settings.env.ANTHROPIC_MODEL || settings.model || 'auto';
                        cfg.AI_PROVIDER = 'openai';
                    }
                }
                if (settings.env.ANTHROPIC_API_KEY) cfg.ANTHROPIC_API_KEY = settings.env.ANTHROPIC_API_KEY;
                if (settings.env.ANTHROPIC_AUTH_TOKEN) cfg.ANTHROPIC_AUTH_TOKEN = settings.env.ANTHROPIC_AUTH_TOKEN;
                if (settings.env.ANTHROPIC_MODEL) cfg.ANTHROPIC_MODEL = settings.env.ANTHROPIC_MODEL;
            }
            return cfg;
        } catch (e) { console.error('Config error:', e.message); }
    }
    return {};
}

function writeConfig(config) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const configDir = join(DATA_DIR, 'openclaude');
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    const settings = {
        model: config.AI_DISPLAY_MODEL || config.OPENAI_MODEL || 'auto',
        env: {}
    };
    if (config.ANTHROPIC_BASE_URL) settings.env.ANTHROPIC_BASE_URL = config.ANTHROPIC_BASE_URL;
    else if (config.OPENAI_BASE_URL && !config.OPENAI_BASE_URL.includes('api.openai.com')) settings.env.ANTHROPIC_BASE_URL = config.OPENAI_BASE_URL.replace(/\/v1\/?$/, '');
    if (config.ANTHROPIC_AUTH_TOKEN) settings.env.ANTHROPIC_AUTH_TOKEN = config.ANTHROPIC_AUTH_TOKEN;
    else if (config.OPENAI_API_KEY) settings.env.ANTHROPIC_AUTH_TOKEN = config.OPENAI_API_KEY;
    if (config.ANTHROPIC_API_KEY) settings.env.ANTHROPIC_API_KEY = config.ANTHROPIC_API_KEY;
    if (config.ANTHROPIC_MODEL) settings.env.ANTHROPIC_MODEL = config.ANTHROPIC_MODEL;
    else if (config.OPENAI_MODEL) settings.env.ANTHROPIC_MODEL = config.OPENAI_MODEL;
    if (config.ANTHROPIC_BASE_URL && config.ANTHROPIC_BASE_URL.includes('localhost:20128')) {
        settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
    }
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    });
}

async function fetchExternal(url, headers = {}, body = null, method = 'GET') {
    const mod = await import(url.startsWith('https') ? 'https' : 'http');
    return new Promise((resolve, reject) => {
        const opts = { method, headers };
        const req = mod.request(url, opts, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

async function streamExternal(url, headers, body, onChunk, onEnd) {
    const mod = await import(url.startsWith('https') ? 'https' : 'http');
    return new Promise((resolve, reject) => {
        const req = mod.request(url, { method: 'POST', headers }, res => {
            res.on('data', chunk => onChunk(chunk.toString()));
            res.on('end', () => { onEnd(); resolve(); });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

function sendJSON(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
}

// Chat History
function ensureChatsDir() { if (!existsSync(CHATS_DIR)) mkdirSync(CHATS_DIR, { recursive: true }); }

function listChats() {
    ensureChatsDir();
    return readdirSync(CHATS_DIR).filter(f => f.endsWith('.json')).map(f => {
        try {
            const data = JSON.parse(readFileSync(join(CHATS_DIR, f), 'utf-8'));
            return { id: f.replace('.json', ''), title: data.title || 'Untitled', created: data.created, updated: data.updated, messageCount: (data.messages || []).length };
        } catch { return null; }
    }).filter(Boolean).sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

function loadChat(id) {
    const file = join(CHATS_DIR, `${id}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8'));
}

function saveChat(id, data) {
    ensureChatsDir();
    writeFileSync(join(CHATS_DIR, `${id}.json`), JSON.stringify(data, null, 2), 'utf-8');
}

function newChatId() { return `chat_${Date.now()}`; }

// Chat streaming
async function streamChatResponse(messages, cfg, res) {
    const provider = cfg.AI_PROVIDER;
    const model = cfg.OPENAI_MODEL || cfg.AI_DISPLAY_MODEL || 'auto';
    const baseUrl = cfg.OPENAI_BASE_URL || 'http://localhost:20128/v1';
    const apiKey = cfg.OPENAI_API_KEY || cfg.ANTHROPIC_AUTH_TOKEN || 'not-needed';

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    if (provider === 'openai' || provider === 'anthropic') {
        const body = JSON.stringify({ model, messages, stream: true });
        const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
        let fullText = '';
        await streamExternal(`${baseUrl}/chat/completions`, headers, body,
            (chunk) => {
                chunk.split('\n').forEach(line => {
                    if (!line.startsWith('data: ')) return;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') return;
                    try {
                        const delta = JSON.parse(raw).choices?.[0]?.delta?.content || '';
                        if (delta) { fullText += delta; sendSSE({ type: 'delta', content: delta }); }
                    } catch {}
                });
            },
            () => { sendSSE({ type: 'done', fullText }); res.end(); }
        );
        return fullText;
    }

    sendSSE({ type: 'error', content: 'Provider not supported' });
    res.end();
    return '';
}

// Server
const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
    }
    try {
        if (url.pathname === '/' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(readFileSync(HTML_FILE, 'utf-8'));
        }
        if (url.pathname === '/api/config' && req.method === 'GET') return sendJSON(res, 200, readConfig());
        if (url.pathname === '/api/config' && req.method === 'POST') { const b = await readBody(req); writeConfig(b); return sendJSON(res, 200, { success: true }); }

        if (url.pathname === '/api/chats' && req.method === 'GET') return sendJSON(res, 200, { chats: listChats() });
        if (url.pathname === '/api/chats' && req.method === 'POST') {
            const { title } = await readBody(req);
            const id = newChatId();
            const now = new Date().toISOString();
            saveChat(id, { id, title: title || 'Nuova conversazione', created: now, updated: now, messages: [] });
            return sendJSON(res, 200, { id });
        }

        const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
        if (chatMatch) {
            const chatId = chatMatch[1];
            if (req.method === 'GET') { const chat = loadChat(chatId); return chat ? sendJSON(res, 200, chat) : sendJSON(res, 404, { error: 'Not found' }); }
            if (req.method === 'DELETE') { const f = join(CHATS_DIR, `${chatId}.json`); if (existsSync(f)) unlinkSync(f); return sendJSON(res, 200, { success: true }); }
            if (req.method === 'POST') { const data = await readBody(req); saveChat(chatId, data); return sendJSON(res, 200, { success: true }); }
        }

        if (url.pathname === '/api/chat' && req.method === 'POST') {
            const { chatId, messages, userMessage } = await readBody(req);
            const cfg = readConfig();
            if (!cfg.AI_PROVIDER) { sendJSON(res, 400, { error: 'No provider configured' }); return; }
            const history = messages || [];
            const allMessages = [...history, { role: 'user', content: userMessage }];
            const fullText = await streamChatResponse(allMessages, cfg, res);
            if (chatId && fullText) {
                const existing = loadChat(chatId) || { id: chatId, title: userMessage.slice(0, 50), created: new Date().toISOString(), messages: [] };
                existing.messages.push({ role: 'user', content: userMessage }, { role: 'assistant', content: fullText });
                existing.updated = new Date().toISOString();
                if (!existing.title || existing.title === 'Nuova conversazione') existing.title = userMessage.slice(0, 50);
                saveChat(chatId, existing);
            }
            return;
        }

        sendJSON(res, 404, { error: 'Not found' });
    } catch (err) {
        console.error(err);
        try { sendJSON(res, 500, { error: err.message }); } catch {}
    }
});

server.listen(PORT, () => {
    console.log(`\n  Dashboard: http://localhost:${PORT}\n  Cartella: ${WORK_DIR}\n`);
});
