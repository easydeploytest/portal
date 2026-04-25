import { opentelemetry } from '@elysiajs/opentelemetry'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { Elysia, t } from 'elysia'
import { staticPlugin } from '@elysiajs/static'
import { readFileSync } from 'fs'
import { join } from 'path'
import _sodium from 'libsodium-wrappers'

const ARGOCD_URL      = process.env.ARGOCD_URL      ?? 'https://argocd.easy-deploy.135.181.177.246.nip.io'
const ARGOCD_PASSWORD = process.env.ARGOCD_PASSWORD ?? ''
const CLUSTER_IP      = '135.181.177.246'
const INFISICAL_URL   = 'https://infisical.easy-deploy.135.181.177.246.nip.io'
const GRAFANA_URL     = 'https://shanzindlr.grafana.net'
const INFISICAL_ORG_ID = '058c91f2-63c4-4a9b-a58a-74855d18f167'
const GH_PAT          = process.env.GH_PAT ?? ''
const GH_ORG          = 'easydeploytest'
const TEMPLATE_REPO   = 'template'

type AppEnv = { health: string; sync: string }

// ── Notifications ────────────────────────────────────────────────────────────
export type Notification = {
  id:    string
  ts:    number
  title: string
  body:  string
  tags?: string[]
  links?: { label: string; url: string }[]
}

const MAX_STORED = 100
const notifications: Notification[] = []
const sseClients = new Set<ReadableStreamDefaultController>()

function pushNotification(n: Omit<Notification, 'id' | 'ts'>): Notification {
  const notif: Notification = { id: crypto.randomUUID(), ts: Date.now(), ...n }
  notifications.push(notif)
  if (notifications.length > MAX_STORED) notifications.shift()
  const payload = `data: ${JSON.stringify({ type: 'notification', notification: notif })}\n\n`
  const encoded = new TextEncoder().encode(payload)
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(encoded) } catch { sseClients.delete(ctrl) }
  }
  return notif
}

// ── ArgoCD ──────────────────────────────────────────────────────────────────
let argoToken: string | null = null

async function getArgoToken() {
  const res = await fetch(`${ARGOCD_URL}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ARGOCD_PASSWORD }),
  })
  const data = await res.json() as { token?: string }
  argoToken = data.token ?? null
  return argoToken
}

async function fetchApps() {
  if (!argoToken) await getArgoToken()
  const res = await fetch(`${ARGOCD_URL}/api/v1/applications`, {
    headers: { Authorization: `Bearer ${argoToken}` },
  })
  if (res.status === 401) { await getArgoToken(); return fetchApps() }
  const data = await res.json() as { items?: any[] }

  const byBase = new Map<string, { name: string; dev?: AppEnv; prod?: AppEnv }>()
  for (const item of data.items ?? []) {
    const match = (item.metadata.name as string).match(/^(.+)-(dev|prod)$/)
    if (!match) continue
    const [, base, env] = match
    if (!byBase.has(base)) byBase.set(base, { name: base })
    byBase.get(base)![env as 'dev' | 'prod'] = {
      health: item.status?.health?.status ?? 'Unknown',
      sync:   item.status?.sync?.status   ?? 'Unknown',
    }
  }

  return Array.from(byBase.values()).map(app => ({
    ...app,
    links: {
      dev:      `https://${app.name}-dev.easy-deploy.${CLUSTER_IP}.nip.io`,
      prod:     `https://${app.name}.easy-deploy.${CLUSTER_IP}.nip.io`,
      argocd:   `${ARGOCD_URL}/applications/${app.name}-dev`,
      grafana:  `${GRAFANA_URL}/d/easydeploy-${app.name}/${app.name}`,
      infisical: `${INFISICAL_URL}/organizations/${INFISICAL_ORG_ID}/projects/secret-management`,
    },
  }))
}

// ── GitHub helpers ───────────────────────────────────────────────────────────
const ghHeaders = () => ({
  'Authorization': `token ${GH_PAT}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
})

async function encryptSecret(plaintext: string, repoFullName: string) {
  await _sodium.ready
  const sodium = _sodium
  const { key_id, key } = await fetch(
    `https://api.github.com/repos/${repoFullName}/actions/secrets/public-key`,
    { headers: ghHeaders() }
  ).then(r => r.json()) as { key_id: string; key: string }

  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL)
  const binMsg = sodium.from_string(plaintext)
  const enc    = sodium.crypto_box_seal(binMsg, binKey)
  return { key_id, encrypted_value: sodium.to_base64(enc, sodium.base64_variants.ORIGINAL) }
}

// ── SSE helper ───────────────────────────────────────────────────────────────
function sseStream(handler: (send: (event: object) => void) => Promise<void>) {
  const encoder = new TextEncoder()
  const stream  = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        await handler(send)
      } catch (e) {
        send({ error: String(e) })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

// ── App ──────────────────────────────────────────────────────────────────────
const html = readFileSync(join(import.meta.dir, 'index.html'), 'utf8')

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector-opentelemetry-collector.easy-deploy.svc.cluster.local:4318'

new Elysia()
  .use(opentelemetry({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'portal',
    traceExporter: new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${OTLP_ENDPOINT}/v1/metrics` }),
      exportIntervalMillis: 10000,
    }),
    checkIfShouldTrace: (req) => {
      const url = new URL(req.url)
      return !['/healthz', '/health', '/readyz', '/livez'].includes(url.pathname)
    },
  }))
  .use(staticPlugin({ assets: 'public', prefix: '/public' }))
  .get('/', () => new Response(html, { headers: { 'Content-Type': 'text/html' } }))
  .get('/healthz', () => ({ status: 'ok' }))

  // Live notification stream — frontend subscribes once on load
  .get('/api/events', () => {
    const encoder = new TextEncoder()
    let ctrl: ReadableStreamDefaultController
    const stream = new ReadableStream({
      start(controller) {
        ctrl = controller
        sseClients.add(ctrl)
        // send recent notifications on connect so the page catches up
        const catchup = JSON.stringify({ type: 'catchup', notifications: notifications.slice(-20) })
        ctrl.enqueue(encoder.encode(`data: ${catchup}\n\n`))
      },
      cancel() {
        sseClients.delete(ctrl)
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  })

  // Receive a notification (called by EasyDeploy workflows or any tooling)
  .post('/api/notify',
    ({ body }) => {
      const { title, body: text, tags, links } = body as any
      const n = pushNotification({ title, body: text, tags, links })
      return { ok: true, id: n.id }
    },
    {
      body: t.Object({
        title: t.String(),
        body:  t.String(),
        tags:  t.Optional(t.Array(t.String())),
        links: t.Optional(t.Array(t.Object({ label: t.String(), url: t.String() }))),
      })
    }
  )

  // Recent notifications (REST fallback)
  .get('/api/notifications', () => notifications.slice().reverse())

  // List deployed apps from ArgoCD
  .get('/api/apps', async () => {
    try { return await fetchApps() }
    catch (e) { return { error: String(e) } }
  })

  /**
   * POST /api/create-app
   *
   * Creates a new app from the EasyDeploy template and triggers the first deploy.
   * Returns an SSE stream so callers (humans, AI agents, curl) see live progress.
   *
   * Body: { name: string, team?: string, port?: number }
   *
   * Each SSE event: { step, message, status: "running"|"done"|"error" }
   * Final event:    { done: true, repo, dev_url, prod_url, actions_url }
   */
  .post('/api/create-app',
    ({ body }) => {
      const { name, team = 'easy-deploy', port = 3000 } = body as any

      if (!/^[a-z][a-z0-9-]{4,}$/.test(name))
        return new Response(
          JSON.stringify({ error: 'Name must be lowercase letters/numbers/hyphens, at least 5 chars, start with a letter' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )

      const repoFull = `${GH_ORG}/${name}`

      return sseStream(async (send) => {
        // ── Step 1: create repo from template ────────────────────────────────
        send({ step: 'create_repo', message: `Creating repository ${repoFull} from template…`, status: 'running' })

        const createRes = await fetch(
          `https://api.github.com/repos/${GH_ORG}/${TEMPLATE_REPO}/generate`,
          {
            method: 'POST',
            headers: { ...ghHeaders(), 'Accept': 'application/vnd.github.baptiste-preview+json' },
            body: JSON.stringify({ owner: GH_ORG, name, private: false, description: `EasyDeploy app — ${name}` }),
          }
        )
        if (!createRes.ok) {
          const err = await createRes.json() as any
          throw new Error(err.errors?.[0]?.message ?? err.message ?? 'Failed to create repo')
        }
        send({ step: 'create_repo', message: `Repository https://github.com/${repoFull} created`, status: 'done' })

        // ── Step 2: wait for GitHub to initialise the repo ───────────────────
        send({ step: 'wait_init', message: 'Waiting for repo to initialise…', status: 'running' })
        await Bun.sleep(4000)
        send({ step: 'wait_init', message: 'Repo ready', status: 'done' })

        // ── Step 3: update app.yaml ──────────────────────────────────────────
        send({ step: 'configure', message: `Writing app.yaml (name=${name}, team=${team}, port=${port})…`, status: 'running' })

        const fileRes  = await fetch(`https://api.github.com/repos/${repoFull}/contents/app.yaml`, { headers: ghHeaders() })
        const fileData = await fileRes.json() as { sha: string }
        const newYaml  = `name: ${name}\nteam: ${team}\nport: ${port}\n`

        await fetch(`https://api.github.com/repos/${repoFull}/contents/app.yaml`, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify({
            message: 'feat: configure app',
            content: Buffer.from(newYaml).toString('base64'),
            sha: fileData.sha,
          }),
        })
        send({ step: 'configure', message: 'app.yaml committed — deploy workflow triggered', status: 'done' })

        // ── Step 4: set GH_PAT secret on new repo ───────────────────────────
        send({ step: 'set_secret', message: 'Provisioning GH_PAT secret on repo…', status: 'running' })

        const secretPayload = await encryptSecret(GH_PAT, repoFull)
        await fetch(`https://api.github.com/repos/${repoFull}/actions/secrets/GH_PAT`, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify(secretPayload),
        })
        send({ step: 'set_secret', message: 'GH_PAT secret set — repo is fully autonomous', status: 'done' })

        // ── Done ─────────────────────────────────────────────────────────────
        const result = {
          done: true,
          repo:        `https://github.com/${repoFull}`,
          actions_url: `https://github.com/${repoFull}/actions`,
          dev_url:     `https://${name}-dev.easy-deploy.${CLUSTER_IP}.nip.io`,
          prod_url:    `https://${name}.easy-deploy.${CLUSTER_IP}.nip.io`,
          argocd_url:  `${ARGOCD_URL}/applications/${name}-dev`,
          grafana_url: `${GRAFANA_URL}/d/easydeploy-${name}/${name}`,
        }
        send(result)

        // also push a portal notification so other browser tabs see it
        pushNotification({
          title: `${name} deployed`,
          body: `Dev: ${result.dev_url}`,
          tags: ['deploy', 'success'],
        })
      })
    },
    { body: t.Object({ name: t.String(), team: t.Optional(t.String()), port: t.Optional(t.Number()) }) }
  )

  .listen(3000, () => console.log('portal running on :3000'))
