#!/usr/bin/env node
/**
 * memoria-subscription-bridge — pont HTTP compatible OpenAI qui délègue à un
 * CLI d'agent déjà authentifié par ABONNEMENT (aucune clé API en plus).
 *
 * Par défaut : `claude -p` (abonnement Claude / Claude Code).
 * Alternative : mettre MEMORIA_BRIDGE_CMD sur un CLI ChatGPT (codex), etc.
 *
 * Memoria (provider=openai, base_url=http://127.0.0.1:<PORT>/v1) appelle
 * /chat/completions ; le pont concatène les messages, lance le CLI en headless,
 * et renvoie une réponse au format OpenAI (finish_reason:"stop").
 *
 * PoC 2026-09-03 : preuve qu'un abonnement peut servir de moteur d'extraction.
 * Limites connues : pas d'embeddings (le CLI ne vectorise pas → recherche
 * sémantique désactivée côté Memoria), démarrage à froid ~qq s par appel.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.MEMORIA_BRIDGE_PORT || 11435)
// Commande CLI : tableau JSON possible via MEMORIA_BRIDGE_CMD, sinon claude -p.
const CMD = process.env.MEMORIA_BRIDGE_CMD
  ? JSON.parse(process.env.MEMORIA_BRIDGE_CMD)
  : ['claude', '-p', '--output-format', 'text']
const TIMEOUT_MS = Number(process.env.MEMORIA_BRIDGE_TIMEOUT_MS || 120000)

function runCli(prompt) {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = CMD
    const child = spawn(bin, args, { shell: true })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('bridge: CLI timeout')) }, TIMEOUT_MS)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`bridge: CLI exit ${code}: ${err.slice(0, 300)}`))
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

// Certains CLIs entourent le JSON de ``` ; on récupère le bloc si présent.
function extractMaybeJson(text, wantJson) {
  if (!wantJson) return text.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const braced = text.match(/[{[][\s\S]*[}\]]/)
  return (braced ? braced[0] : text).trim()
}

function messagesToPrompt(messages) {
  return messages.map(m => {
    if (m.role === 'system') return `# Instructions\n${m.content}`
    if (m.role === 'assistant') return `# Assistant précédent\n${m.content}`
    return m.content
  }).join('\n\n')
}

const server = http.createServer((req, res) => {
  const path = (req.url || '').replace(/\/+$/, '')
  if (req.method === 'POST' && path.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const messages = payload.messages || []
        const wantJson = payload.response_format && payload.response_format.type === 'json_object'
        const prompt = messagesToPrompt(messages)
        const raw = await runCli(prompt)
        const content = extractMaybeJson(raw, wantJson)
        if (!content) throw new Error('bridge: réponse CLI vide')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-bridge', object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: payload.model || 'subscription-bridge',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(e && e.message || e) } }))
      }
    })
  } else if (req.method === 'GET' && path.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'subscription-bridge', object: 'model' }] }))
  } else {
    res.writeHead(404); res.end('not found')
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`memoria-subscription-bridge on http://127.0.0.1:${PORT} via ${CMD.join(' ')}`))
